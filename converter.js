// converter.js — Anthropic ↔ OpenAI protocol conversion
const { Transform } = require('stream');
const crypto = require('crypto');

/**
 * Convert a single Anthropic content block to OpenAI format.
 */
function convertContentBlock(block) {
    if (block.type === 'text') {
        return { type: 'text', text: block.text };
    }
    if (block.type === 'image') {
        const source = block.source;
        let url;
        if (source.type === 'base64') {
            url = `data:${source.media_type};base64,${source.data}`;
        } else if (source.type === 'url') {
            url = source.url;
        }
        return {
            type: 'image_url',
            image_url: { url, detail: 'auto' }
        };
    }
    return null;
}

/**
 * Convert user content (string or content blocks) to OpenAI format.
 */
function convertUserContent(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        const nonTool = content.filter(b => b.type !== 'tool_result');
        const converted = nonTool.map(convertContentBlock).filter(Boolean);
        // If the result is just a single text block, simplify to string
        if (converted.length === 1 && converted[0].type === 'text') {
            return converted[0].text;
        }
        return converted;
    }
    return content;
}

/**
 * Convert assistant content blocks to { text, tool_calls }.
 */
function convertAssistantContent(content) {
    if (typeof content === 'string') {
        return { text: content, tool_calls: undefined };
    }
    if (!Array.isArray(content)) {
        return { text: null, tool_calls: undefined };
    }

    const textParts = content.filter(b => b.type === 'text').map(b => b.text);
    const toolUseBlocks = content.filter(b => b.type === 'tool_use');
    // thinking blocks are simply ignored

    const text = textParts.length > 0 ? textParts.join('') : null;
    const tool_calls = toolUseBlocks.length > 0
        ? toolUseBlocks.map(b => ({
            id: b.id,
            type: 'function',
            function: {
                name: b.name,
                arguments: JSON.stringify(b.input)
            }
        }))
        : undefined;

    return { text, tool_calls };
}

/**
 * Extract text from tool_result content (string or content blocks).
 */
function extractToolResultContent(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .filter(b => b.type === 'text')
            .map(b => b.text)
            .join('');
    }
    return String(content);
}

/**
 * Convert Anthropic messages array to OpenAI messages array.
 * Handles tool_result expansion into separate messages.
 */
function convertAnthropicMessages(messages) {
    if (!messages || !Array.isArray(messages)) return [];

    const result = [];
    for (const msg of messages) {
        if (msg.role === 'user') {
            // Check if content contains tool_result blocks
            if (Array.isArray(msg.content)) {
                const toolResults = msg.content.filter(b => b.type === 'tool_result');
                const otherContent = msg.content.filter(b => b.type !== 'tool_result');

                // Emit tool messages first
                for (const tr of toolResults) {
                    result.push({
                        role: 'tool',
                        tool_call_id: tr.tool_use_id,
                        content: extractToolResultContent(tr.content)
                    });
                }

                // Emit remaining user content if any
                if (otherContent.length > 0) {
                    const converted = convertUserContent(otherContent);
                    result.push({ role: 'user', content: converted });
                }
            } else {
                result.push({ role: 'user', content: convertUserContent(msg.content) });
            }
        } else if (msg.role === 'assistant') {
            const { text, tool_calls } = convertAssistantContent(msg.content);
            const openaiMsg = { role: 'assistant', content: text };
            if (tool_calls) openaiMsg.tool_calls = tool_calls;
            result.push(openaiMsg);
        }
    }
    return result;
}

/**
 * Convert Anthropic tool definitions to OpenAI format.
 */
function convertAnthropicTools(tools) {
    if (!tools || !Array.isArray(tools)) return undefined;
    return tools.map(tool => ({
        type: 'function',
        function: {
            name: tool.name,
            ...(tool.description ? { description: tool.description } : {}),
            parameters: tool.input_schema
        }
    }));
}

/**
 * Convert Anthropic tool_choice to OpenAI format.
 */
