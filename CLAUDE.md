# MACC — Claude Code Project Guide

**Multi-Agent Coding Client** — transfers context between AI coding agents (Claude Code, Gemini CLI, OpenAI Codex, Qodo) when context limits are hit.

- **Entry point:** `src/index.ts` (CLI, commander-based)
- **Orchestrator:** `src/core/orchestrator.ts` — agent spawn, context polling, handoff menu
- **Compression:** `src/core/compressor.ts` — AI-assisted + rate-limit fallback
- **Fan-out:** `src/core/fanout.ts` — parallel task decomposition across agents
- **Adapters:** `src/adapters/` — one file per agent (claude, gemini, codex, qodo, generic)
- **Backends:** `src/backends/` — Anthropic and Gemini SDK wrappers
- **Tests:** Vitest — `npm test`
- **Build:** `npm run build` (tsc → dist/)
- **License:** MIT

---

## Work Tracking

Each item below tracks status, what was completed, and what's needed next.
Update the `STATUS` line and add a note whenever work is done on that item.

---

### BUG-01 — `gpt-4o` in default handoff order crashes at runtime

**STATUS: FIXED**
**File:** `src/utils/config.ts` line 18, `src/backends/registry.ts`
**Priority: HIGH — affects all users who haven't set a custom `handoffOrder`**

`DEFAULTS.handoffOrder` includes `'gpt-4o'` but `MODEL_MAP` in `registry.ts` has no entry for it. Any handoff that attempts to use `gpt-4o` calls `getBackend('gpt-4o')` which throws `Unknown model: gpt-4o`. Since the OpenAI backend is not yet implemented, the fix is to remove `'gpt-4o'` from the default `handoffOrder` until the backend exists.

**Fix:** Remove `'gpt-4o'` from `DEFAULTS.handoffOrder` in `src/utils/config.ts`.
**Progress:** Fixed — removed `gpt-4o` from defaults. Default order is now `['gemini-2.5-pro', 'claude-sonnet-4-6']`.
**Next:** Restore when OpenAI backend (MISSING-01) is implemented.

---

### BUG-02 — Infinite recursion in setup wizard when unsupported provider is chosen

**STATUS: FIXED**
**File:** `src/commands/setup.ts` lines 59–64
**Priority: HIGH**

When the user selects Qodo (or any provider with `defaultModel === ''`), `runSetupWizard()` calls itself recursively. Each call creates and closes a readline interface but adds a stack frame. Repeated Qodo selections will stack overflow (`Maximum call stack size exceeded`).

**Fix:** Replace the recursive call with a loop (`while (!selectedBackend)`) inside `runSetupWizard` so unsupported selections restart the prompt without growing the stack.
**Progress:** Fixed — `runSetupWizard` now uses a `while (true)` loop with `continue` for unsupported providers instead of recursion.
**Next:** Nothing.

---

### BUG-03 — `GenericAgentAdapter.isRunning()` regex can produce false positives

**STATUS: FIXED**
**File:** `src/adapters/generic.ts` lines 126–135
**Priority: MEDIUM**

`isRunning()` runs `ps aux` and checks if any line matches `\bcommandName\b`. Short command names (e.g., `r`, `go`, `node`) will match unrelated processes. Also, the guard `!line.includes('macc')` is not sufficient to filter out all parent processes.

**Fix:** Escape regex metacharacters; use word-boundary pattern `(?:^|[\s/])name(?:\s|$)`; exclude own PID (column 1 in `ps aux`).
**Progress:** Fixed — `isRunning` now escapes the commandName, uses a strict word-boundary pattern, and excludes the current process's PID.
**Next:** Nothing.

---

### BUG-04 — PID file written before `spawn()` succeeds

**STATUS: FIXED**
**File:** `src/core/orchestrator.ts` lines ~115–125
**Priority: LOW**

`writePid()` is called before `spawn()`. If the agent binary doesn't exist and spawn throws, the PID file is left pointing at the macc process itself. A subsequent `macc switch` sends SIGUSR1 to the wrong process.

**Fix:** Call `writePid()` after confirming `child.pid` is set; add `child.on('error', () => clearPid())`.
**Progress:** Fixed — `writePid()` is now guarded by `if (child.pid !== undefined)` and a child error handler calls `clearPid()`.
**Next:** Nothing.

