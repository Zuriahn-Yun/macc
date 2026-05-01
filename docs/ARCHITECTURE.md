# MACC Architecture

## Core Design

MACC is a REPL-style CLI that calls AI APIs directly. It is not a wrapper around existing CLIs. This gives it exact token counts, streaming control, and the ability to compress and switch models mid-session.

```
User types → MACC REPL → AI Backend (Anthropic/Gemini/OpenAI SDK)
                              ↓
                    Streaming response to terminal
                              ↓
                    Token usage tracked from API response
                              ↓
                    At 98%: compress → switch model → continue
```

---

## Project Structure

```
client-project/
├── package.json
├── tsconfig.json
├── .env.example
├── install.sh                        # One-line curl installer
│
├── src/
│   ├── index.ts                      # Entry point — parse args, launch REPL
│   │
│   ├── repl/
│   │   ├── session.ts                # REPL loop: readline, input handling, render
│   │   ├── renderer.ts               # Stream response to terminal, format output
│   │   └── commands.ts               # Slash command router (/status, /switch, etc.)
│   │
│   ├── backends/
│   │   ├── base.ts                   # IModelBackend interface
│   │   ├── anthropic.ts              # Anthropic SDK — Claude models
│   │   ├── gemini.ts                 # Google GenAI SDK — Gemini models
│   │   ├── openai.ts                 # OpenAI-compatible (GPT-4o, Ollama, etc.)
│   │   └── registry.ts               # Model ID → backend mapping
│   │
│   ├── core/
│   │   ├── context-store.ts          # Conversation history + cumulative token tracking
│   │   ├── compressor.ts             # Compress full context → HandoffPacket
│   │   └── handoff.ts                # Orchestrate compress → switch → continue
│   │
│   ├── models/
│   │   ├── message.ts                # Message, ConversationTurn
│   │   ├── handoff-packet.ts         # HandoffPacket schema (zod)
│   │   └── usage.ts                  # TokenUsage, UsageSnapshot schemas (zod)
│   │
│   ├── commands/
│   │   ├── config.ts                 # macc config [set key value]
│   │   └── setup.ts                  # macc setup — first-run wizard
│   │
│   ├── persistence/
│   │   ├── history.ts                # SQLite handoff_records
│   │   └── session-store.ts          # Save/resume conversation state
│   │
│   └── utils/
│       ├── config.ts                 # Load ~/.macc/config.json
│       ├── platform.ts               # OS detection, path helpers
│       └── display.ts                # Terminal colors, progress bars, spinners
│
└── db/
    └── schema.sql
```

---

## Key Module: `backends/base.ts`

```typescript
interface StreamChunk {
  text: string;
  usage?: { inputTokens: number; outputTokens: number };
  done: boolean;
}

interface IModelBackend {
  readonly modelId: string;
  readonly contextWindowTokens: number;
  readonly provider: 'anthropic' | 'google' | 'openai';

  // Stream a response given the full conversation history
  stream(
    messages: Message[],
    systemPrompt: string,
    onChunk: (chunk: StreamChunk) => void
  ): Promise<{ inputTokens: number; outputTokens: number }>;

  // Is this model available (API key present, model ID valid)?
  isAvailable(): Promise<boolean>;
}
```

One backend per provider. Adding a new model is one registry entry — no new backend needed if the provider is already supported.

---

## Key Module: `core/context-store.ts`

Owns the conversation history and all token tracking.

```typescript
class ContextStore {
  private messages: Message[] = [];
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private contextWindowSize: number;

  addUserMessage(text: string): void;
  addAssistantMessage(text: string, usage: TokenUsage): void;

  getUsagePercent(): number;    // (totalInputTokens / contextWindowSize) * 100
  isNearLimit(threshold: number): boolean;

  getMessages(): Message[];     // full history for next API call
  getSnapshot(): UsageSnapshot;
}
```

Token totals come directly from the API response `usage` field on every turn — no estimation.

---

## Key Module: `core/compressor.ts`

Called when usage crosses the threshold (default 98%).

```
Input:  ContextStore (full conversation history)
Output: HandoffPacket
```

Calls the configured compression model (default: `claude-haiku-4-5`) with a structured extraction prompt:

```
You are compressing a coding session for handoff to a new AI model.
Extract from this conversation:
1. The user's ultimate goal (one sentence)
2. What has been completed so far
3. The very next step to take
4. Key decisions made and why (bullet list)
5. Open blockers or warnings
6. Files created or modified (paths only)
7. A handoff prompt (≤ 400 words) the new model should receive as its first message
```

Returns a `HandoffPacket` (validated with zod). The `handoffPrompt` field becomes the system prompt seed for the new model session.

---

## Key Module: `core/handoff.ts`

Orchestrates the full switch sequence when threshold is hit:

```
1. contextStore.isNearLimit(98) → true

2. Show warning in terminal:
   "⚠  Context at 98% — 196,000 / 200,000 tokens used."

3. Present model menu (from config.handoffOrder):
   [1] Gemini 2.5 Pro  (recommended — 1M ctx)
   [2] Claude — new session
   [3] GPT-4o
   [4] Stay here

4. User selects → compressor.compress(contextStore) → HandoffPacket

5. New ContextStore created with:
   - Fresh message history
   - System prompt = HandoffPacket.handoffPrompt
   - contextWindowSize = new model's window

6. history.record(handoffRecord)

7. REPL continues with new backend — user sees:
   "Switching to Gemini 2.5 Pro... done.
    Continuing: 'Fix auth middleware JWT validation'"
```

---

## REPL Flow (`repl/session.ts`)

```
launch()
  → load config
  → resolve model backend from args or config.defaultModel
  → initialize ContextStore
  → print welcome header
  → readline loop:
      read user input
        → if slash command: commands.handle(input)
        → else: 
            contextStore.addUserMessage(input)
            renderer.beginStream()
            backend.stream(messages, systemPrompt, onChunk)
              → onChunk: renderer.appendChunk(text)
              → on done: contextStore.addAssistantMessage(fullText, usage)
            renderer.endStream()
            display usage bar
            if contextStore.isNearLimit(warningThreshold): warn()
            if contextStore.isNearLimit(autoPromptThreshold): handoff.prompt()
```

---

## Streaming to Terminal

MACC streams token-by-token to the terminal (same as Claude Code / Gemini CLI). The renderer writes directly to `process.stdout` — no buffering.

```typescript
// renderer.ts
function appendChunk(text: string): void {
  process.stdout.write(text);
}

function endStream(usage: TokenUsage): void {
  process.stdout.write('\n\n');
  printUsageBar(usage);
}
```

Usage bar after each response:
```
  Context: 47%  ████████████░░░░░░░░░░  94,000 / 200,000 tokens
```
Turns yellow at 90%, red at 98%.

---

## Data Models

### `Message`
```typescript
interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  usage?: { inputTokens: number; outputTokens: number };
}
```

### `HandoffPacket`
```typescript
interface HandoffPacket {
  version: '1';
  createdAt: string;
  fromModel: string;
  toModel: string;
  cwd: string;
  gitBranch?: string;
  summary: {
    ultimateGoal: string;
    completedWork: string;
    nextStep: string;
    keyDecisions: string[];
    blockers: string[];
    filesModified: string[];
  };
  handoffPrompt: string;   // Injected as system prompt for new session
}
```

### `UsageSnapshot`
```typescript
interface UsageSnapshot {
  modelId: string;
  contextWindowTokens: number;
  inputTokensUsed: number;
  outputTokensUsed: number;
  usagePercent: number;
  nearLimit: boolean;    // > warningThreshold
  overLimit: boolean;    // > autoPromptThreshold
}
```

---

## Install Script (`install.sh`)

```bash
#!/usr/bin/env bash
set -e

echo "Installing MACC..."

# Require node >= 20
node_version=$(node -v 2>/dev/null | cut -d'v' -f2 | cut -d'.' -f1)
if [ -z "$node_version" ] || [ "$node_version" -lt 20 ]; then
  echo "Error: Node.js 20+ required. Install from https://nodejs.org"
  exit 1
fi

npm install -g macc

echo ""
echo "✓ MACC installed. Run: macc"
echo "  On first run, you'll be prompted for your API keys."
```

---

## First-Run Setup

On first launch (no config found), MACC runs the setup wizard:

```
MACC — First-time setup

Which AI provider do you want to start with?
  [1] Anthropic (Claude) — recommended
  [2] Google (Gemini)
  [3] OpenAI

> 1

Enter your Anthropic API key (or set ANTHROPIC_API_KEY env var):
> sk-ant-...

Config saved to ~/.macc/config.json
API key saved to ~/.macc/.env (add to your shell profile for persistence)

Ready. Type `macc` to launch.
```

---

## Technology Stack

| Concern | Choice |
|---|---|
| Language | TypeScript (Node.js 20+) |
| Anthropic API | `@anthropic-ai/sdk` |
| Google Gemini | `@google/genai` |
| OpenAI-compatible | `openai` SDK |
| Terminal input | `readline` (built-in) |
| Terminal colors | `chalk` |
| Schema validation | `zod` |
| SQLite history | `better-sqlite3` |
| Config | `cosmiconfig` |
| Packaging | `pkg` or `esbuild` → single binary |

---

## SQLite Schema

```sql
CREATE TABLE handoff_records (
  id           TEXT PRIMARY KEY,
  timestamp    TEXT NOT NULL,
  from_model   TEXT NOT NULL,
  to_model     TEXT NOT NULL,
  reason       TEXT NOT NULL,   -- 'threshold' | 'manual'
  cwd          TEXT NOT NULL,
  packet_json  TEXT NOT NULL,
  success      INTEGER NOT NULL,
  error_msg    TEXT
);

CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  started_at   TEXT NOT NULL,
  last_active  TEXT NOT NULL,
  model_id     TEXT NOT NULL,
  cwd          TEXT NOT NULL,
  messages_json TEXT NOT NULL,
  total_input_tokens INTEGER NOT NULL,
  total_output_tokens INTEGER NOT NULL
);
```