function convertAnthropicToolChoice(toolChoice) {
    if (!toolChoice) return undefined;
    if (toolChoice === 'auto') return 'auto';
    if (toolChoice === 'any') return 'required';
    if (toolChoice === 'none') return 'none';
    if (typeof toolChoice === 'object' && toolChoice.type === 'tool') {
        return { type: 'function', function: { name: toolChoice.name } };
    }
    return undefined;
}

const FINISH_REASON_MAP = {
    stop: 'end_turn',
    length: 'max_tokens',
    tool_calls: 'tool_use',
    content_filter: 'end_turn'
};

const STATUS_ERROR_MAP = {
    400: 'invalid_request_error',
    401: 'authentication_error',
    403: 'permission_error',
    404: 'not_found_error',
    429: 'rate_limit_error',
    500: 'api_error',
    502: 'api_error',
    529: 'overloaded_error',
    503: 'overloaded_error'
};

/**
 * Build Anthropic usage from OpenAI usage.
 *
 * OpenAI's prompt_tokens is a TOTAL that already includes cached tokens
 * (prompt_tokens_details.cached_tokens and cache_creation_input_tokens),
 * whereas Anthropic's input_tokens semantics EXCLUDES them — cache hits/writes
 * are reported separately as cache_read_input_tokens / cache_creation_input_tokens.
 * Naively assigning prompt_tokens -> input_tokens double-counts the cache part.
 * Ref: https://github.com/QuantumNous/new-api/issues/4395
 */
function buildAnthropicUsage(oaiUsage) {
    const promptTokens = oaiUsage?.prompt_tokens || 0;
    const details = oaiUsage?.prompt_tokens_details || {};
    const cacheRead = details.cached_tokens || 0;
    // cache_creation may live under prompt_tokens_details (OpenAI) or at top-level
    // (some compatible upstreams), tolerate both.
    const cacheCreation = details.cache_creation_input_tokens || oaiUsage?.cache_creation_input_tokens || 0;
    return {
        input_tokens: Math.max(0, promptTokens - cacheRead - cacheCreation),
        cache_creation_input_tokens: cacheCreation,
        cache_read_input_tokens: cacheRead,
        output_tokens: oaiUsage?.completion_tokens || 0
    };
}

/**
 * Convert an OpenAI non-streaming response to Anthropic format.
 */
function convertOpenaiToAnthropicResponse(openaiRes) {
    const choice = openaiRes.choices[0];
    const message = choice.message;
    const content = [];

    if (message.reasoning_content) {
        content.push({ type: 'thinking', thinking: message.reasoning_content });
    }
    if (message.content) {
        content.push({ type: 'text', text: message.content });
    }
    if (message.tool_calls) {
        for (const tc of message.tool_calls) {
            let input;
            try { input = JSON.parse(tc.function.arguments); } catch { input = {}; }
            content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
        }
    }

    return {
        id: 'msg_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24),
        type: 'message',
        role: 'assistant',
        content,
        model: openaiRes.model,
        stop_reason: FINISH_REASON_MAP[choice.finish_reason] || 'end_turn',
        stop_sequence: null,
        usage: buildAnthropicUsage(openaiRes.usage)
    };
}

function formatSSE(eventType, data) {
    return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}

const EMPTY_BUF = Buffer.alloc(0);

/**
 * Create a Transform stream that converts OpenAI SSE chunks to Anthropic SSE events.
 * Uses Buffer-based accumulation to correctly handle UTF-8 multi-byte characters
 * split across chunk boundaries. Direct push avoids batch join overhead.
 */
