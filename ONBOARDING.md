# Welcome to MACC

## What We're Building

MACC is a free, open-source multi-agent coding client. It wraps Claude Code, Gemini CLI, Codex, and Qodo — when one hits a usage limit or runs out of credits mid-session, MACC automatically compresses the conversation and continues in the next available agent. No prompts, no lost context.

Core value: **stop losing work when Claude hits its limit.**

## How Claude Code is Used Here

MACC is built entirely with Claude Code. Primary work types:
- Feature implementation (~75%)
- Architecture and planning (~25%)

Useful slash commands when working in this repo:
- `/compact` — compress context before switching tasks in a long session
- `/context` — check how much context is left

## Codebase Quick Start

```bash
git clone https://github.com/zuriahn-yun/macc
cd macc
npm install
npm test          # 204 tests
npm run build     # tsc → dist/
```

### Key files to know

| File | What it does |
|---|---|
| `src/index.ts` | CLI entry point (all `macc` commands) |
| `src/core/orchestrator.ts` | Main loop — spawns agents, monitors stderr, triggers switch |
| `src/utils/errors.ts` | Detects usage limits and credit exhaustion from stderr patterns |
| `src/utils/agent-state.ts` | Persists pause state to `~/.macc/pauses.json` |
| `src/core/compressor.ts` | Compresses sessions into `HandoffPacket` using AI backends |
| `src/adapters/claude.ts` | Reads Claude Code's JSONL session files |
| `CLAUDE.md` | Full work tracking — bugs, features, architecture notes |
| `PLAN.md` | Architecture reference — module map, data flows, error patterns |

## Development Workflow

1. `npm test` — run before and after every change
2. `npm run build` — verify TypeScript compiles clean
3. Check `CLAUDE.md` for open items and current status
4. Commit with clear messages; push to feature branch

## Open Items

See `CLAUDE.md` → Work Tracking for the full list. Current open items:
- **MISSING-02** — Qodo setup wizard login (needs investigation of `qodercli auth`)
- **MISSING-04** — Remove `better-sqlite3` dependency or implement SQLite session history
- **MONETIZE-01** — GitHub Sponsors setup at github.com/sponsors (button is live, just needs account activation)
