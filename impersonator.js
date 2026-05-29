// Agent Safe Server - 高级出口伪装代理 (Bun 极致伪装版)
// 功能：保留原始 Header 大小写与顺序、镜像凭据方案前缀、极致性能转发

const http = require('http');
const https = require('https');
const converter = require('./converter');

// --- 1. 配置加载 ---
const LISTEN_HOST = process.env.LISTEN_HOST || '127.0.0.1';
const LISTEN_PORT = process.env.LISTEN_PORT || 80;
const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB
const LOG_MODEL_MAPPING = process.env.LOG_MODEL_MAPPING !== 'false';
const LOG_PROTOCOL_CONVERT = process.env.LOG_PROTOCOL_CONVERT !== 'false';
const LOG_RATE_LIMIT = process.env.LOG_RATE_LIMIT !== 'false';
let BACKENDS = {};
let ENDPOINTS = [];

try {
    BACKENDS = JSON.parse(process.env.BACKENDS || '{}');
    ENDPOINTS = JSON.parse(process.env.ENDPOINTS || '[]');
} catch (e) {
    console.error(`[${new Date().toISOString()}] 配置文件解析失败: ${e.message}`);
    process.exit(1);
}

// 设置默认 protocol
Object.keys(BACKENDS).forEach(id => {
    BACKENDS[id].protocol = BACKENDS[id].protocol || 'openai';
});
ENDPOINTS.forEach(ep => {
    ep.protocol = ep.protocol || 'openai';
});

// 预编译正则 & 解析后端URL
ENDPOINTS.forEach(ep => {
    if (ep.mappings) {
        ep.mappings.forEach(m => {
            m.regex = new RegExp(m.pattern);
        });
    }
});