function createAnthropicStreamTransformer(model, inputTokens) {
    const msgId = 'msg_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24);
    let sentStart = false;
    let contentBlockIndex = -1;
    let currentBlockType = null;
    let outputTokens = 0;
    let streamDone = false;
    let upstreamUsage = null;      // include_usage 末尾 chunk 的真实 usage
    let pendingStopReason = null;  // finish_reason 暂存，延迟到 usage chunk/[DONE]/flush 再结束
    let tail = EMPTY_BUF;

    // 结束流：发 content_block_stop(若有未关闭块) + message_delta(真实 usage) + message_stop。
    // 刻意延迟到此处(而非 finish_reason 时)是为了纳入 OpenAI stream_options.include_usage
    // 在末尾 chunk 返回的真实 usage(prompt_tokens / completion_tokens / cached_tokens)，
    // 让官方 SDK 能在 message_delta 拿到准确的 input/output tokens。
    function finalize(stream, stopReason) {
        if (streamDone) return;
        streamDone = true;
        if (contentBlockIndex >= 0) {
            stream.push(formatSSE('content_block_stop', { type: 'content_block_stop', index: contentBlockIndex }));
        }
        // 有真实 usage 则用(并扣除缓存)，否则退回到 delta 块计数累加值
        const usage = upstreamUsage ? buildAnthropicUsage(upstreamUsage) : { output_tokens: outputTokens };
        stream.push(formatSSE('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: stopReason || 'end_turn', stop_sequence: null },
            usage
        }));
        stream.push(formatSSE('message_stop', { type: 'message_stop' }));
    }

    function processSSEBlock(block, stream) {
        const lines = block.split('\n');
        for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (data === '[DONE]') {
                finalize(stream, pendingStopReason);
                continue;
            }
            let parsed;
            try { parsed = JSON.parse(data); } catch { continue; }

            // 捕获 include_usage 末尾 chunk 的 usage(choices 可能为空数组)
            if (parsed.usage) {
                upstreamUsage = parsed.usage;
            }

            const choice = parsed.choices?.[0];
            if (!choice) continue;

            if (!sentStart) {
                sentStart = true;
                stream.push(formatSSE('message_start', {
                    type: 'message_start',
                    message: {
                        id: msgId, type: 'message', role: 'assistant', content: [],
                        model, stop_reason: null, stop_sequence: null,
                        usage: { input_tokens: inputTokens || 0, output_tokens: 1 }
                    }
                }));
            }

            const delta = choice.delta || {};

            if (choice.finish_reason) {
                // 暂存 stop_reason，不立即结束：等后续 usage chunk / [DONE] / flush
                pendingStopReason = FINISH_REASON_MAP[choice.finish_reason] || 'end_turn';
                continue;
            }

            const reasoningText = delta.reasoning_content || delta.reasoning;
            if (reasoningText) {
                if (currentBlockType !== 'thinking') {
                    if (contentBlockIndex >= 0) {
                        stream.push(formatSSE('content_block_stop', { type: 'content_block_stop', index: contentBlockIndex }));
                    }
                    contentBlockIndex++;
                    currentBlockType = 'thinking';
                    stream.push(formatSSE('content_block_start', {
                        type: 'content_block_start', index: contentBlockIndex,
                        content_block: { type: 'thinking', thinking: '' }
                    }));
                }
                stream.push(formatSSE('content_block_delta', {
                    type: 'content_block_delta', index: contentBlockIndex,
                    delta: { type: 'thinking_delta', thinking: reasoningText }
                }));
                outputTokens++;
            }

            if (delta.content != null && delta.content !== '') {
                if (currentBlockType !== 'text') {
                    if (contentBlockIndex >= 0) {
                        stream.push(formatSSE('content_block_stop', { type: 'content_block_stop', index: contentBlockIndex }));
                    }
                    contentBlockIndex++;
                    currentBlockType = 'text';
                    stream.push(formatSSE('content_block_start', {
                        type: 'content_block_start', index: contentBlockIndex,
                        content_block: { type: 'text', text: '' }
                    }));
                }
                stream.push(formatSSE('content_block_delta', {
                    type: 'content_block_delta', index: contentBlockIndex,
                    delta: { type: 'text_delta', text: delta.content }
                }));
                outputTokens++;
            }

            if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                    if (tc.function?.name) {
                        if (contentBlockIndex >= 0) {
                            stream.push(formatSSE('content_block_stop', { type: 'content_block_stop', index: contentBlockIndex }));
                        }
                        contentBlockIndex++;
                        currentBlockType = 'tool_use';
                        stream.push(formatSSE('content_block_start', {
                            type: 'content_block_start', index: contentBlockIndex,
                            content_block: { type: 'tool_use', id: tc.id || '', name: tc.function.name, input: {} }
                        }));
                    }
                    if (tc.function?.arguments) {
                        stream.push(formatSSE('content_block_delta', {
                            type: 'content_block_delta', index: contentBlockIndex,
                            delta: { type: 'input_json_delta', partial_json: tc.function.arguments }
                        }));
                    }
                }
            }
        }
    }

    return new Transform({
        transform(chunk, enc, cb) {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, enc || 'utf8');
            const data = tail.length > 0 ? Buffer.concat([tail, buf]) : buf;
            tail = EMPTY_BUF;

            let offset = 0;
            while (!streamDone) {
                const sep = data.indexOf('\n\n', offset);
                if (sep === -1) {
                    tail = offset > 0 ? Buffer.from(data.subarray(offset)) : data;
                    break;
                }
                const block = data.subarray(offset, sep).toString('utf8');
                offset = sep + 2;
                processSSEBlock(block, this);
            }
            if (streamDone && offset < data.length) {
                tail = Buffer.from(data.subarray(offset));
            }
            cb();
        },
        flush(cb) {
            if (tail.length > 0 && !streamDone) {
                const remaining = tail.toString('utf8').trim();
                if (remaining) processSSEBlock(remaining, this);
            }
            // 上游未发 [DONE](仅 finish_reason 后直接关闭)时兜底结束
            if (!streamDone) {
                finalize(this, pendingStopReason);
            }
            cb();
        }
    });
}