---

### BUG-05 — `runSubagent` in fanout has no timeout

**STATUS: FIXED**
**File:** `src/core/fanout.ts` lines 88–113
**Priority: MEDIUM**

`runSubagent` wraps `spawn` in a Promise that only resolves on `close`. If a subagent hangs (e.g., waiting for user input), `fanOut` hangs forever with no way to cancel.

**Fix:** Add a configurable timeout (default 5 minutes) that kills the child process and rejects with a timeout error.
**Progress:** Fixed — `runSubagent` now has a `settled` flag and a `setTimeout(timeoutMs)` that calls `child.kill('SIGTERM')` and rejects. `FanOutOptions` has a new optional `timeoutMs` field (defaults to 300,000ms).
**Next:** Nothing.

---

### BUG-06 — `watchAll` redraw race condition

**STATUS: FIXED**
**File:** `src/core/orchestrator.ts` lines ~290–345
**Priority: MEDIUM — contributes to dashboard reliability issues**

`redraw` is async and called on an interval. If `redraw` takes longer than `POLL_INTERVAL_MS` (5 seconds), two redraws can run concurrently. The second `clearInterval(poll)` call when a 98% threshold is hit may not prevent an already-queued redraw from firing. This causes garbled terminal output and duplicate `triggerHandoff` calls.

**Fix:** Add a `let isRedrawing = false` guard at the top of the `redraw` function. Skip the redraw if one is already in progress.
**Progress:** Fixed — added `isRedrawing` and `hasFiredHandoff` flags. Redraw bails early if either is true; `hasFiredHandoff` is set before `triggerHandoff` so no interval tick can re-enter.
**Next:** Nothing. See TEST-05 for dashboard test coverage (deferred until after BUG-06 fix — now unblocked).

---

### BUG-07 — `fanOut` does not validate `count` parameter

**STATUS: FIXED**
**File:** `src/core/fanout.ts` line 118
**Priority: LOW**

No upper or lower bound on `count`. Passing `count: 0` would call `decompose` for 0 subtasks, receive an empty array, and call `synthesize` with empty results. Passing `count: 100` would attempt to spawn 100 concurrent subagent processes.

**Fix:** Clamp `count` to `[1, 10]` at the start of `fanOut`.
**Progress:** Fixed — `count` is clamped with `Math.min(Math.max(Math.floor(opts.count), 1), 10)`.
**Next:** Nothing.

---

### MISSING-01 — OpenAI backend not implemented

**STATUS: COMPLETED**
**File:** `src/backends/registry.ts` — `gpt-4o` referenced but no `src/backends/openai.ts`
**Priority: MEDIUM**

The `openai` npm package is already in `dependencies`. The backend needs to implement `IModelBackend` (stream, isAvailable, token tracking). Context window: gpt-4o = 128k.

**Fix:** Create `src/backends/openai.ts` implementing `IModelBackend`, add entries to `MODEL_MAP` in `registry.ts`, restore `'gpt-4o'` to `DEFAULTS.handoffOrder`.
**Progress:** Implemented — `src/backends/openai.ts` uses `openai` SDK with streaming + `include_usage: true`. `gpt-4o` (128k) and `gpt-4o-mini` (128k) registered in `MODEL_MAP`. `gpt-4o` restored to `DEFAULTS.handoffOrder`. 13 tests added in `src/backends/openai.test.ts`.
**Next:** Add `OPENAI_API_KEY` instructions to README/setup wizard (currently only Claude and Google are guided).

---

### MISSING-02 — Qodo setup login is hardcoded "coming soon"

**STATUS: OPEN**
**File:** `src/commands/setup.ts` lines 27–32
**Priority: LOW**

Qodo adapter and session parsing work fine; users just can't log in through the wizard. The Qodo CLI auth mechanism needs investigation.

**Fix:** Research `qodercli auth` or equivalent command, implement `loginQodo()` similar to `loginClaude()`.
**Progress:** Nothing done yet.
**Next:** Check if `qodercli` has an auth subcommand, implement wizard step.

---

### MISSING-03 — `src/repl/session.ts` is dead code