// 解析后端target为结构化配置
Object.keys(BACKENDS).forEach(id => {
    const backend = BACKENDS[id];
    let targetUrl = backend.target;
    
    // 如果target不包含协议，默认添加https://
    if (!targetUrl.match(/^https?:\/\//)) {
        targetUrl = 'https://' + targetUrl;
    }
    
    try {
        const parsed = new URL(targetUrl);
        backend._protocol = parsed.protocol; // 'http:' or 'https:'
        backend._hostname = parsed.hostname;
        backend._port = parsed.port || (parsed.protocol === 'https:' ? 443 : 80);
        backend._basePath = parsed.pathname.replace(/\/$/, ''); // 移除末尾斜杠
    } catch (e) {
        console.error(`[${new Date().toISOString()}] 后端URL解析失败 [${id}]: ${backend.target}`);
        process.exit(1);
    }
});

/**
 * 读取请求体并限制大小
 */
async function readBody(req) {
    return new Promise((resolve, reject) => {
        let body = [];
        let currentSize = 0;
        req.on('data', chunk => { 
            currentSize += chunk.length;
            if (currentSize > MAX_BODY_SIZE) {
                reject(new Error('Payload too large'));
                return;
            }
            body.push(chunk); 
        });
        req.on('end', () => resolve(Buffer.concat(body)));
        req.on('error', reject);
    });
}

function resolveMapping(endpoint, modelName) {
    if (!endpoint.mappings || !modelName) return null;
    for (const m of endpoint.mappings) {
        if (m.regex.test(modelName)) return m;
    }
    return null;
}

// --- 2. 核心服务逻辑 ---
const server = http.createServer(async (req, res) => {
    let needsConversion = false;
    let anthropicInputTokens = 0;
    let bodyJson = null;
    const logPrefix = `[${new Date().toISOString()}] [${req.socket.remoteAddress}]`;
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    // [A] 构建出口 Header 并保留原始大小写与顺序
    const hopByHop = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host'];
    const outboundHeaders = {};
    let clientAuthPrefix = "Bearer"; // 默认为标准大写
    let authHeaderKey = "Authorization"; // 默认标准大小写

    // 遍历 rawHeaders (格式为 [key, val, key, val...])
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const key = req.rawHeaders[i];
        const val = req.rawHeaders[i+1];
        const lowerKey = key.toLowerCase();

        if (hopByHop.includes(lowerKey)) continue;

        // 记录原始的认证 Header 键名和方案前缀 (如 Bearer/bearer)
        if (lowerKey === 'authorization') {
            authHeaderKey = key;
            const match = val.match(/^(\S+)\s+/);
            if (match) clientAuthPrefix = match[1];
        }
        
        outboundHeaders[key] = val;
    }

    // [B] 多租户匹配逻辑 (Path + Key)
    const authHeader = req.headers['authorization'];
    const apiKeyHeader = req.headers['x-api-key'];

    const endpoint = ENDPOINTS.find(ep => {
        if (!pathname.startsWith(ep.path)) return false;
        // 端点无认证配置时，仅按路径匹配（透传模式）
        if (!ep.inboundBearer && !ep.inboundApiKey) return true;
        if (ep.inboundBearer && authHeader) {
            const parts = authHeader.split(/\s+/);
            if (parts.length === 2 && parts[0].toLowerCase() === "bearer" && parts[1] === ep.inboundBearer) return true;
        }
        if (ep.inboundApiKey && apiKeyHeader === ep.inboundApiKey) return true;
        return false;
    });

    if (!endpoint) {
        const pathExists = ENDPOINTS.some(ep => pathname.startsWith(ep.path));
        res.writeHead(pathExists ? 401 : 404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: pathExists ? "Unauthorized" : "Endpoint not found" }));
        return;
    }

    // [C] 模型识别与替换
    let targetBackendId = endpoint.default_backend;
    let bodyData = null;
    let detectedModel = req.headers['x-model-id'] || req.headers['x-model-name'];

    if (req.method === 'POST' && req.headers['content-type']?.includes('application/json')) {
        try {
            const rawBody = await readBody(req);
            bodyJson = JSON.parse(rawBody.toString('utf8'));
            if (!detectedModel) detectedModel = bodyJson.model;

            const mapping = resolveMapping(endpoint, detectedModel);
            if (mapping) {
                targetBackendId = mapping.target_backend;
                if (mapping.target_model) {
                    if (LOG_MODEL_MAPPING) console.log(`${logPrefix} 模型映射: ${detectedModel} -> ${mapping.target_model}, 入口: ${endpoint.path}, 后端: ${targetBackendId}`);
                    if (bodyJson.model) bodyJson.model = mapping.target_model;
                }
            }

            bodyData = bodyJson ? JSON.stringify(bodyJson) : null;
        } catch (e) {
            if (e.message === 'Payload too large') {
                res.writeHead(413, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: "Payload too large" }));
            } else {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: "Invalid JSON body" }));
            }
            return;
        }
    } else if (!detectedModel) {
        const parts = pathname.split('/').filter(Boolean);
        detectedModel = parts[parts.length - 1];
    }

    const backendConfig = BACKENDS[targetBackendId];
    if (!backendConfig) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "Backend not configured" }));
        return;
    }

    // [C-2] 协议转换
    needsConversion = endpoint.protocol === 'anthropic' && backendConfig.protocol === 'openai';

    if (needsConversion && bodyJson) {
        // 估算 input tokens
        anthropicInputTokens = Math.ceil(JSON.stringify(bodyJson.messages || []).length / 4);
        bodyJson = converter.convertAnthropicToOpenaiRequest(bodyJson);
        bodyData = JSON.stringify(bodyJson);
        if (LOG_PROTOCOL_CONVERT) console.log(`${logPrefix} 协议转换: Anthropic→OpenAI, 入口: ${endpoint.path}, 后端: ${targetBackendId}`);
    }

    // [D] 计算目标路径
    // endpoint.stripPathPrefix: 是否从请求路径中剥离endpoint.path前缀（默认false）
    let targetPath = pathname;
    if (endpoint.stripPathPrefix && endpoint.path && targetPath.startsWith(endpoint.path)) {
        targetPath = targetPath.slice(endpoint.path.length);
    }
    targetPath = backendConfig._basePath + targetPath;
    // [D-1] Anthropic 路径映射
    if (needsConversion) {
        targetPath = targetPath.replace(/\/messages$/, '/chat/completions');
    }
    // 保留query string
    if (url.search) {
        targetPath += url.search;
    }

    // [E] 注入后端凭据并设置Host
    const backendKey = backendConfig.apiKey;
    if (backendKey) {
        // 后端配置了 apiKey，注入后端凭据
        if (authHeader) outboundHeaders[authHeaderKey] = `${clientAuthPrefix} ${backendKey}`;
        if (apiKeyHeader) {
            const originalKey = Object.keys(outboundHeaders).find(k => k.toLowerCase() === 'x-api-key') || 'x-api-key';
            outboundHeaders[originalKey] = backendKey;
        }
    }
    outboundHeaders['Host'] = backendConfig._hostname;

    // [E-2] 协议转换时的认证头处理
    if (needsConversion) {
        if (backendKey) {
            // 后端有配置 apiKey：x-api-key → Authorization: Bearer
            if (apiKeyHeader && !authHeader) {
                outboundHeaders['Authorization'] = `${clientAuthPrefix} ${backendKey}`;
                const xApiKey = Object.keys(outboundHeaders).find(k => k.toLowerCase() === 'x-api-key');
                if (xApiKey) delete outboundHeaders[xApiKey];
            }
        } else {
            // 透传模式：客户端凭据直接转发，x-api-key → Authorization: Bearer
            if (apiKeyHeader && !authHeader) {
                outboundHeaders['Authorization'] = `${clientAuthPrefix} ${apiKeyHeader}`;
                const xApiKey = Object.keys(outboundHeaders).find(k => k.toLowerCase() === 'x-api-key');
                if (xApiKey) delete outboundHeaders[xApiKey];
            }
        }
    }

    // 更新 Content-Length
    if (bodyData !== null) {
        outboundHeaders['Content-Length'] = Buffer.byteLength(bodyData);
    }

    // 协议转换时不请求压缩编码，避免需要解压
    if (needsConversion) {
        const aeKey = Object.keys(outboundHeaders).find(k => k.toLowerCase() === 'accept-encoding');
        if (aeKey) delete outboundHeaders[aeKey];
    }

    // [F] 发起转发（根据协议选择http/https）
    const requestLib = backendConfig._protocol === 'https:' ? https : http;
    const proxyReq = requestLib.request({
        hostname: backendConfig._hostname,
        port: backendConfig._port,
        path: targetPath,
        method: req.method,
        headers: outboundHeaders,
        timeout: 0,
        keepAlive: true
    }, (proxyRes) => {
        // 响应头清理
        const responseHeaders = { ...proxyRes.headers };
        const toRemove = ['server', 'x-powered-by', 'x-request-id', 'via', 'x-cache',
            'access-control-allow-origin', 'content-security-policy',
            'strict-transport-security', 'x-content-type-options'];
        toRemove.forEach(h => delete responseHeaders[h]);

        // [G] 429/529 限流/过载日志
        if (proxyRes.statusCode === 429 || proxyRes.statusCode === 529) {
            const maskToken = (t) => {
                if (!t) return '无';
                const s = t.replace(/^(?:Bearer\s+)?/i, '');
                if (s.length <= 8) return s.slice(0, 2) + '***';
                return s.slice(0, 4) + '***' + s.slice(-4);
            };
            const tokenInfo = maskToken(authHeader || apiKeyHeader);
            const retryAfter = proxyRes.headers['retry-after'];
            let retryInfo = '无';
            if (retryAfter) {
                const asNum = Number(retryAfter);
                if (!isNaN(asNum)) {
                    retryInfo = asNum >= 1 ? `${asNum}s` : `${Math.round(asNum * 1000)}ms`;
                } else {
                    const retryDate = new Date(retryAfter);
                    if (!isNaN(retryDate.getTime())) {
                        const diffMs = retryDate.getTime() - Date.now();
                        retryInfo = diffMs >= 1000 ? `${Math.round(diffMs / 1000)}s` : `${diffMs}ms`;
                    } else {
                        retryInfo = retryAfter;
                    }
                }
            }
            if (LOG_RATE_LIMIT) console.warn(`${logPrefix} 限流/过载: 后端返回 ${proxyRes.statusCode}, Retry-After: ${retryInfo}, 模型: ${detectedModel || 'unknown'}, 入口: ${endpoint.path}, 后端: ${targetBackendId}, Token: ${tokenInfo}`);
        }

        if (!needsConversion) {
            res.writeHead(proxyRes.statusCode, responseHeaders);
            proxyRes.pipe(res);
            return;
        }

        // 协议转换时移除编码相关头部（内容已被重新序列化）
        delete responseHeaders['content-encoding'];
        delete responseHeaders['transfer-encoding'];

        const isStreaming = bodyJson?.stream === true;

        if (isStreaming) {
            responseHeaders['content-type'] = 'text/event-stream';
            delete responseHeaders['content-length'];
            res.writeHead(proxyRes.statusCode, responseHeaders);
            res.socket.setNoDelay(true);
            const transformer = converter.createAnthropicStreamTransformer(
                detectedModel || 'unknown',
                anthropicInputTokens
            );
            proxyRes.pipe(transformer).pipe(res);
        } else {
            const chunks = [];
            proxyRes.on('data', chunk => chunks.push(chunk));
            proxyRes.on('end', () => {
                const rawBody = Buffer.concat(chunks).toString('utf8');
                try {
                    const openaiRes = JSON.parse(rawBody);
                    let responseStr;
                    // 错误状态码或响应体包含 error 字段 → 错误格式转换
                    if (proxyRes.statusCode >= 400 || openaiRes.error) {
                        responseStr = JSON.stringify(converter.convertOpenaiErrorToAnthropic(openaiRes, proxyRes.statusCode));
                    } else {
                        responseStr = JSON.stringify(converter.convertOpenaiToAnthropicResponse(openaiRes));
                    }
                    delete responseHeaders['content-length'];
                    responseHeaders['content-type'] = 'application/json';
                    res.writeHead(proxyRes.statusCode, responseHeaders);
                    res.end(responseStr);
                } catch {
                    res.writeHead(proxyRes.statusCode, responseHeaders);
                    res.end(rawBody);
                }
            });
        }
    });

    proxyReq.on('error', (e) => {
        console.error(`${logPrefix} 代理层异常: ${e.message}`);
        if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Proxy upstream error" }));
        }
    });

    if (bodyData !== null) {
        proxyReq.write(bodyData);
        proxyReq.end();
    } else {
        req.pipe(proxyReq);
    }
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
    console.log(`[${new Date().toISOString()}] Impersonator Proxy (Bun 极致伪装版) 启动成功`);
    console.log(`[监听地址] http://${LISTEN_HOST}:${LISTEN_PORT}`);
});