/**
 * Convert an OpenAI error to Anthropic error format.
 */
function convertOpenaiErrorToAnthropic(openaiError, statusCode) {
    let errorType = 'api_error';
    let message = 'Unknown error';
    if (openaiError?.error) {
        errorType = openaiError.error.type || STATUS_ERROR_MAP[statusCode] || 'api_error';
        message = openaiError.error.message || 'Unknown error';
    } else if (statusCode) {
        errorType = STATUS_ERROR_MAP[statusCode] || 'api_error';
        message = `HTTP ${statusCode}`;
    }
    return { type: 'error', error: { type: errorType, message } };
}

/**
 * Convert a full Anthropic API request body to OpenAI format.
 */
function convertAnthropicToOpenaiRequest(anthropicBody) {
    const messages = [];

    // System prompt handling
    if (anthropicBody.system) {
        let systemContent;
        if (typeof anthropicBody.system === 'string') {
            systemContent = anthropicBody.system;
        } else if (Array.isArray(anthropicBody.system)) {
            systemContent = anthropicBody.system
                .filter(b => b.type === 'text')
                .map(b => b.text)
                .join('\n');
        }
        if (systemContent) messages.push({ role: 'system', content: systemContent });
    }

    // Convert messages
    const convertedMessages = convertAnthropicMessages(anthropicBody.messages || []);
    messages.push(...convertedMessages);

    // Build OpenAI request body
    const openaiBody = { model: anthropicBody.model, messages };

    if (anthropicBody.max_tokens !== undefined) openaiBody.max_tokens = anthropicBody.max_tokens;
    if (anthropicBody.temperature !== undefined) openaiBody.temperature = anthropicBody.temperature;
    if (anthropicBody.top_p !== undefined) openaiBody.top_p = anthropicBody.top_p;
    if (anthropicBody.stream !== undefined) openaiBody.stream = anthropicBody.stream;
    // 流式请求要求上游在末尾 chunk 返回真实 usage，供 message_delta 回补
    if (anthropicBody.stream) openaiBody.stream_options = { include_usage: true };
    if (anthropicBody.stop_sequences) openaiBody.stop = anthropicBody.stop_sequences;

    const tools = convertAnthropicTools(anthropicBody.tools);
    if (tools) openaiBody.tools = tools;

    const toolChoice = convertAnthropicToolChoice(anthropicBody.tool_choice);
    if (toolChoice) openaiBody.tool_choice = toolChoice;

    return openaiBody;
}

module.exports = {
    convertContentBlock,
    convertUserContent,
    convertAssistantContent,
    convertAnthropicMessages,
    convertAnthropicTools,
    convertAnthropicToolChoice,
    convertAnthropicToOpenaiRequest,
    convertOpenaiToAnthropicResponse,
    buildAnthropicUsage,
    createAnthropicStreamTransformer,
    convertOpenaiErrorToAnthropic
};
