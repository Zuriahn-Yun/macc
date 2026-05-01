# MACC Architecture

## Project Structure

```
client-project/
├── package.json
├── tsconfig.json
├── .env.example
│
├── src/
│   ├── index.ts                      # CLI entry — commander routing
│   │
│   ├── core/
│   │   ├── monitor.ts                # Daemon: polls usage, emits threshold events
│   │   ├── condenser.ts              # Calls AI to shrink session → HandoffPacket
│   │   └── history.ts                # SQLite store of all handoff records
│   │
│   ├── adapters/
│   │   ├── base.ts                   # IAgentAdapter interface
│   │   ├── claude-code.ts            # ClaudeCodeAdapter
│   │   ├── gemini-cli.ts             # GeminiCliAdapter
│   │   ├── cursor.ts                 # CursorAdapter
│   │   ├── qoder.ts                  # QoderAdapter (stub)
│   │   └── registry.ts               # AdapterRegistry — keyed by command name
│   │
│   ├── extractors/
│   │   └── claude-session-reader.ts  # Parse ~/.claude/projects/**/*.jsonl
│   │
│   ├── commands/
│   │   ├── start.ts                  # macc start — daemon
│   │   ├── status.ts                 # macc status — usage %
│   │   ├── handoff.ts                # macc handoff [agent] — manual trigger
│   │   ├── install.ts                # macc install — shell wrappers
│   │   └── history.ts                # macc history — past handoffs
│   │
│   ├── shell/
│   │   └── wrapper-template.sh       # Template for per-agent shell function
│   │
│   ├── models/
│   │   ├── session-context.ts        # SessionContext, ConversationTurn
│   │   ├── handoff-packet.ts         # HandoffPacket schema (zod)
│   │   └── agent-status.ts           # UsageSnapshot schema (zod)
│   │
│   └── utils/
│       ├── platform.ts               # WSL2 ↔ Linux ↔ Mac path normalization
│       └── pending-store.ts          # ~/.macc/pending/<hash>.json I/O
│
└── db/
    └── schema.sql                    # SQLite DDL
```

---

## Key Modules

### `IAgentAdapter` (adapters/base.ts)

```typescript
interface IAgentAdapter {
  readonly id: string;
  readonly commandName: string;        // matches shell wrapper name e.g. "gemini"

  getUsageSnapshot(): Promise<UsageSnapshot>;
  extractSessionContext(): Promise<SessionContext | null>;
  buildLaunchArgs(packet: HandoffPacket): { args: string[]; stdin?: string };
  isRunning(): Promise<boolean>;
  getContextWindowSize(): number;
}
```

Every supported agent implements this interface. Adding a new agent = one new adapter file + one entry in the registry.

---

### `claude-session-reader.ts`

Claude Code writes every message turn to:
```
~/.claude/projects/<escaped-cwd>/<sessionId>.jsonl
```

Where `escaped-cwd = cwd.replace(/\//g, '-')`:
- `/mnt/c/Users/zuria/Projects` → `-mnt-c-Users-zuria-Projects`

**Active session detection**: sort `.jsonl` files by `mtime`, take the newest.

**JSONL entry types handled:**

| `type` | Action |
|---|---|
| `assistant` | Extract text + tool_use blocks; read `usage.input_tokens` |
| `user` | Extract content as ConversationTurn |
| `last-prompt` | Store as `sessionContext.lastPrompt` |
| `custom-title` | Store as `sessionContext.sessionTitle` |
| `file-history-snapshot` | Keys → filesModified |

**Tool call extraction** (from `tool_use` blocks in assistant messages):
- `Read` input.file_path → `filesRead[]`
- `Write` / `Edit` input.file_path → `filesModified[]`
- `Bash` input.command → regex parse for file paths

**Usage accuracy**: Use `input_tokens` of the **last** assistant entry only — this is what was actually sent to the model and correctly represents current context fill.

---

### `condenser.ts`

```
Input:  SessionContext (full conversation + files + metadata)
Output: HandoffPacket (validated JSON via zod)
```

