# Agent Adapter Specifications

Each supported agent has an adapter in `src/adapters/`. All adapters implement `IAgentAdapter` from `src/adapters/base.ts`.

---

## Claude Code

**Command**: `claude`  
**Session storage**: `~/.claude/projects/<escaped-cwd>/<sessionId>.jsonl`  
**Context window**: 200,000 tokens  

### Usage Detection
Read the most recently modified `.jsonl` in the project directory. Sum `usage.input_tokens` (not cumulative — use the last assistant entry only, as it reflects what was actually sent to the model).

### Process Detection
Check `ps aux` for a process named `claude`. On Linux/WSL2, read `/proc/<pid>/cwd` symlink to confirm it matches the current directory.

### Context Injection
```bash
echo "$handoffPrompt" | claude
```
Or for non-interactive use:
```bash
claude --print "$handoffPrompt"
```

### Notes
- Subagent sessions are nested under `<sessionId>/subagents/agent-<id>.jsonl` — count their tokens toward the parent session total
- The `file-history-snapshot` entry type contains tracked file paths
- `last-prompt` entry = the most recent user message (useful for condensation)

---

## Gemini CLI

**Command**: `gemini`  
**Context window**: ~1,000,000 tokens (Gemini 2.5 Pro)  
**Session storage**: `~/.gemini/` (format still evolving as of 2025)

### Usage Detection
Gemini CLI's session files are in `~/.gemini/`. Watch for `.json` conversation files. Token counting is estimated (Gemini CLI doesn't always expose exact usage in session files). Treat as "near limit" at 70% of estimated window.

### Process Detection
`ps aux | grep gemini`

### Context Injection
```bash
echo "$handoffPrompt" | gemini
```
Gemini CLI reads from stdin when not in interactive mode, treating it as the first user message.

### Notes
- Gemini CLI is actively developed — adapter should fail gracefully if expected session file paths don't exist
- Very large context window means handoffs TO Gemini are preferable when context is large

---

## Cursor

**Command**: `cursor`  
**Context window**: Model-dependent (GPT-4o, Claude, etc.)  
**Session storage**: `~/.cursor/User/workspaceStorage/<hash>/state.vscdb` (SQLite)

### Usage Detection
Query the `state.vscdb` SQLite file for conversation entries in `ItemTable`. This requires knowing the workspace hash for the current directory. Hash is derived from the workspace path — see Cursor source or reverse-engineer from the directory listing.

```sql
SELECT value FROM ItemTable WHERE key LIKE 'composer.%';
```

Rate limit info requires Cursor API key or reading from Cursor's settings JSON at `~/.cursor/settings.json`.

### Process Detection
`ps aux | grep "cursor"` or check for Cursor IPC socket files.

### Context Injection
Cursor has no clean CLI for injecting an initial message. Two strategies:

**Strategy A — Handoff file (MVP)**:
1. Write handoff prompt to `<cwd>/.cursor-handoff.md`
2. Launch `cursor <cwd>`
3. The user opens the file and pastes/references it

**Strategy B — URI scheme (ideal)**:
```bash
cursor --goto "cursor://composer?message=<encoded-prompt>"
```
This opens Cursor with a pre-filled Composer message. Needs verification against Cursor's actual URI scheme support.

### Notes
- Cursor is primarily an IDE, not a pure CLI — handoff UX is less seamless than Gemini
- Consider writing the handoff prompt to clipboard as a fallback (`xclip` / `pbcopy`)

---

## Qoder

**Command**: `qoder`  
**Status**: Stub adapter — format TBD  

### Current Implementation
File injection only:
1. Write handoff prompt to `~/.macc/handoff-<hash>.md`
2. Launch `qoder` with the file path as an argument (if supported) or as a reference in the session

### Notes
- Qoder's session file format needs to be reverse-engineered before full adapter support
- The stub adapter will log a warning and fall back to file injection
- Contribution welcome: if you use Qoder regularly, inspect `~/.qoder/` or similar for session state

---

## Adding a New Agent

1. Create `src/adapters/<agent-name>.ts` implementing `IAgentAdapter`
2. Add an entry to `src/adapters/registry.ts`
3. Add the agent's command name to `macc install` shell wrapper list
4. Document it here with storage path, context window size, and injection strategy

Minimum viable adapter (read-only monitoring, no launch):
```typescript
export class MyAgentAdapter implements IAgentAdapter {
  readonly id = 'my-agent';
  readonly commandName = 'myagent';

  async getUsageSnapshot(): Promise<UsageSnapshot> {
    // Return a snapshot with isRunning=false and contextUsedPercent=0
    // if you don't know how to read this agent's usage yet
    return { agentId: this.id, isRunning: false, contextUsedPercent: 0, ... };
  }

  async extractSessionContext(): Promise<SessionContext | null> {
    return null; // stub
  }

  buildLaunchArgs(packet: HandoffPacket) {
    // Fall back to writing a handoff file
    const path = writeTempHandoffFile(packet);
    return { args: [path] };
  }

  async isRunning(): Promise<boolean> {
    return false;
  }

  getContextWindowSize(): number {
    return 128_000; // conservative default
  }
}
```
