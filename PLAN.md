# MACC — Multi-Agent Coding Client

## What It Is

MACC is an AI coding assistant CLI — like Claude Code or Gemini CLI, but not locked to one model. You install it once and use it as your daily driver. Under the hood it calls AI APIs directly (Anthropic, Google, OpenAI-compatible), streams responses to your terminal, and tracks token usage from every response.

When you hit 98% of the context window, MACC warns you, compresses the session into a compact handoff, and lets you continue in a fresh context with any supported model — same session, no lost work.

---

## Install & Launch

```bash
# Install globally
npm install -g macc

# Or one-line install script
curl -fsSL https://get.macc.dev/install.sh | sh

# Launch
macc
```

It feels like Claude Code or Gemini CLI — type a message, get a streaming response, keep working.

---

## The Experience

```
$ macc

  MACC v0.1.0 — Multi-Agent Coding Client
  Model: claude-sonnet-4-6  |  Context: 0%
  Type /help for commands, Ctrl+C to exit.

> Fix the auth middleware so it validates JWTs properly

  I'll look at your middleware and fix the JWT validation...
  [streams response]

  Context: 12%  ████░░░░░░░░░░░░░░░░░░  24,000 / 200,000 tokens

> [continues working normally...]

  ⚠  Context at 98% — 196,000 / 200,000 tokens used.

  Compress and continue with:
    [1] Gemini 2.5 Pro   (1M ctx — recommended)
    [2] Claude — new session
    [3] GPT-4o
    [4] Stay here (no more room)

> 1

  Compressing session... done (2.1s)
  Switching to Gemini 2.5 Pro...

  MACC — Gemini 2.5 Pro  |  Context: 0%
  Continuing from previous session: "Fix auth middleware JWT validation"

> [keeps working — Gemini has full context from the compressed handoff]
```

---

## How It Works

MACC owns the API calls — it's not wrapping another CLI. This means:

1. **Token tracking is exact** — every API response includes `usage.input_tokens` and `usage.output_tokens`. MACC reads these directly.
2. **Compression is built-in** — at 98%, MACC calls a fast cheap model (Haiku, Gemini Flash) with the full conversation and extracts a structured summary.
3. **Handoff is seamless** — the next model starts with a compressed context prompt that contains the goal, decisions, current state, files touched, and what to do next.
4. **Any model** — adding a new AI provider = one new backend module.

---

## Supported Models (MVP)

| Provider | Models | Context Window |
|---|---|---|
| Anthropic | claude-sonnet-4-6, claude-opus-4-7, claude-haiku-4-5 | 200k |
| Google | gemini-2.5-pro, gemini-2.0-flash | 1M+ |
| OpenAI-compatible | gpt-4o, local models (Ollama) | varies |

---

## Commands

```bash
# Launch with default model (from config)
macc

# Launch with specific model
macc --model gemini-2.5-pro
macc --model claude-opus-4-7

# Resume a previous session
macc --resume

# One-shot (non-interactive)
macc --print "explain this codebase"

# Manage config
macc config
macc config set default-model gemini-2.5-pro
```

**In-session slash commands:**
```
/status      — show token usage breakdown
/switch      — manually trigger model switch menu
/compress    — compress context now without switching
/history     — show past handoffs in this project
/model       — change model mid-session
/help        — all commands
```

---

## Configuration

`~/.macc/config.json`:

```json
{
  "defaultModel": "claude-sonnet-4-6",
  "warningThresholdPercent": 90,
  "autoPromptThresholdPercent": 98,
  "compressionModel": "claude-haiku-4-5",
  "handoffOrder": ["gemini-2.5-pro", "claude-sonnet-4-6", "gpt-4o"],
  "apiKeys": {
    "anthropic": "from ANTHROPIC_API_KEY env",
    "google": "from GOOGLE_API_KEY env",
    "openai": "from OPENAI_API_KEY env"
  }
}
```

API keys are read from environment variables — never stored in config.

---

## Implementation Phases

### Phase 1 — Working CLI (Week 1–2) ✅
- ✅ `macc` launches and connects to Claude (Anthropic SDK)
- ✅ Streaming responses to terminal
- ✅ Token tracking from API response `usage` field
- ✅ `/status` command shows usage %
- ✅ Warning at 98% with model switch menu
- ✅ Basic compression via any available backend + handoff to next model

### Phase 2 — Multi-Model + Polish (Week 3–4) 🔄
- ✅ Google Gemini backend (`@google/genai`)
- ✅ `macc --model` flag, `macc models` command
- ✅ Auto-detect available backend on startup (tries env vars in order)
- ✅ Compressor refactored to use any backend (not hardcoded to Haiku); optional native `compress()` hook on backends
- ⬜ OpenAI-compatible backend
- ⬜ Session persistence (continue where you left off)
- ⬜ SQLite handoff history, `/history` command

### Phase 3 — Install + Distribution (Week 5) 🔄
- ✅ First-run setup wizard (provider selection + API key prompt, persists to `~/.macc/.env`)
- ⬜ `npm publish` as `macc`
- ⬜ One-line install script (`curl | sh`)
- ⬜ Auto-update check on launch
- ⬜ Homebrew formula (macOS)

---

## Architecture Overview

See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) — module breakdown, streaming design, compression engine, and model backend interface.
