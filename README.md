# MACC — Multi-Agent Coding Client

[![GitHub Sponsors](https://img.shields.io/github/sponsors/zuriahn-yun?style=flat&label=Sponsor&logo=github)](https://github.com/sponsors/zuriahn-yun)

MACC is an AI coding assistant CLI that isn't locked to one model. It calls AI APIs directly, streams responses to your terminal, and tracks token usage in real time. When you're near the context limit, it compresses the session and seamlessly hands it off to a fresh model — same work, no lost progress.

## Why MACC?

Most AI coding assistants (Claude Code, Gemini CLI, Copilot) are locked to one provider. MACC lets you:

- **Start with Claude**, automatically compress and **continue with Gemini** when you hit the limit — no re-explaining context
- **Use any supported model** from the same interface with a consistent UX
- **Own your session** — MACC talks directly to APIs, so token counts are exact and nothing is hidden

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

## Pricing

| | Free | Pro ($49 one-time) |
|---|---|---|
| Context handoff | Unlimited | Unlimited |
| Supported agents | All | All |
| Fan-out parallelism | Up to 2 agents | Up to 10 agents |
| SQLite session history | — | Coming soon |
| Priority support | — | Discord channel |

**Get a Pro license:** [polar.sh/yunzuriahn/macc](https://polar.sh/yunzuriahn/macc)

After purchase, add your license key to `~/.macc/config.json`:

```json
{
  "licenseKey": "MACC-PRO-XXXXXXXX-YYYYYYYYYYYYYYYYYYYY"
}
```

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
