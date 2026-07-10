# MACC — Architecture Reference

## What It Is

MACC (Multi-Agent Coding Client) is a **meta-wrapper** around AI coding CLI tools. It doesn't call AI APIs for coding — it spawns Claude Code, Gemini CLI, Codex, and Qodo as child processes and monitors them. When something goes wrong (usage limit, credits exhausted, context full), MACC compresses the session and hands it off to the next agent.

---

## Core Design

### What MACC is NOT

MACC is not a REPL or a coding assistant itself. It does not stream AI responses to your terminal. The agent CLI (Claude Code, Gemini, etc.) owns the terminal and does all the coding work.

### What MACC IS

MACC is:
1. A **process monitor** — spawns agent CLIs and watches their stderr for error patterns
2. A **context extractor** — reads the agent's JSONL session files to get conversation history
3. A **compression engine** — calls AI APIs (Anthropic, Gemini, OpenAI) to summarize sessions into structured `HandoffPacket`s
4. A **handoff orchestrator** — launches the next agent with the compressed context as its first message

---

## Module Map

```
src/
  index.ts              CLI entry point (commander)
  core/
    orchestrator.ts     Main loop: spawn → monitor → detect → compress → switch
    compressor.ts       AI-assisted session compression + raw fallback
    context-store.ts    In-memory message store for compression
    fanout.ts           Parallel task decomposition across multiple agents
  adapters/
    base.ts             IAgentAdapter interface
    claude.ts           Claude Code — reads ~/.claude/projects/**/*.jsonl
    gemini.ts           Gemini CLI — reads ~/.gemini/tmp/**/chats/session-*.jsonl
    codex.ts            OpenAI Codex — reads ~/.codex/sessions/**/*.jsonl
    qodo.ts             Qodo — reads ~/.qoder/projects/**/*.jsonl
    generic.ts          User-defined agents via ~/.macc/agents.json
    registry.ts         allAdapters() / discoverAdapters()
  backends/
    base.ts             IModelBackend interface
    anthropic.ts        Anthropic SDK — claude-sonnet-4-6, opus, haiku
    gemini.ts           Google GenAI SDK — gemini-2.5-pro, 2.0-flash
    openai.ts           OpenAI SDK — gpt-4o, gpt-4o-mini
    registry.ts         MODEL_MAP, detectAllAvailableBackends()
  utils/
    errors.ts           CREDIT_PATTERNS, USAGE_LIMIT_PATTERNS, detectExitReason(), parseResetTime()
    agent-state.ts      Pause records persisted to ~/.macc/pauses.json
    display.ts          Terminal output helpers (chalk-based)
    config.ts           ~/.macc/config.json loading (cosmiconfig)
    license.ts          HMAC-SHA256 offline license validation (inactive — MACC is free)
  auth/
    credentials.ts      Reads OAuth tokens from CLI stores (Claude, gcloud ADC)
  models/
    handoff-packet.ts   HandoffPacket schema (Zod)
    message.ts          Message type
    usage.ts            UsageSnapshot type
  commands/
    setup.ts            First-run setup wizard
```

---

## Key Data Flows

### Auto-switch on usage limit / credit exhaustion

```
agent process (claude)
  │
  ├─ stdout ──────────────────────────────────────── inherited → user's terminal
  ├─ stdin  ──────────────────────────────────────── inherited → user's keyboard
  └─ stderr ──── piped to MACC ──┬── forwarded ──── process.stderr → user sees it
                                 └── buffered ────── stderrBuffer

on exit:
  detectExitReason(stderrBuffer) → 'usage-limit' | 'credits-exhausted' | 'normal'
  parseResetTime(stderrBuffer) → Date | null
  recordAgentPaused(agentId, reason, resetAt)
  auto-pick targets[0], skip interactive menu
  compressWithFallback([gemini, openai, ...], ...) → HandoffPacket
  spawn next agent with handoffPrompt
```

### Session compression

```
adapter.extractSessionContext()
  → reads *.jsonl from agent's session directory
  → returns { messages[], cwd, inputTokensUsed }

compressWithFallback(backends, store, toModel, cwd, sourceProvider?)
  → orders backends: non-source-provider first
  → tries each in sequence:
      compressContext(backend, store, toModel, cwd)
        → formats conversation text
        → calls backend.stream() with COMPRESSION_PROMPT
        → parses JSON from response → HandoffPacket (Zod validated)
  → fallback: rawHandoffFallback() (last 30 messages, no AI)

new agent launched:
  spawn(agent.commandName, [...baseArgs, packet.handoffPrompt])
```

---

## Session File Formats

Each adapter reads a different JSONL format:

| Agent | Path | Format |
|---|---|---|
| Claude Code | `~/.claude/projects/<cwd-hash>/<session-id>.jsonl` | `{ type: 'user'|'assistant', message: { content: ContentBlock[], usage } }` |
| Gemini CLI | `~/.gemini/tmp/<hash>/chats/session-*.jsonl` | `{ type: 'user'|'gemini', content: PartListUnion, tokens: { total } }` |
| OpenAI Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | `{ type: 'event_msg'|'response_item', payload: {...} }` |
| Qodo | `~/.qoder/projects/<cwd-hash>/*.jsonl` | Same as Claude Code |

---

## Error Pattern Coverage

`src/utils/errors.ts` contains two pattern sets:

**CREDIT_PATTERNS** (permanent — switch providers, no recovery):
- Anthropic: `insufficient_quota`, `exceeded budget`
- Google: `billing not enabled`, `free tier exceeded`
- OpenAI: `you exceeded your current quota`, `check your plan and billing`
- Generic: `payment required`, `account suspended`, `no funds`

**USAGE_LIMIT_PATTERNS** (temporary — recover after reset time):
- Anthropic: `rate_limit_error`, `daily rate limit`, `plan's usage`
- Google: `RESOURCE_EXHAUSTED`, `User Rate Limit Exceeded`, `GenerateRequestsPerDay/PerMinute`
- OpenAI: `rate_limit_exceeded`, `Rate limit reached for`, `please try again in`
- Generic: `usage limit`, `limit reached`, `too many requests`, `try again at/in`

---

## Configuration

`~/.macc/config.json`:

```json
{
  "defaultModel": "claude-sonnet-4-6",
  "warningThresholdPercent": 90,
  "autoPromptThresholdPercent": 98,
  "compressionModel": "claude-haiku-4-5",
  "handoffOrder": ["gemini-2.5-pro", "claude-sonnet-4-6", "gpt-4o"]
}
```

State files written by MACC:
- `~/.macc/running.pid` — PID of the current MACC session (for `macc switch`)
- `~/.macc/switch-target` — agent ID written by `macc switch <agent>` command
- `~/.macc/pauses.json` — pause records with reason and reset time
- `~/.macc/agents.json` — user-defined custom agent configs
