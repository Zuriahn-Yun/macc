# MACC — Claude Code Project Guide

**Multi-Agent Coding Client** — monitors AI coding agents (Claude Code, Gemini CLI, OpenAI Codex, Qodo), auto-switches when usage limits or credits are exhausted, and compresses full session context for the incoming agent.

- **Entry point:** `src/index.ts` (CLI, commander-based)
- **Orchestrator:** `src/core/orchestrator.ts` — agent spawn, stderr monitoring, auto-switch, handoff menu
- **Error detection:** `src/utils/errors.ts` — credit/usage-limit pattern matching, reset-time parsing
- **Agent state:** `src/utils/agent-state.ts` — pause records persisted to `~/.macc/pauses.json`
- **Compression:** `src/core/compressor.ts` — AI-assisted + rate-limit raw fallback
- **Fan-out:** `src/core/fanout.ts` — parallel task decomposition across agents
- **Adapters:** `src/adapters/` — one file per agent (claude, gemini, codex, qodo, generic)
- **Backends:** `src/backends/` — Anthropic, Gemini, OpenAI SDK wrappers
- **Tests:** Vitest — `npm test` (204 tests)
- **Build:** `npm run build` (tsc → dist/)
- **License:** MIT

---

## How the auto-switch works

1. MACC spawns the agent with `stdio: ['inherit', 'inherit', 'pipe']` — stdin/stdout are fully inherited (terminal works normally), stderr is piped so MACC can read it without interrupting the user's view.
2. Every byte on stderr is also forwarded to `process.stderr` so the user still sees all error output.
3. On agent exit, `detectExitReason(stderrBuffer)` checks the accumulated stderr against `USAGE_LIMIT_PATTERNS` and `CREDIT_PATTERNS` in `src/utils/errors.ts`.
4. If `exitReason !== 'normal'`, MACC skips all interactive menus, records the pause in `~/.macc/pauses.json`, and automatically switches to `targets[0]`.
5. Before every menu display, `getJustRecoveredAgents()` checks if any paused agent's reset time has passed and notifies the user.

---

## Work Tracking

---

### BUG-01 — `gpt-4o` in default handoff order crashes at runtime

**STATUS: FIXED**

`DEFAULTS.handoffOrder` included `'gpt-4o'` but `MODEL_MAP` had no entry. Fixed by implementing `src/backends/openai.ts` and registering `gpt-4o` and `gpt-4o-mini` in `MODEL_MAP`.

---

### BUG-02 — Infinite recursion in setup wizard

**STATUS: FIXED**

Replaced recursive `runSetupWizard()` call with a `while (true)` loop + `continue` for unsupported providers.

---

### BUG-03 — `GenericAgentAdapter.isRunning()` false positives

**STATUS: FIXED**

Escapes regex metacharacters in commandName, uses strict word-boundary pattern, excludes own PID.

---

### BUG-04 — PID file written before spawn succeeds

**STATUS: FIXED**

`writePid()` now guarded by `if (child.pid !== undefined)` + `child.on('error', () => clearPid())`.

---

### BUG-05 — `runSubagent` in fanout has no timeout

**STATUS: FIXED**

Added 5-minute default timeout with `setTimeout` + `child.kill('SIGTERM')`.

---

### BUG-06 — `watchAll` redraw race condition

**STATUS: FIXED**

Added `isRedrawing` and `hasFiredHandoff` guards; redraw bails early if either is true.

---

### BUG-07 — `fanOut` accepts count=0 or count=100

**STATUS: FIXED**

Clamped with `Math.min(Math.max(Math.floor(opts.count), 1), 10)`.

---

### BUG-08 — `macc agent list` always shows agents as not installed

**STATUS: FIXED**
**File:** `src/index.ts` line ~358

In a `"type": "module"` package, `require` is not defined. The `require('node:child_process').execFileSync(...)` call inside the `agentCmd list` action always threw a ReferenceError (silently caught), so every agent showed as "not installed". Fixed by importing `execFileSync` from `node:child_process` at the top of the file and using it directly.

---

### FEATURE-01 — Credit exhaustion and usage-limit auto-switch

**STATUS: COMPLETED**
**Files:** `src/utils/errors.ts`, `src/utils/agent-state.ts`, `src/core/orchestrator.ts`

