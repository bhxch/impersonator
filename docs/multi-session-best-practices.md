[English](multi-session-best-practices.en.md) | 简体中文

# 多会话多端点使用最佳实践

> impersonator（多组映射端点）× 每会话 env 预设 × herdr 多路复用：
> 在一台机器上并行运行多个 agent 会话，各会话使用不同的模型映射预设。

## 适用场景

- 同时开多个 agent 会话：主力会话走一个模型，推理任务走另一个模型
- 不同会话需要不同映射预设，但不想每次改配置文件来回切换

与 cc-switch、magpie 等切换式工具的区别：切换式工具同一时刻全局只有一套端点配置生效；
impersonator 以常驻服务**同时暴露多组映射端点**，会话启动时用 env 选择入口即可，互不干扰。

## 整体架构（三层）

```
┌─ 复用层：herdr ──────────────────────────────┐
│  workspace / pane 隔离，每个 pane 独立 shell  │
├─ 会话层：~/.bashrc.d 预设脚本 ────────────────┤
│  每个预设一个启动函数，subshell + exec 隔离 env│
├─ 网关层：impersonator ───────────────────────┤
│  多端点并存，端点内完成模型映射 + 协议转换     │
└──────────────────────────────────────────────┘
```

## 第 1 步：网关侧准备好多组端点

参考 `impersonator.env.example` 配置 `ENDPOINTS`，一个 `path` 对应一个预设，
例如 `/glm`（映射到 GLM）与 `/deepseek`（映射到 DeepSeek）。每个端点各自
维护 `mappings`，客户端模型名（opus/sonnet/haiku）在网关侧被映射为实际模型，
agent 无感。

## 第 2 步：编写预设变量与启动函数

`~/.bashrc.d/agent-presets.sh`（bashrc 加载）：

```bash
# 每个预设一个 BASE_URL 变量，指向 impersonator 的对应端点
export GLM_BASE_URL="https://gw.example.com/glm"
export DP_BASE_URL="https://gw.example.com/deepseek"

# 透传模式下 token 经网关直转后端；固定鉴权入口则换成对应入口的凭据
export ANTHROPIC_AUTH_TOKEN="sk-your-token"

# 默认预设兜底
export ANTHROPIC_BASE_URL=$GLM_BASE_URL

# 主力会话：GLM 映射，高强度
glmyolo() {
(
    export CUSTOM_AGENT_CMD=glmyolo     # 通道标记，resume 路由与防递归依赖它
    export ANTHROPIC_BASE_URL=$GLM_BASE_URL
    export CLAUDE_CODE_EFFORT_LEVEL="max"
    exec claude "$@"
)
}

# 推理任务：DeepSeek 映射
dpyolo() {
(
    export CUSTOM_AGENT_CMD=dpyolo
    export ANTHROPIC_BASE_URL=$DP_BASE_URL
    exec claude "$@"
)
}
```

**要点**：

1. **函数体用 `( ... )` 子 shell + `exec`**：环境变量只影响本次启动的 agent
   进程，不污染当前 shell；`exec` 让 agent 直接替换子 shell 进程，退出码干净。
2. **预设差异在启动函数里一步到位**：除了 `BASE_URL`，还可叠加 agent 侧的
   差异化参数——`--effort`、`--model`、`CLAUDE_CODE_AUTO_COMPACT_WINDOW`
   等，把"模型档位 + 上下文窗口 + 权限策略"绑成一个预设。
3. 高风险开关（如跳过权限确认）自行权衡，建议只在专用预设函数里开启。

### 会话通道标记与 resume 自动路由（CUSTOM_AGENT_CMD）

多预设并行后有个隐患：herdr 恢复会话（`resume_agents_on_restore`）或手动
`claude --resume <sid>` 时，新进程继承的是当前 shell 的默认端点，而不是该
会话原本的预设——GLM 会话恢复后可能落到 DeepSeek 端点。解法是给每个会话
记录"通道"，resume 时反查并路由回原预设，由三部分组成：

**① 标记**：预设启动函数导出 `CUSTOM_AGENT_CMD=<函数名>`（如 `glmyolo`），
既是通道标识，也是后续防递归的判断依据。

**② 记录**：注册一个 SessionStart hook，把 `session_id → 通道` 落盘：

```bash
#!/bin/bash
# ~/.claude/hooks/custom-agent-map.sh（在 claude settings 注册为 SessionStart hook）
input="$(cat)"; exec 2>/dev/null
[ -n "${CUSTOM_AGENT_CMD:-}" ] || exit 0          # 仅预设函数启动的会话才记录
agent_id="$(printf '%s' "$input" | sed -n 's/.*"agent_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
[ -n "$agent_id" ] && exit 0                       # 子代理会话不记录
sid="$(printf '%s' "$input" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
[ -n "$sid" ] || exit 0
map_dir="${XDG_STATE_HOME:-$HOME/.local/state}/custom-agent-map"
mkdir -p "$map_dir"
printf '%s\n' "$CUSTOM_AGENT_CMD" > "$map_dir/$sid"   # 生产版建议 tmp+mv 原子写、按 mtime 修剪
```

