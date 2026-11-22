English | [简体中文](multi-session-best-practices.md)

# Multi-Session, Multi-Endpoint Best Practices

> impersonator (multiple mapped endpoint groups) × per-session env presets × herdr multiplexing:
> run multiple agent sessions in parallel on one machine, each with its own model-mapping preset.

## When to use this

- Several concurrent agent sessions: the mainline session on one model, reasoning-heavy work on another
- Each session needs its own mapping preset, but you don't want to keep editing config files back and forth

How this differs from switcher tools like cc-switch or magpie: switchers activate a single endpoint configuration globally at any moment; impersonator is a persistent service that **exposes multiple mapped endpoint groups simultaneously** — pick the entry per session via env, with no interference.

## Architecture (three layers)

```
┌─ Multiplexing: herdr ─────────────────────────────┐
│  workspace / pane isolation, one shell per pane   │
├─ Session: ~/.bashrc.d preset scripts ─────────────┤
│  one launcher per preset, subshell + exec env     │
├─ Gateway: impersonator ───────────────────────────┤
│  endpoints coexist; mapping + protocol conversion │
└───────────────────────────────────────────────────┘
```

## Step 1: Prepare multiple endpoints at the gateway

Configure `ENDPOINTS` as shown in `impersonator.env.example` — one `path` per preset,
e.g. `/glm` (mapped to GLM) and `/deepseek` (mapped to DeepSeek). Each endpoint keeps its
own `mappings`; client model names (opus/sonnet/haiku) are mapped to real models at the
gateway, transparent to the agent.

## Step 2: Preset variables and launcher functions

`~/.bashrc.d/agent-presets.sh` (loaded from your bashrc):

```bash
# One BASE_URL variable per preset, pointing at the corresponding impersonator endpoint
export GLM_BASE_URL="https://gw.example.com/glm"
export DP_BASE_URL="https://gw.example.com/deepseek"

# In passthrough mode the token is forwarded by the gateway; for fixed-auth entries, use that entry's credentials instead
export ANTHROPIC_AUTH_TOKEN="sk-your-token"

# Default preset fallback
export ANTHROPIC_BASE_URL=$GLM_BASE_URL

# Mainline sessions: GLM mapping, high intensity
glmyolo() {
(
    export CUSTOM_AGENT_CMD=glmyolo     # channel marker; resume routing and the recursion guard depend on it
    export ANTHROPIC_BASE_URL=$GLM_BASE_URL
    export CLAUDE_CODE_EFFORT_LEVEL="max"
    exec claude "$@"
)
}

# Reasoning tasks: DeepSeek mapping
dpyolo() {
(
    export CUSTOM_AGENT_CMD=dpyolo
    export ANTHROPIC_BASE_URL=$DP_BASE_URL
    exec claude "$@"
)
}
```

**Key points**:

1. **`( ... )` subshell + `exec` in the function body**: the env vars only affect the
   agent process started by this invocation, never the current shell; `exec` lets the
   agent replace the subshell process for a clean exit code.
2. **Bundle preset differences into the launcher**: besides `BASE_URL`, stack
   agent-side knobs — `--effort`, `--model`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, etc. —
   so one preset ties together "model tier + context window + permission policy".
3. Risky switches (such as skipping permission prompts) are your call; enable them
   only inside dedicated preset functions.

### Session channel marking and resume auto-routing (CUSTOM_AGENT_CMD)

Multi-preset parallelism has a pitfall: when herdr restores sessions
(`resume_agents_on_restore`) or you run `claude --resume <sid>` manually, the new
process inherits the current shell's default endpoint rather than the session's own
preset — a GLM session can come back on the DeepSeek endpoint. The fix is to record a
"channel" per session and route resumes back to the original preset, in three parts:

**① Mark**: each preset launcher exports `CUSTOM_AGENT_CMD=<function name>` (e.g.
`glmyolo`) — both the channel identifier and the recursion-guard predicate.

**② Record**: register a SessionStart hook that persists `session_id → channel`:

```bash
#!/bin/bash
# ~/.claude/hooks/custom-agent-map.sh (register as a SessionStart hook in claude settings)
input="$(cat)"; exec 2>/dev/null
[ -n "${CUSTOM_AGENT_CMD:-}" ] || exit 0          # only sessions started by preset launchers
agent_id="$(printf '%s' "$input" | sed -n 's/.*"agent_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
[ -n "$agent_id" ] && exit 0                       # skip subagent sessions
sid="$(printf '%s' "$input" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
[ -n "$sid" ] || exit 0
map_dir="${XDG_STATE_HOME:-$HOME/.local/state}/custom-agent-map"
mkdir -p "$map_dir"
printf '%s\n' "$CUSTOM_AGENT_CMD" > "$map_dir/$sid"   # in production prefer tmp+mv atomic write + mtime pruning
```