When Claude Code hits its hourly/plan usage limit or any provider runs out of credits, MACC detects the error from stderr and automatically switches to the next configured agent without prompting the user.

**What was built:**
- `CreditsExhaustedError` and `UsageLimitError` classes
- `CREDIT_PATTERNS` — permanent billing failures (insufficient_quota, account suspended, free tier exceeded, OpenAI billing quota)
- `USAGE_LIMIT_PATTERNS` — temporary rate/usage limits with verified real strings from Anthropic, Gemini, OpenAI APIs
- `detectExitReason(stderr)` — checks USAGE_LIMIT first (temporary → recoverable), then CREDIT (permanent → switch provider)
- `parseResetTime(text)` — extracts reset time from "try again at 8 PM", "in 2 hours", ISO timestamps, etc.
- `recordAgentPaused()` / `getJustRecoveredAgents()` — persists pause state to `~/.macc/pauses.json`; checks on every menu display and notifies user when an agent is back
- All three backends (Anthropic, Gemini, OpenAI) throw `CreditsExhaustedError` on billing errors
- Orchestrator wires it all together: stderr tee → `detectExitReason` → auto-switch, pause record, display message

---

### MISSING-01 — OpenAI backend

**STATUS: COMPLETED**

`src/backends/openai.ts` — `gpt-4o`, `gpt-4o-mini` with streaming + token usage. 13 tests.

---

### MISSING-02 — Qodo setup login hardcoded "coming soon"

**STATUS: OPEN**
**File:** `src/commands/setup.ts`

Qodo adapter and session parsing work; just no login wizard step. Needs investigation of `qodercli auth` command.

---

### MISSING-03 — `src/repl/session.ts` dead code

**STATUS: FIXED**

Deleted the unused REPL loop file.

---

### MISSING-04 — `better-sqlite3` dependency unused

**STATUS: OPEN**
**File:** `package.json`

Dependency exists but nothing imports it. Either implement SQLite session history or remove it.

---

### MONETIZE-01 — GitHub Sponsors

**STATUS: COMPLETED**

`.github/FUNDING.yml` + badge in README. Activate at github.com/sponsors.

---

### MONETIZE-02 — License system (no longer active)

**STATUS: ARCHIVED**

HMAC-SHA256 offline license system was built (`src/utils/license.ts`) but MACC is now fully free. The license module and `licenseKey` config field remain as dead code — harmless, may be useful if a Pro tier is introduced later.

---

## Architecture Quick Reference

```
macc start     → runWithRotation() in orchestrator.ts
macc watch     → watchAll() in orchestrator.ts
macc status    → printStatusOnce() in orchestrator.ts
macc handoff   → triggerHandoff() in orchestrator.ts
macc switch    → writes ~/.macc/switch-target, sends SIGUSR1 to PID from ~/.macc/running.pid
macc agent add → interactive wizard → saved to ~/.macc/agents.json
```

**Auto-switch flow (usage limit / credits exhausted):**
1. Agent exits non-zero → `detectExitReason(stderrBuffer)` returns `'usage-limit'` or `'credits-exhausted'`
2. `parseResetTime(stderrBuffer)` extracts reset time if present
3. `recordAgentPaused(agentId, reason, resetAt)` writes to `~/.macc/pauses.json`
4. `printUsageLimitHit()` or `printCreditsExhausted()` displayed
5. `targets[0]` auto-selected — no menu shown
6. `compressWithFallback()` uses a *different* provider for compression (Claude is unavailable → uses Gemini/OpenAI)
7. New agent launched with `handoffPrompt` as first message

**Normal handoff flow (context window full or manual):**
1. User exits agent (Ctrl+C) or `macc switch` fires SIGUSR1
2. Context % shown; user picks target from menu
3. `extractSessionContext()` reads JSONL session file
4. `compressWithFallback()` → `HandoffPacket` with structured summary + 2000-word `handoffPrompt`
5. New agent spawned with `handoffPrompt`

**Adding a new agent adapter:**
- Implement `IAgentAdapter` from `src/adapters/base.ts`
- Register in `src/adapters/registry.ts`
- Add tests in `src/adapters/<name>.test.ts`

**Adding a new AI backend:**
- Implement `IModelBackend` from `src/backends/base.ts`
- Register in `src/backends/registry.ts` `MODEL_MAP`
- See `src/backends/anthropic.ts` as reference