**STATUS: FIXED**
**File:** `src/repl/session.ts` (227 lines)
**Priority: LOW**

This file is a REPL loop left over from early architecture. It is never imported or called. The orchestrator replaced it.

**Fix:** Delete the file. Verify no imports reference it.
**Progress:** Confirmed no imports, deleted `src/repl/session.ts` and the now-empty `src/repl/` directory.
**Next:** Nothing.

---

### MISSING-04 — `better-sqlite3` dependency unused

**STATUS: OPEN**
**File:** `package.json`
**Priority: LOW**

`better-sqlite3` is in `dependencies` and its `@types` counterpart is in `devDependencies`. No file in `src/` imports it. Intended for future session history tracking.

**Fix:** Either implement the session history feature or remove the dependency until it's needed.
**Progress:** Nothing done yet.
**Next:** Decide whether to implement SQLite session history (see FUTURE-02) or remove the dep.

---

### TEST-01 — Display utility functions have no tests

**STATUS: COMPLETED**
**File:** `src/utils/display.ts` — `src/utils/display.test.ts` (new)
**Priority: MEDIUM**

`printUsageBar`, `printAgentRow`, `printStatusHeader`, `printDashboardHeader`, `printSwitchBanner`, `printHandoffSummary`, `printHandoffMenu`, `printWarning`, `startHandoffProgress` all had zero test coverage.

**Progress:** Tests written covering all exported functions including edge cases (0%, 90%, 98%, 100% usage; not-installed agents; long goal truncation; estimated tokens).
**Next:** Nothing. Done.

---

### TEST-02 — Setup wizard has no error-path tests

**STATUS: COMPLETED**
**File:** `src/commands/setup.ts` — `src/commands/setup.test.ts` (new)
**Priority: MEDIUM**

No tests for: already-logged-in fast path, unsupported provider selection, missing CLI tools, failed login, credential write failure.

**Progress:** Tests written covering already-logged-in, Qodo unsupported selection, missing claude CLI, failed login, invalid menu choice retry.
**Next:** Nothing. Done.

---

### TEST-03 — Generic adapter has no edge-case tests

**STATUS: COMPLETED**
**File:** `src/adapters/generic.ts` — `src/adapters/generic.test.ts` (new)
**Priority: MEDIUM**

No tests for: malformed JSONL lines, missing `sessionDir`, gemini-compatible format, `sessionFormat: 'none'`, deeply nested session directories.

**Progress:** Tests written covering all session formats, missing dirs, malformed lines, token estimation, `isRunning` false when process not found.
**Next:** Nothing. Done.

---

### TEST-04 — Fanout edge cases under-tested

**STATUS: COMPLETED**
**File:** `src/core/fanout.test.ts`
**Priority: MEDIUM**

Only 4 basic tests; no coverage of decomposition failures, synthesis failures, or mixed pass/fail subagent results.

**Progress:** Additional tests added for: decomposition JSON parse failure, synthesis fallback to raw output, mixed success/failure subagents, adapter with no `buildNonInteractiveArgs` (falls back to `--print`).
**Next:** Nothing. Done.

---

### TEST-05 — Dashboard (`watchAll`) has zero tests

**STATUS: OPEN**
**File:** `src/core/orchestrator.ts` — `watchAll` function
**Priority: LOW — blocked on BUG-06 (race condition fix first)**

`watchAll` requires a full terminal (ANSI escape codes, interval polling, SIGINT handling). Testing it requires careful mocking of `process.stdout.write`, `setInterval`, and `process.once('SIGINT')`.

**Progress:** Nothing done yet — defer until BUG-06 is fixed so tests don't validate buggy behavior.
**Next:** After BUG-06 fix: mock `getUsageSnapshot`, verify redraw cycle, verify handoff triggers at 98%, verify SIGINT cleans up.

---

### MONETIZE-01 — Paid tier / hosted SaaS

**STATUS: IDEA**
**Priority: HIGH for revenue**

MACC currently requires users to have their own API keys and CLI tools installed. A hosted web version could eliminate this friction.

**Model ideas:**
- **Free tier:** Up to 3 handoffs/day, Claude ↔ Gemini only
- **Pro tier ($12–19/month):** Unlimited handoffs, all agents, compression history, team sharing
- **Team tier ($49–99/month):** Shared context store, audit log, custom agents per team