要点：hook 进程继承启动方环境变量，所以能读到 `CUSTOM_AGENT_CMD`；
`agent_id` 非空即子代理会话，不记录以免误映射。

**③ 路由**：`claude()` 包装函数拦截 resume/continue：

- `--resume=<sid>` / `--resume <sid>` 直接取 sid；`-c|--continue` 反查
  munged 项目目录（`~/.claude/projects/<pwd-munged>/`）下 mtime 最新的
  `<sid>.jsonl` 得到 sid
- 防递归：`CUSTOM_AGENT_CMD` 已非空（显式环境，或路由链末跳）→ 直接透传
  真身，映射表不得覆盖
- 查表命中且函数存在 → 以 `"$cmd" "$@"` 调用预设函数，函数内子 shell 重新
  导出端点并 `exec claude`，末跳被防递归判断放行到真身
- 未命中（含函数已删）→ 警告后回落默认端点，优雅降级

```bash
claude() {
    local real="$HOME/.local/bin/claude"
    [ -x "$real" ] || real="$(type -ap claude 2>/dev/null | head -1)"
    # ... 解析 --resume/--continue 得到 sid；无 resume 语义则子进程直通 ...
    [ -n "${CUSTOM_AGENT_CMD:-}" ] && { "$real" "$@"; return; }   # 防递归
    local map_dir="${XDG_STATE_HOME:-$HOME/.local/state}/custom-agent-map"
    local cmd=""; [ -f "$map_dir/$sid" ] && cmd="$(head -1 "$map_dir/$sid")"
    if [ -n "$cmd" ] && declare -F "$cmd" >/dev/null 2>&1; then
        "$cmd" "$@"          # 调用预设函数接力，内部重新导出端点后 exec
    else
        "$real" "$@"          # 无映射，回落默认端点
    fi
}
```

**与 herdr 的协同**：`resume_agents_on_restore = true` 时，herdr 重启后自动
以 `claude --resume <sid>` 拉起各 agent pane；该调用被包装函数拦截、查表、
路由回原预设——实现"herdr 重启，多预设会话各回各位"：

```
glmyolo 启动 → 首跳 claude（CUSTOM_AGENT_CMD=glmyolo）
  └─ SessionStart hook 写入 map/<sid> = glmyolo
herdr 重启 → claude --resume <sid>（CUSTOM_AGENT_CMD 为空）
  └─ 包装函数查表命中 → 调用 glmyolo
      └─ 子 shell 重新导出 GLM 端点 → exec claude（末跳防递归直通真身）
```

包装函数另外两个注意事项：

- 工具类子命令（`--help`、`doctor`、`mcp` 等）无会话语义，用子进程方式
  直通，不要 `exec`——短命命令结束后会连带关闭所在 herdr/tmux pane；
- 定位真实可执行文件优先符号链接（升级自动指向新版本），回退用
  `type -ap`，不要用 `command -v`（会命中包装函数自身导致递归）。

## 第 3 步：herdr 并行运行多会话

herdr 是面向 AI agent 的终端复用器（workspace/tab/pane 管理、自动识别
claude/codex 等 agent、侧栏状态队列、原生会话恢复），与 tmux 用法类似但
对 agent 场景有专门增强。

- **每个 pane 都是独立 shell**，一个 pane 跑 `glmyolo`、另一个 pane 跑
  `dpyolo`，即可同屏并行 GLM 与 DeepSeek 两个预设的会话——这正是
  "多组端点并存"的价值所在。
- 推荐配置（`~/.config/herdr/config.toml`）：

  ```toml
  [ui]
  # pane 边框显示识别到的 agent 标签
  show_agent_labels_on_pane_borders = true

  # 侧栏 agent 行带终端标题，配合启动函数设置标题可一眼区分会话走哪个端点
  [ui.sidebar.agents]
  rows = [["state_icon", "workspace", "tab"], ["agent"], ["terminal_title_stripped"]]

  [session]
  # herdr 重启后恢复 agent 的原生会话
  resume_agents_on_restore = true
  ```

- 启动函数里可顺带 `printf '\033]0;glm-max\007'` 设置终端标题，与侧栏
  `terminal_title_stripped` 行配合，快速识别哪个 pane 走哪个预设。

## 第 4 步：安全与脱敏

- token 只放在本地私有脚本中（`~/.bashrc.d/` 不进入公开仓库）；透传模式下
  凭据经网关直转后端，impersonator 日志只输出脱敏后的 token（前 4 后 4）。
- 对外分享脚本/文档时：网关域名与 token 用占位符（如 `gw.example.com`、
  `sk-your-token`），端点命名避免携带内部项目代号。

## 常见组合速查

| 启动函数 | 入口端点 | 预设定位 | 典型附加参数 |
|---|---|---|---|
| `glmyolo` | `/glm` | 主力会话 | `--effort max`、`CLAUDE_CODE_EFFORT_LEVEL=max` |
| `dpyolo` | `/deepseek` | 推理任务 | 可按需叠加模型/上下文参数 |
