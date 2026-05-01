# MACC — Multi-Agent Coding Client

## What It Does

MACC is a unified terminal client for AI coding agents. You run `macc` once and never leave it. MACC proxies your input to whichever agent is currently active (Claude Code, Gemini, Cursor, etc.), streams the output back to your terminal, and monitors usage in the background. When an agent approaches its context limit, MACC automatically condenses the session and switches to the next agent — without you changing terminals, losing context, or even noticing the switch.

**One client. Many agents. Seamless handoff.**

---

## The Problem

Every AI coding agent has a context window limit:
- Claude Code: 200,000 tokens
- Gemini CLI: 1,000,000+ tokens
- Cursor: model-dependent
- Qoder: varies

When you hit the limit mid-task, all accumulated context is lost — the goal, the decisions, the history. The current workaround is manual: Ctrl+C, type a different agent's name, start over. MACC eliminates this entirely.

---

## The Architecture: Unified Proxy Client

```
┌────────────────────────────────────────────────────────────┐
│                     MACC Terminal UI                       │
│                                                            │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  Conversation output (streamed from active agent)    │  │
│  │                                                      │  │
│  │  > You: how do I fix the auth middleware?            │  │
│  │  > Claude: Here's what I found in middleware.ts...   │  │
│  │                                                      │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                            │
│  [Claude Code ████████████████████░ 94%]  [switch: auto]  │
│                                                            │
│  > Your input here_                                        │
└────────────────────────────────────────────────────────────┘
              │ proxy I/O              ↑ stream output
              ▼                        │
    ┌─────────────────┐      ┌─────────────────┐
    │   Claude Code   │  or  │   Gemini CLI    │  or  ...
    │   subprocess    │      │   subprocess    │
    └─────────────────┘      └─────────────────┘
```

**Flow:**
1. User runs `macc` — picks or defaults to active agent
2. MACC spawns the agent as a subprocess, proxies stdin/stdout
3. Background monitor watches agent usage (token count, rate limits)
4. At 80%: status bar turns yellow — warning
5. At 95%: MACC condenses context via Claude Haiku → writes HandoffPacket
6. MACC kills current agent subprocess, spawns next agent, sends handoff prompt as first message
7. User sees: output continues. New agent. Same terminal. No interruption.

---

## What the User Does

```bash
macc          # start MACC, it picks the configured default agent
macc gemini   # start MACC using Gemini as the first agent
```

That's it. All switching is automatic. The user stays in MACC's terminal the entire time.

---

## Supported Agents (MVP)

| Agent | Subprocess I/O | Context Source | Switch Priority |
|---|---|---|---|
| Claude Code | stdin/stdout pipe | `~/.claude/projects/**/*.jsonl` | 1 (default) |
| Gemini CLI | stdin/stdout pipe | `~/.gemini/` (estimated) | 2 |
| Cursor | file injection + IDE open | `~/.cursor/` SQLite | 3 |
| Qoder | file injection (stub) | TBD | 4 |

---

## Commands

```bash
macc                   # Launch with default agent
macc gemini            # Launch with specific agent
macc status            # Show current agent + usage (non-interactive)
macc history           # Show past handoff events
macc config            # Open config file
```

**In-session keyboard shortcuts:**
- `Ctrl+Shift+S` — show agent status bar
- `Ctrl+Shift+H` — trigger manual handoff now
- `Ctrl+Shift+N` — force switch to next agent in priority list
- `Ctrl+C` — exit MACC (and underlying agent)

---

## Implementation Phases

### Phase 1 — Proxy Client MVP (Week 1–2)
- MACC launches and proxies a single agent subprocess (Claude Code)
- Streams agent output to terminal, forwards user input
- Bottom status bar showing agent name + usage %
- JSONL session reader for live token tracking
- `macc status` command works standalone

### Phase 2 — Handoff Engine (Week 3–4)
- Context condensation via Claude Haiku
- Auto-switch at 95% threshold: kill → condense → spawn next agent with handoff prompt
- Support Gemini CLI as second agent (stdin injection)
- SQLite handoff history, `macc history` command

### Phase 3 — Full Multi-Agent + Polish (Week 5–6)
- Cursor and Qoder adapters
- Config file (`~/.macc/config.json`): agent priority, thresholds, model
- Keyboard shortcuts for manual handoff
- WSL2 path normalization
- Desktop notifications on auto-switch
- `npm publish` as global `macc` CLI

---

## Architecture Overview

See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for full module breakdown, data models, and the proxy I/O design.

See [docs/AGENTS.md](./docs/AGENTS.md) for per-agent subprocess and context injection strategies.
