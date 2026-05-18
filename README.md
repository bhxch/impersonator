# Impersonator Proxy

AI 模型代理网关，支持多后端、多端点、模型映射和 Anthropic↔OpenAI 协议转换。

## 部署信息

- 服务器：`198.51.100.10`
- 监听：`0.0.0.0:80`
- 运行时：Bun
- 管理：systemd (`systemctl restart/stop/status impersonator`)
- 日志：`journalctl -u impersonator`

## 后端

| ID | Target | 协议 | 说明 |
|---|---|---|---|
| openrouter | `https://openrouter.ai/api/v1` | openai | OpenRouter |
| newapi | `https://newapi.example.com` | openai | NewAPI（原生支持双协议） |

所有后端均为 API Key 透传模式（不配置后端 apiKey，客户端凭据直接转发）。

## 端点与模型映射

### /anthropic/v1 → openrouter

- 入口协议：**anthropic**（Anthropic→OpenAI 转换）
- 无模型映射，客户端模型名直接透传

### /glm → newapi

- 入口协议：**anthropic**（Anthropic→OpenAI 转换）
- 模型映射：

| 匹配规则 | 目标模型 |
|---|---|
| opus | glm-5.1 |
| sonnet | glm-5.1 |
| haiku | deepseek-v4-flash |

### /deepseek → newapi

- 入口协议：**anthropic**（Anthropic→OpenAI 转换）
- 模型映射：

| 匹配规则 | 目标模型 |
|---|---|
| opus | deepseek-v4-pro |
| sonnet | deepseek-v4-pro |
| haiku | deepseek-v4-flash |

### /dpflash → newapi

- 入口协议：**anthropic**（Anthropic→OpenAI 转换）
- 模型映射：

| 匹配规则 | 目标模型 |
|---|---|
| opus | deepseek-v4-flash |
| sonnet | deepseek-v4-flash |
| haiku | deepseek-v4-flash |

### /newapi/deepseek → newapi

- 入口协议：**双协议**（openai/anthropic 均支持，无转换）
- 模型映射：

| 匹配规则 | 目标模型 |
|---|---|
| opus | deepseek-v4-pro |
| sonnet | deepseek-v4-pro |
| haiku | deepseek-v4-flash |

### /newapi/glm → newapi

- 入口协议：**双协议**（openai/anthropic 均支持，无转换）
- 模型映射：

| 匹配规则 | 目标模型 |
|---|---|
| opus | glm-5.1 |
| sonnet | glm-5.1 |
| haiku | deepseek-v4-flash |

### /newapi/dpflash → newapi

- 入口协议：**双协议**（openai/anthropic 均支持，无转换）
- 模型映射：

| 匹配规则 | 目标模型 |
|---|---|
| opus | deepseek-v4-flash |
| sonnet | deepseek-v4-flash |
| haiku | deepseek-v4-flash |

## 文件说明

| 文件 | 说明 |
|---|---|
| `impersonator.js` | 代理主程序 |
| `converter.js` | Anthropic↔OpenAI 协议转换模块 |
| `impersonator.env.example` | 配置示例（含注释说明） |
| `impersonator.service` | systemd 服务单元文件 |
| `test-converter.js` | 协议转换单元测试 |
