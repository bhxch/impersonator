# Impersonator Proxy

AI 模型代理网关，支持多后端、多端点、模型映射和 Anthropic↔OpenAI 协议转换。

## 项目特点

与 cc-switch、magpie 等切换式工具不同（同一时刻全局只有一套端点配置生效），本项目以常驻服务形式**同时暴露多组映射端点**：

- 多组预设端点并存，启动具体 agent 前设置不同 env（如 `ANTHROPIC_BASE_URL` 指向不同入口）即可使用不同的预设端点
- 一台机器上不同会话可同时使用不同映射，互不干扰，无需来回切换配置
- 模型映射与 Anthropic↔OpenAI 协议转换均在网关侧完成，客户端无感

端点与映射的具体配置见 `impersonator.env.example`，多会话多端点的使用实践见
[docs/multi-session-best-practices.md](docs/multi-session-best-practices.md)。

## 部署信息

- 运行时：Bun
- 管理：systemd (`systemctl restart/stop/status impersonator`)
- 日志：`journalctl -u impersonator`

## 文件说明

| 文件 | 说明 |
|---|---|
| `impersonator.js` | 代理主程序 |
| `converter.js` | Anthropic↔OpenAI 协议转换模块 |
| `impersonator.env.example` | 配置示例（含注释说明） |
| `impersonator.service` | systemd 服务单元文件 |
| `test-converter.js` | 协议转换单元测试 |