Notes: the hook process inherits the launcher's environment, so it can read
`CUSTOM_AGENT_CMD`; a non-empty `agent_id` identifies a subagent session, which must
not be recorded.

**③ Route**: a `claude()` wrapper function intercepts resume/continue:

- `--resume=<sid>` / `--resume <sid>` yield the sid directly; `-c|--continue` resolves
  the sid from the newest `<sid>.jsonl` in the munged project directory
  (`~/.claude/projects/<pwd-munged>/`)
- Recursion guard: if `CUSTOM_AGENT_CMD` is already set (explicit env, or the last hop
  of a routing chain) → pass straight through to the real binary; the map must not
  override it
- On a map hit whose function exists → invoke `"$cmd" "$@"`; the preset function's
  subshell re-exports the endpoint and `exec claude`s, and the last hop passes the
  recursion guard to the real binary
- On a miss (including a deleted function) → warn and fall back to the default endpoint

```bash
claude() {
    local real="$HOME/.local/bin/claude"
    [ -x "$real" ] || real="$(type -ap claude 2>/dev/null | head -1)"
    # ... parse --resume/--continue into sid; no resume semantics → plain child-process passthrough ...
    [ -n "${CUSTOM_AGENT_CMD:-}" ] && { "$real" "$@"; return; }   # recursion guard
    local map_dir="${XDG_STATE_HOME:-$HOME/.local/state}/custom-agent-map"
    local cmd=""; [ -f "$map_dir/$sid" ] && cmd="$(head -1 "$map_dir/$sid")"
    if [ -n "$cmd" ] && declare -F "$cmd" >/dev/null 2>&1; then
        "$cmd" "$@"          # hand off to the preset function, which re-exports the endpoint and execs
    else
        "$real" "$@"          # no mapping → fall back to the default endpoint
    fi
}
```

**Synergy with herdr**: with `resume_agents_on_restore = true`, herdr restarts agent
panes via `claude --resume <sid>`; the wrapper intercepts that call, looks up the map,
and routes back to the original preset — "herdr restarts, every multi-preset session
returns to its own channel":

```
glmyolo starts → first-hop claude (CUSTOM_AGENT_CMD=glmyolo)
  └─ SessionStart hook writes map/<sid> = glmyolo
herdr restarts → claude --resume <sid> (CUSTOM_AGENT_CMD empty)
  └─ wrapper hits the map → invokes glmyolo
      └─ subshell re-exports the GLM endpoint → exec claude (last hop passes the recursion guard)
```

Two more wrapper notes:

- Tool-like subcommands (`--help`, `doctor`, `mcp`, …) carry no session semantics —
  pass them through as a child process, not `exec`; a short-lived command would
  otherwise close the whole herdr/tmux pane when it exits;
- Locate the real binary via the symlink first (upgrades point it at the new version
  automatically), falling back to `type -ap`; never use `command -v` (it hits the
  wrapper function itself and recurses).

## Step 3: Run sessions in parallel with herdr

herdr is an AI-agent-aware terminal multiplexer (workspace/tab/pane management,
automatic detection of agents like claude/codex, sidebar status queue, native session
restore) — similar to tmux, with agent-specific enhancements.

- **Every pane is an independent shell**: run `glmyolo` in one pane and `dpyolo` in
  another to run GLM and DeepSeek presets side by side — that's exactly the payoff of
  "multiple endpoint groups coexisting".
- Recommended settings (`~/.config/herdr/config.toml`):

  ```toml
  [ui]
  # Show detected agent labels on pane borders
  show_agent_labels_on_pane_borders = true

  # Sidebar agent rows include the terminal title, so a title set by the launcher
  # tells you at a glance which endpoint a session uses
  [ui.sidebar.agents]
  rows = [["state_icon", "workspace", "tab"], ["agent"], ["terminal_title_stripped"]]

  [session]
  # Restore agents' native sessions after a herdr restart
  resume_agents_on_restore = true
  ```

- Launchers can also set the terminal title with
  `printf '\033]0;glm-max\007'`; combined with the sidebar's
  `terminal_title_stripped` row it makes each pane's preset easy to identify.

## Step 4: Security and anonymization

- Keep tokens only in local private scripts (`~/.bashrc.d/` stays out of public
  repositories); in passthrough mode credentials flow through the gateway, and
  impersonator logs only masked tokens (first 4 / last 4).
- When sharing scripts or docs externally: use placeholders for the gateway domain and
  tokens (e.g. `gw.example.com`, `sk-your-token`), and avoid internal project codenames
  in endpoint names.

## Quick reference

| Launcher | Endpoint | Preset role | Typical extras |
|---|---|---|---|
| `glmyolo` | `/glm` | Mainline session | `--effort max`, `CLAUDE_CODE_EFFORT_LEVEL=max` |
| `dpyolo` | `/deepseek` | Reasoning tasks | stack model/context flags as needed |
