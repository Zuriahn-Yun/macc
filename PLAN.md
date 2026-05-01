# MACC — Multi-Agent Coding Client

## What It Does

MACC (Multi-Agent Coding Client) is a CLI tool that makes switching between AI coding agents seamless. When Claude Code (or any supported agent) approaches its context limit, MACC automatically condenses your session — current goal, decisions made, files touched, what's next — and injects that context into the next agent you launch.

**Your workflow stays the same**: Ctrl+C out of Claude Code, type `gemini`, press Enter. MACC handles the rest invisibly via shell wrappers.

---

## The Problem

Every AI coding agent has a context window limit:
- Claude Code: 200,000 tokens
- Gemini CLI: 1,000,000+ tokens
- Cursor: model-dependent
- Qoder: varies

When you hit that limit mid-task, you lose everything — the goal, the decisions, the history. You either start over or manually copy-paste context. Both are painful.

---

## The Solution: Shell Wrapper Pattern

```
┌─────────────────────────────────────────────────────┐
│  1. macc start (runs in background)                 │
│     └── watches ~/.claude/projects/**/*.jsonl       │
│                                                     │
│  2. At 95% context usage:                           │
│     └── condenses session with Claude Haiku         │
│     └── saves to ~/.macc/pending/<cwd-hash>.json    │
│                                                     │
│  3. User does Ctrl+C out of Claude Code             │
│                                                     │
│  4. User types: gemini                              │
│     └── shell wrapper intercepts                    │
│     └── finds pending handoff for this directory    │
│     └── pipes condensed context as first message    │
│     └── Gemini starts with full context ✓           │
│                                                     │
│  5. No pending handoff? → launches normally         │
└─────────────────────────────────────────────────────┘
```

---

## Supported Agents (MVP)

| Agent | Context Source | Injection Method |
|---|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` | stdin pipe |
| Gemini CLI | Process detection + estimation | stdin pipe |
| Cursor | `~/.cursor/` SQLite state | Handoff file + IDE open |
| Qoder | Stub (format TBD) | Handoff file |

---

## Commands

```bash
macc install          # Add shell wrappers to ~/.bashrc — run once
macc start            # Start background daemon (watches usage)
macc status           # Print current session token usage %
macc handoff [agent]  # Manually trigger handoff now
macc history          # Show past handoff events
```

---

## Implementation Phases

### Phase 1 — Manual Handoff MVP (Week 1–2)
- JSONL session reader for Claude Code
- Context condensation via Claude Haiku
- Pending handoff file store
- Shell wrapper injection (`macc install`)
- `macc status` and `macc handoff` commands
- Works: `macc handoff` → `gemini` → full context

### Phase 2 — Auto Daemon + More Agents (Week 3–4)
- Background daemon with file watcher
- Auto-trigger at 95% threshold
- Cursor and Qoder adapters
- SQLite handoff history

### Phase 3 — Polish (Week 5)
- Config file (`~/.macc/config.json`)
- Desktop notifications
- WSL2 path normalization
- `npm publish` as global CLI

---

## Architecture Overview

See [ARCHITECTURE.md](./docs/ARCHITECTURE.md) for full module breakdown, data models, and adapter interface.

See [AGENTS.md](./docs/AGENTS.md) for per-agent adapter specs and context injection strategies.