**What's needed:**
- Web UI (Next.js or similar) wrapping the MACC orchestrator
- Auth (clerk.dev or auth.js)
- Usage tracking per user (the SQLite dep already exists)
- Stripe integration for subscriptions

**Progress:** Nothing done yet — idea only.
**Next:** Validate demand: post to HN/Reddit, measure GitHub stars. If traction, build web UI first.

---

### MONETIZE-02 — npm package / API SDK

**STATUS: IDEA**
**Priority: MEDIUM**

MACC is already published as `@yunzuriahn/macc` on npm. Could be productized as a proper SDK.

**Model ideas:**
- **Free CLI:** Current open-source MIT stays free
- **SDK license ($0/mo for OSS, $X/mo for commercial):** Add a `MaccClient` class that can be embedded in other tools (Cursor extensions, VS Code plugins, CI pipelines)
- **Marketplace listings:** Cursor marketplace, VS Code extension marketplace

**What's needed:**
- Clean public API surface (`MaccClient`, `HandoffPacket`, adapters)
- Documentation site (vitepress or docusaurus)
- VS Code extension wrapper

**Progress:** Nothing done yet — idea only.
**Next:** Write a `MaccClient` class that exposes `handoff()`, `compress()`, `fanOut()` as a library. Publish to npm properly.

---

### MONETIZE-03 — One-time license for power users

**STATUS: IDEA**
**Priority: MEDIUM**

Many developers distrust SaaS subscriptions for CLI tools. A one-time purchase model fits the audience.

**Model ideas:**
- **Free:** Core CLI (MIT, current state)
- **Pro license ($49 one-time):** Priority model routing, fan-out with >3 agents, SQLite session history, Discord support
- **Use Polar.sh or Lemon Squeezy** for license key distribution — both have free tiers

**Gating mechanism:** License key checked at startup against a lightweight license server (or embedded HMAC check for offline use).

**What's needed:**
- Feature flag system in `src/utils/config.ts` (check license key)
- Pro-only features: fan-out count >3, session history, custom compression models
- Landing page with pricing (can be a GitHub README + polar.sh link initially)

**Progress:** Nothing done yet — idea only.
**Next:** Add license key field to `~/.macc/config.json`, implement HMAC validation, gate fan-out `count > 3` behind it.

---

### MONETIZE-04 — GitHub Sponsors / Open Collective

**STATUS: IDEA**
**Priority: LOW — low ceiling but zero development cost**

Given the project is MIT and targets developers, GitHub Sponsors is a natural fit for sustaining open-source development without gating features.

**What's needed:**
- Enable GitHub Sponsors on the account
- Add a `FUNDING.yml` to the repo
- Add a sponsors section to the README

**Progress:** Nothing done yet.
**Next:** Enable Sponsors, add `.github/FUNDING.yml`, add "Support this project" badge to README.

---

## Architecture Quick Reference

```
macc start     → runWithRotation() in orchestrator.ts
macc watch     → watchAll() in orchestrator.ts
macc status    → printStatusOnce() in orchestrator.ts
macc handoff   → triggerHandoff() in orchestrator.ts
macc switch    → writes ~/.macc/switch-target, sends SIGUSR1 to PID from ~/.macc/running.pid
macc agent add → runAgentWizard() in commands/setup.ts → saved to ~/.macc/agents.json
```

**Handoff flow:**
1. User exits agent (Ctrl+C) or `macc switch` fires SIGUSR1
2. Orchestrator reads session JSONL via adapter → `extractSessionContext()`
3. Compression: `compressWithFallback()` → `HandoffPacket` with structured summary
4. New agent spawned with `handoffPrompt` as a positional CLI arg
5. Process repeats

**Adding a new agent adapter:**
- Implement `IAgentAdapter` from `src/adapters/base.ts`
- Register in `src/adapters/registry.ts`
- Add tests in `src/adapters/<name>.test.ts`

**Adding a new AI backend:**
- Implement `IModelBackend` from `src/backends/base.ts`
- Register in `src/backends/registry.ts` `MODEL_MAP`
- See `src/backends/anthropic.ts` as reference
