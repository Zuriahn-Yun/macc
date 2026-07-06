# MACC — Multi-Agent Coding Client

[![npm](https://img.shields.io/npm/v/@yunzuriahn/macc)](https://www.npmjs.com/package/@yunzuriahn/macc)
[![GitHub Sponsors](https://img.shields.io/github/sponsors/zuriahn-yun?style=flat&label=Sponsor&logo=github)](https://github.com/sponsors/zuriahn-yun)

**Stop losing your session when Claude hits its usage limit.**

You're deep in a task. Claude Code hits its hourly rate limit or exhausts your plan's credits. Normally that means: stop, wait, lose context, start over. MACC detects the error, compresses your full session — goal, decisions, files touched, what's next — and hands it off to Gemini (or any other agent you have configured). You keep coding. The new agent already knows everything.

Works with **Claude Code, Gemini CLI, OpenAI Codex, and Qodo**. Runs from your terminal in 30 seconds.

```bash
npm install -g @yunzuriahn/macc && macc
```

---

## What MACC does

### Auto-switch on usage limits and credit exhaustion

When Claude Code hits its limit mid-session, you normally see an error and stop cold. MACC intercepts it:

```
  ⏸  Usage limit hit on claude-code.
     claude-code resets at 8:00 PM.
     Automatically continuing on gemini-cli...

  Compressing session... done (2.1s)

  ┌─ Handoff summary ─────────────────────────────────┐
  │ Goal:   Fix auth middleware and write tests        │
  │ Done:   Reviewed auth.ts, found JWT bug on line 42 │
  │ Next:   Write failing test, fix validate()         │
  │ Files:  src/auth.ts, src/middleware.ts             │
  └───────────────────────────────────────────────────┘

  Starting gemini-cli... Session context loaded.
```

No prompts. No menu. It just switches and picks up where you left off.

When Claude's limit resets, MACC tells you:

```
  ✓  claude-code is available again.
```

### Also handles context window handoffs

When your context fills up, MACC presents a menu so you can continue in a fresh agent:

```
  ⚠  Context at 98% — 196,000 / 200,000 tokens used.

  Compress and continue with:
  [1] gemini-cli — (1M ctx, 0% used)
  [2] claude-code — new session

> 1
```

### Context is always preserved

Whether switching due to a usage limit or a full context window, MACC compresses the entire session using AI-assisted summarization:

- **What were you building** — the ultimate goal
- **What was completed** — all work done so far
- **What's next** — the single most important next step
- **Key decisions** — why things were done the way they were
- **Files modified** — exact paths that changed
- **Git state** — current diff and recent commits

The new agent starts with a full briefing and continues immediately.

---

## Install

```bash
npm install -g @yunzuriahn/macc
```

Requires Node.js 20+.

## Getting Started

MACC uses your existing CLI logins — no API keys to copy, paste, or rotate.

| Provider | How to log in |
|---|---|
| Anthropic / Claude | `claude auth login` (Claude Code CLI) |
| Google / Gemini | `gcloud auth application-default login` |
| OpenAI | Set `OPENAI_API_KEY` environment variable |
| Qodo | Install `qodercli` (no extra auth needed) |

Then run:

```bash
macc
```

MACC shows all installed agents and lets you pick one to start. From there, it monitors your session and acts automatically if a limit is hit.

---

## Commands

```bash
# Pick an installed agent to start
macc

# Start a specific agent
macc start -a gemini-cli

# Show context usage across all agents
macc status

# Open the live dashboard
macc watch

# Compress the current session and hand off to another agent
macc handoff

# Switch mid-session without exiting
macc switch
macc switch gemini-cli   # jump directly to a specific agent

# Add a custom agent (Aider, Cursor, etc.)
macc agent add
macc agent list
macc agent remove <id>
```

---

## Supported Agents

| Agent | CLI binary | Install |
|---|---|---|
| Claude Code | `claude` | `npm install -g @anthropic-ai/claude-code` |
| Gemini CLI | `gemini` | `npm install -g @google/gemini-cli` |
| OpenAI Codex | `codex` | `npm install -g @openai/codex` |
| Qodo | `qodercli` | `npm install -g @qoder-ai/qodercli` |
| Custom | any CLI | `macc agent add` |

---

## Supported Models (for compression)

MACC uses these models to compress sessions when handing off. You need credentials for at least one.

| Provider | Models | Context |
|---|---|---|
| Anthropic | claude-sonnet-4-6, claude-opus-4-7, claude-haiku-4-5 | 200k |
| Google | gemini-2.5-pro, gemini-2.0-flash | 1M |
| OpenAI | gpt-4o, gpt-4o-mini | 128k |

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

---

## Security

- **No API keys stored** — MACC reads OAuth tokens from your existing CLI credential stores (`~/.claude/.credentials.json`, gcloud ADC). You never paste keys into MACC.
- **Credentials never logged** — tokens are read in-memory and never written to disk by MACC.
- **No telemetry** — MACC makes no outbound calls except to the AI provider APIs you explicitly log into.

---

## Architecture

See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).

## License

MIT — free forever.

**Support open-source development:** [GitHub Sponsors](https://github.com/sponsors/zuriahn-yun)
