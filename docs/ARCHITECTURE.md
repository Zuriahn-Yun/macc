# MACC Architecture

## Core Concept: Terminal Proxy

MACC is a terminal UI that sits between the user and AI coding agent subprocesses. The user always interacts with MACC — never directly with `claude`, `gemini`, etc. MACC manages subprocess lifecycle, proxies I/O, monitors usage, and switches agents transparently.

```
User input → MACC → subprocess stdin → Agent
                                       Agent → subprocess stdout → MACC → User terminal
```

---

## Project Structure

```
client-project/
├── package.json
├── tsconfig.json
├── .env.example
│
├── src/
│   ├── index.ts                      # CLI entry — launch MACC proxy client
│   │
│   ├── proxy/
│   │   ├── agent-proxy.ts            # Core: spawn subprocess, pipe I/O, kill, respawn
│   │   └── session-manager.ts        # Track active agent, handle switch sequence
│   │
│   ├── core/
│   │   ├── monitor.ts                # Watch usage, emit threshold events
│   │   ├── condenser.ts              # Condense session → HandoffPacket via Haiku
│   │   └── history.ts                # SQLite handoff record store
│   │
│   ├── adapters/
│   │   ├── base.ts                   # IAgentAdapter interface
│   │   ├── claude-code.ts            # ClaudeCodeAdapter
│   │   ├── gemini-cli.ts             # GeminiCliAdapter
│   │   ├── cursor.ts                 # CursorAdapter
│   │   ├── qoder.ts                  # QoderAdapter (stub)
│   │   └── registry.ts               # AdapterRegistry — keyed by id/command name
│   │
│   ├── extractors/
│   │   └── claude-session-reader.ts  # Parse ~/.claude/projects/**/*.jsonl
│   │
│   ├── ui/
│   │   ├── app.tsx                   # Root Ink component
│   │   ├── output-stream.tsx         # Scrollable agent output pane
│   │   ├── status-bar.tsx            # Bottom bar: agent name, usage %, model
│   │   └── input-line.tsx            # User input field with keybinding support
│   │
│   ├── commands/
│   │   ├── status.ts                 # macc status — non-interactive usage print
│   │   └── history.ts                # macc history — past handoffs
│   │
│   ├── models/
│   │   ├── session-context.ts        # SessionContext, ConversationTurn
│   │   ├── handoff-packet.ts         # HandoffPacket schema (zod)
│   │   └── agent-status.ts           # UsageSnapshot schema (zod)
│   │
│   └── utils/
│       ├── platform.ts               # WSL2 ↔ Linux ↔ Mac path normalization
│       └── config.ts                 # Load/validate ~/.macc/config.json
│
└── db/
    └── schema.sql                    # SQLite DDL for handoff_records
```

---

## Key Module: `proxy/agent-proxy.ts`

The heart of MACC. Responsibilities:
- Spawn the agent as a child process (`execa` or `node:child_process`)
- Pipe user terminal input → agent stdin
- Pipe agent stdout/stderr → MACC's output pane
- Handle `SIGWINCH` (terminal resize) and forward to child
- Expose `kill()` and `respawn(agent, handoffPacket)` for the session manager

```typescript
class AgentProxy extends EventEmitter {
  private proc: ChildProcess | null = null;

  async spawn(adapter: IAgentAdapter, initialPrompt?: string): Promise<void>;
  async kill(): Promise<void>;
  async respawn(adapter: IAgentAdapter, packet: HandoffPacket): Promise<void>;

  // Emits: 'output' (line), 'exit' (code), 'error' (err)
}
```

**Subprocess I/O mode**: Raw PTY mode using `node-pty` so that agent output (colors, cursor movement, interactive prompts) renders correctly in the MACC terminal.

---

## Key Module: `proxy/session-manager.ts`

Orchestrates the switch sequence:

```
[monitor emits 'threshold-crossed']
  → sessionManager.triggerHandoff()
    → proxy.collect last output snapshot
    → extractor.extractSessionContext()
    → condenser.condense(context) → HandoffPacket
    → history.record(handoff)
    → proxy.kill()
    → nextAdapter = registry.getNext(currentAdapter)
    → proxy.spawn(nextAdapter, handoffPacket.handoffPrompt)
    → statusBar.update(nextAdapter)
```

Total switch time target: < 3 seconds (condenser call is the bottleneck).

---

## Key Module: `IAgentAdapter` (adapters/base.ts)

```typescript
interface IAgentAdapter {
  readonly id: string;
  readonly commandName: string;        // e.g. "gemini"
  readonly displayName: string;        // e.g. "Gemini CLI"

  // Returns current usage snapshot — must be fast (file read, no API call)
  getUsageSnapshot(): Promise<UsageSnapshot>;

  // Extract full session context for condensation
  extractSessionContext(): Promise<SessionContext | null>;

  // Build the subprocess spawn args + optional initial stdin message
  buildSpawnConfig(packet?: HandoffPacket): {
    command: string;
    args: string[];
    initialStdin?: string;   // sent as first message after spawn
    cwd: string;
  };

  isRunning(): Promise<boolean>;
  getContextWindowSize(): number;
}
```

---

## Key Module: `extractors/claude-session-reader.ts`

Claude Code writes every turn to:
```
~/.claude/projects/<escaped-cwd>/<sessionId>.jsonl
```

`escaped-cwd` = `cwd.replace(/\//g, '-')`  
Example: `/mnt/c/Users/zuria/Projects` → `-mnt-c-Users-zuria-Projects`

**Active session detection**: sort `.jsonl` files by `mtime`, take newest.

**JSONL entry types handled:**

