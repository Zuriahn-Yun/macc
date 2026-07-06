# MACC — Multi-Agent Coding Client

[![npm](https://img.shields.io/npm/v/@yunzuriahn/macc)](https://www.npmjs.com/package/@yunzuriahn/macc)
[![GitHub Sponsors](https://img.shields.io/github/sponsors/zuriahn-yun?style=flat&label=Sponsor&logo=github)](https://github.com/sponsors/zuriahn-yun)

**Stop losing your session when Claude Code hits the context limit.**

MACC watches your token usage in real time. When you're at 98%, it compresses your entire session — goal, decisions, files touched, what's next — and hands it off to a fresh agent. You keep coding. The new agent already knows everything.

Works with Claude Code, Gemini CLI, GPT-4o, and Codex. Runs from your terminal in 30 seconds.

```bash
npm install -g @yunzuriahn/macc && macc
```

---

## How it works

```
  ⚠  Context at 98% — 196,000 / 200,000 tokens used.

  Compress and continue with:
  [1] gemini-cli — recommended  (1M ctx, 0% used)
  [2] claude-code               (200k ctx, new session)

> 1

  Compressing session... done (2.3s)

  ┌─ Handoff summary ─────────────────────────────────┐
  │ Goal:   Fix auth middleware and write tests        │
  │ Done:   Reviewed auth.ts, found JWT bug on line 42 │
  │ Next:   Write failing test, fix validate()         │
  │ Files:  src/auth.ts, src/middleware.ts             │
  └───────────────────────────────────────────────────┘

  Starting gemini... Session context loaded.
```

The new agent starts with full context. No re-explaining, no lost progress.

## Install

```bash
npm install -g @yunzuriahn/macc
```

Requires Node.js 20+.

## Getting Started

Run `macc` and follow the first-time setup wizard:

```
$ macc

  MACC — First-time setup
  No credentials found. Log in to a provider to get started.

    [1] Claude (via Claude CLI)
    [2] Google Gemini (via gcloud)
    [3] Qodo (coming soon)

  > 1

  Opening browser for Claude login...
  [browser opens]

  Claude login successful.
```

MACC uses **your existing CLI logins** — no API keys to copy, paste, or rotate.

| Provider | Login method |
|---|---|
| Anthropic / Claude | `claude auth login` (Claude CLI) |
| Google / Gemini | `gcloud auth application-default login` |
| OpenAI | Set `OPENAI_API_KEY` environment variable |
| Qodo | Coming soon |

## Usage

```bash
# Pick an installed agent to launch
macc

# Launch a specific agent
macc start -a codex

# Show all agents and current context usage
macc status

# Open the live dashboard
macc watch
```

### In-session commands

```
/status    — show token usage breakdown
/model     — show current model
/switch    — manually trigger handoff menu
/help      — all commands
Ctrl+C     — exit
```

## Context Handoff

When your context reaches 90%, MACC warns you. At 98% it presents a handoff menu:

```
  ⚠  Context at 98% — 196,000 / 200,000 tokens used.

  Compress and continue with:
    [1] Gemini 2.5 Pro   (1M ctx — recommended)
    [2] Claude — new session

> 1

  Compressing session... done (2.1s)
  Switching to gemini-2.5-pro...
  Continuing from: "Fix auth middleware JWT validation"
```

The compression extracts the goal, key decisions, files touched, and pending tasks into a structured handoff so the next model starts with full context.

## Supported Models

| Provider | Models | Context |
|---|---|---|
| Anthropic | claude-sonnet-4-6, claude-opus-4-7, claude-haiku-4-5 | 200k |
| Google | gemini-2.5-pro, gemini-2.0-flash | 1M |
| OpenAI | gpt-4o, gpt-4o-mini, o1, o1-mini | 128k–200k |

**Support open-source development:** [GitHub Sponsors](https://github.com/sponsors/zuriahn-yun)

---

## Configuration

`~/.macc/config.json` (auto-created with defaults):

```json
{
  "defaultModel": "claude-sonnet-4-6",
  "warningThresholdPercent": 90,
  "autoPromptThresholdPercent": 98,
  "handoffOrder": ["gemini-2.5-pro", "claude-sonnet-4-6", "gpt-4o"]
}
```

## Security

- **No API keys stored** — MACC reads OAuth tokens from your existing CLI credential stores (`~/.claude/.credentials.json`, gcloud ADC). You never paste keys into MACC.
- **Credentials never logged** — tokens are read in-memory and never written to disk by MACC.
- **Least-privilege credential files** — if MACC creates any local files (e.g. `~/.macc/.env` for optional manual overrides), they are written with mode `0o600` (owner read/write only).
- **No telemetry** — MACC makes no outbound calls except to the AI provider APIs you explicitly log into.

## Architecture

See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).

## License

MIT