Calls `claude-haiku-4-5` with a structured extraction prompt:
1. Ultimate goal of the session
2. Current task state (what's done, what's next)
3. Key decisions made and why
4. Blockers or open issues
5. Files of interest (path + reason)
6. Handoff prompt (≤500 words, ready to paste as first message to any agent)

Falls back to user-configured model if Haiku is unavailable.

---

### `macc install` — Shell Wrapper Injection

Appends to `~/.bashrc` (or `~/.zshrc`):

```bash
# --- MACC shell wrappers ---
gemini() { macc __wrap gemini "$@"; }
claude() { macc __wrap claude "$@"; }
cursor() { macc __wrap cursor "$@"; }
qoder()  { macc __wrap qoder  "$@"; }
# --- end MACC ---
```

`macc __wrap <agent> [args]` logic:
1. Compute `cwd-hash` = sha256 of `process.cwd()` truncated to 8 chars
2. Check `~/.macc/pending/<hash>.json` — if exists and not expired (< 1 hour old):
   - Read `handoffPacket.handoffPrompt`
   - Delete the pending file
   - Launch agent with context injected (stdin or --prompt)
3. No pending file → `execvp(agent, args)` — transparent pass-through

---

### `monitor.ts` — Background Daemon

```
Poll interval: 15s (configurable)
Warning threshold: 80%  → print to daemon log
Auto-handoff threshold: 95% → call condenser → write pending file
```

Uses `chokidar` to watch the active `.jsonl` file for appended lines. On each new line, re-checks the last assistant entry's `input_tokens`. This avoids full re-parse on every poll.

Logs to `~/.macc/daemon.log` — never to stdout (so it doesn't pollute the user's terminal).

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
  createdAt: string;          // ISO timestamp
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
  filesOfInterest: Array<{
    path: string;
    reason: 'modified' | 'read' | 'mentioned';
  }>;
  handoffPrompt: string;      // Ready-to-use first message for the next agent
}
```

### `UsageSnapshot`

```typescript
interface UsageSnapshot {
  agentId: string;
  isRunning: boolean;
  contextUsedPercent: number;    // 0–100
  inputTokensLastTurn: number;
  contextWindowSize: number;
  nearLimit: boolean;            // > 80%
  overLimit: boolean;            // > 95%
  timestamp: Date;
}
```

---

## Technology Stack

| Concern | Choice |
|---|---|
| Language | TypeScript (Node.js 20+) |
| CLI framework | `commander` |
| AI condensation | `@anthropic-ai/sdk` (Haiku model) |
| JSONL file watch | `chokidar` |
| Schema validation | `zod` |
| SQLite history | `better-sqlite3` |
| Path normalization | `node:path` + `node:os` (no extra dep) |
| Process management | `execa` |
| Config files | `cosmiconfig` |

---

## Config File — `~/.macc/config.json`

```json
{
  "version": 1,
  "checkIntervalSeconds": 15,
  "handoffPriorityOrder": ["gemini-cli", "claude-code", "cursor"],
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
    "qoder":  { "enabled": false }
  },
  "condensation": {
    "model": "claude-haiku-4-5",
    "maxHandoffPromptTokens": 4000,
    "includeRecentTurnsCount": 5
  },
  "historyPath": "~/.macc/handoffs/",
  "notifications": true
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
  packet_json  TEXT NOT NULL,  -- HandoffPacket as JSON
  success      INTEGER NOT NULL,
  error_msg    TEXT
);
```

---

## WSL2 Path Normalization

On WSL2, Claude Code stores sessions using the Linux path but the user may be working from a Windows terminal.

```
Windows path:  C:\Users\zuria\Projects\foo
WSL path:      /mnt/c/Users/zuria/Projects/foo
Escaped key:   -mnt-c-Users-zuria-Projects-foo
```

`platform.ts` detects WSL2 via `os.release().includes('microsoft')` and normalizes both forms so MACC finds the correct project directory regardless of which terminal the user is in.