| `type` | Action |
|---|---|
| `assistant` | Extract text + tool_use blocks; read `usage.input_tokens` |
| `user` | Extract content as ConversationTurn |
| `last-prompt` | Store as `sessionContext.lastPrompt` |
| `custom-title` | Store as `sessionContext.sessionTitle` |
| `file-history-snapshot` | Keys → filesModified |

**Usage accuracy**: Use `input_tokens` of the **last** assistant entry — this reflects what was actually sent to the model in that turn, not a cumulative sum.

**Subagent sessions**: Nested at `<sessionId>/subagents/agent-<id>.jsonl` — aggregate their token counts into the parent session total.

---

## Key Module: `condenser.ts`

```
Input:  SessionContext
Output: HandoffPacket (zod-validated JSON)
```

Calls `claude-haiku-4-5` with structured extraction prompt. Target: < 2s round trip.

Extracts:
1. Ultimate goal
2. Current task state (done / next step)
3. Key decisions and rationale
4. Open blockers
5. Files of interest (path + reason: modified/read/mentioned)
6. `handoffPrompt` — ≤500 words, ready to send as first message to next agent

---

## UI Layout

Built with [Ink](https://github.com/vadimdemedes/ink) (React for CLIs).

```
┌──────────────────────────────────────────────────────────────┐
│  MACC                                              v0.1.0    │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  [agent output scrolls here]                                 │
│  [agent output scrolls here]                                 │
│  [agent output scrolls here]                                 │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│  Claude Code  ████████████████████░░  94%  200k ctx         │
├──────────────────────────────────────────────────────────────┤
│  > _                                                         │
└──────────────────────────────────────────────────────────────┘
```

Components:
- `output-stream.tsx` — scrollable output pane, renders agent stdout with ANSI colors
- `status-bar.tsx` — agent name, usage bar, token count, model label; turns yellow at 80%, red at 95%
- `input-line.tsx` — text input forwarded to agent stdin; captures keybindings before forwarding

---

## Data Models

### `SessionContext`
```typescript
interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: { name: string; input: Record<string, unknown>; result?: string }[];
  timestamp: Date;
  tokenCount?: number;
}

interface SessionContext {
  agentId: string;
  sessionId: string;
  cwd: string;
  gitBranch?: string;
  startedAt: Date;
  lastActivityAt: Date;
  turns: ConversationTurn[];
  totalInputTokens: number;
  totalOutputTokens: number;
  filesModified: string[];
  filesRead: string[];
  lastPrompt?: string;
  sessionTitle?: string;
}
```

### `HandoffPacket`
```typescript
interface HandoffPacket {
  version: '1';
  createdAt: string;
  sourceAgent: string;
  sessionId: string;
  cwd: string;
  gitBranch?: string;
  summary: {
    ultimateGoal: string;
    currentTaskState: string;
    keyDecisions: string[];
    blockers: string[];
  };
  filesOfInterest: Array<{ path: string; reason: 'modified' | 'read' | 'mentioned' }>;
  handoffPrompt: string;   // Ready-to-use first message for the incoming agent
}
```

### `UsageSnapshot`
```typescript
interface UsageSnapshot {
  agentId: string;
  isRunning: boolean;
  contextUsedPercent: number;   // 0–100
  inputTokensLastTurn: number;
  contextWindowSize: number;
  nearLimit: boolean;           // > 80%
  overLimit: boolean;           // > 95%
  timestamp: Date;
}
```

---

## Technology Stack

| Concern | Choice |
|---|---|
| Language | TypeScript (Node.js 20+) |
| Terminal UI | `ink` + `react` |
| Subprocess PTY | `node-pty` (preserves ANSI, interactive prompts) |
| CLI routing | `commander` |
| AI condensation | `@anthropic-ai/sdk` (Haiku model) |
| Session file watch | `chokidar` |
| Schema validation | `zod` |
| SQLite history | `better-sqlite3` |
| Config loading | `cosmiconfig` |

---

## Config File — `~/.macc/config.json`

```json
{
  "version": 1,
  "defaultAgent": "claude-code",
  "agentPriorityOrder": ["claude-code", "gemini-cli", "cursor"],
  "agents": {
    "claude-code": {
      "enabled": true,
      "warningThresholdPercent": 80,
      "autoHandoffThresholdPercent": 95,
      "contextWindowTokens": 200000
    },
    "gemini-cli": {
      "enabled": true,
      "warningThresholdPercent": 70,
      "autoHandoffThresholdPercent": 90
    },
    "cursor": { "enabled": false },
    "qoder": { "enabled": false }
  },
  "condensation": {
    "model": "claude-haiku-4-5",
    "maxHandoffPromptTokens": 4000
  },
  "historyPath": "~/.macc/handoffs/"
}
```

---

## SQLite Schema

```sql
CREATE TABLE handoff_records (
  id           TEXT PRIMARY KEY,
  timestamp    TEXT NOT NULL,
  from_agent   TEXT NOT NULL,
  to_agent     TEXT NOT NULL,
  reason       TEXT NOT NULL,  -- 'auto-threshold' | 'manual' | 'agent-offline'
  session_id   TEXT NOT NULL,
  cwd          TEXT NOT NULL,
  packet_json  TEXT NOT NULL,
  success      INTEGER NOT NULL,
  error_msg    TEXT
);
```

---

## WSL2 Path Normalization

On WSL2, Claude Code uses Linux paths. `platform.ts` normalizes both forms:

```
Windows:  C:\Users\zuria\Projects\foo
WSL:      /mnt/c/Users/zuria/Projects/foo
Escaped:  -mnt-c-Users-zuria-Projects-foo
```

Detect WSL2 with `os.release().toLowerCase().includes('microsoft')`.
