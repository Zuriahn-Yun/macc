# FUTURE_FEATURES.md — Parallel Agent Orchestration

**Status:** Design proposal — not yet implemented  
**Branch:** dev  
**Scope:** Architectural plan for running multiple agent CLIs concurrently inside MACC

---

## Problem Statement

MACC's current model is strictly sequential: one agent runs at a time, owns the terminal, and MACC waits for it to exit before doing anything else. This is simple and correct, but it leaves real parallelism on the table. A large engineering task often decomposes into independent subtasks — write tests while implementing a feature, run linting while generating docs, perform a large-context analysis on one file while making targeted edits to another.

Running those subtasks sequentially wastes wall-clock time by half or more. The goal of parallel orchestration is to dispatch independent subtasks to separate agent processes simultaneously and collect their outputs, without breaking MACC's core promise of working across whichever agents the user has installed.

---

## Architectural Constraints

The current architecture imposes hard constraints on any parallel design:

### 1. Terminal Ownership

Each agent CLI (claude, gemini, codex) **owns stdin/stdout** when it runs interactively. Two interactive agents cannot share one terminal — they would corrupt each other's TUI.

**Implication:** Parallel orchestration must run agents non-interactively (`buildNonInteractiveArgs`), not interactively. The user cannot be "inside" two agents at once.

### 2. stdin/stdout Are Inherited

Today's `spawn` call uses `stdio: ['inherit', 'inherit', 'pipe']`. In a parallel model, each worker must use `stdio: ['pipe', 'pipe', 'pipe']` so its output can be collected independently without polluting the terminal.

**Implication:** Parallel orchestration is a separate code path from the interactive rotation loop. The two modes should remain separate — mixing them risks terminal corruption.

### 3. Rate Limits and Context Windows Per Agent

Running N tasks in parallel against the same agent multiplies rate-limit exposure by N. Claude Code's per-account limits can be hit within a single parallel job if subtask prompts are large.

**Implication:** The scheduler must respect per-agent concurrency limits (configurable, defaulting to 1 per provider). Overflow tasks queue and drain as earlier tasks complete.

### 4. Context Window Per Subtask

Each non-interactive invocation gets its own context window from scratch — there is no shared context between parallel workers. Subtask prompts must be self-contained: they cannot rely on what a sibling task already knows.

**Implication:** The decomposition step must produce fully self-contained prompts. This is a prompt-engineering constraint, not an architectural one, but it must be enforced at the API boundary.

---

## Proposed Design

### Command

```
macc parallel "<goal>" [--agents claude-code,codex] [--max-concurrent 2]
```

Or interactively triggered mid-session from a watching MACC instance once a primary agent signals it wants to delegate.

### Flow

```
User goal
    │
    ▼
[Decomposer]  (LLM call via compressor backend)
    │  Produces N subtask specs, each with:
    │    - prompt (self-contained)
    │    - target agent ID
    │    - dependencies: list of subtask indices that must complete first
    │
    ▼
[Scheduler]
    │  Maintains a ready queue and an in-flight map
    │  Respects per-agent concurrency limit
    │
    ├──► Worker(subtask 0, claude-code)  ──► stdout captured to result[0]
    ├──► Worker(subtask 1, codex)        ──► stdout captured to result[1]
    │    (blocked until result[0] ready if dependency declared)
    └──► Worker(subtask 2, gemini-cli)   ──► stdout captured to result[2]
    │
    ▼
[Synthesizer]  (LLM call — same or different backend)
    │  Combines result[0..N] into a final answer or applies them in order
    │
    ▼
Output / next interactive session
```

### Core Types

```typescript
interface SubtaskSpec {
  id: number;
  agentId: string;         // which agent to run
  prompt: string;          // fully self-contained instruction
  dependsOn: number[];     // subtask IDs that must complete first
}

interface SubtaskResult {
  id: number;
  agentId: string;
  output: string;
  exitCode: number;
  durationMs: number;
  error?: string;
}

interface ParallelJobSpec {
  goal: string;
  subtasks: SubtaskSpec[];
  maxConcurrentPerAgent: Record<string, number>;
}
```

### Scheduler Algorithm

```
ready_queue  = subtasks where dependsOn is empty
in_flight    = Map<subtaskId, Promise<SubtaskResult>>
completed    = Map<subtaskId, SubtaskResult>
concurrency  = Map<agentId, currentCount>

while ready_queue is not empty or in_flight is not empty:
  # Drain ready queue up to concurrency limits
  while ready_queue has items:
    task = pick highest-priority item whose agentId is under concurrency limit
    if no such task: break
    concurrency[task.agentId]++
    in_flight[task.id] = runWorker(task)

  # Wait for any in-flight task to finish
  done = await Promise.race(in_flight.values())
  in_flight.delete(done.id)
  concurrency[done.agentId]--
  completed[done.id] = done

  # Unlock tasks whose dependencies are now satisfied
  for each remaining subtask s:
    if s.dependsOn.every(id => completed.has(id)):
      ready_queue.push(s)
```

This is a standard topological-sort-driven task scheduler. The key property: it never exceeds the per-agent concurrency limit, so it naturally rate-limits without back-pressure logic.

---

## Worker Implementation

Each worker:

1. Calls `adapter.buildNonInteractiveArgs(prompt)` to get the flags for a fire-and-forget invocation
2. Spawns with `stdio: ['pipe', 'pipe', 'pipe']`
3. Streams stdout into a string buffer (no terminal display)
4. Pipes stderr to `process.stderr` prefixed with `[agentId/taskId]` so errors remain visible
5. Resolves with the collected output on exit

```typescript
async function runWorker(
  adapter: IAgentAdapter,
  task: SubtaskSpec,
): Promise<SubtaskResult> {
  const args = adapter.buildNonInteractiveArgs(task.prompt);
  const child = spawn(adapter.commandName, args, { stdio: ['pipe', 'pipe', 'pipe'] });

  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (c: Buffer) => { stdout += c.toString(); });
  child.stderr?.on('data', (c: Buffer) => {
    stderr += c.toString();
    process.stderr.write(`[${task.agentId}/${task.id}] ${c}`);
  });

  const exitCode = await new Promise<number>(r => child.on('close', r));
  return { id: task.id, agentId: task.agentId, output: stdout, exitCode, durationMs: 0, error: stderr || undefined };
}
```

---

## Display

Since parallel workers cannot use the interactive terminal, MACC owns stdout during the entire parallel job. The display should show a live status table, updated periodically:

```
  MACC — Parallel Job: "Refactor the auth module"
  ─────────────────────────────────────────────────
  [0] claude-code   ████████░░  running   (12s)
  [1] codex         ██████████  done ✓    (8s)
  [2] gemini-cli    ░░░░░░░░░░  queued
  ─────────────────────────────────────────────────
  2 / 3 subtasks complete
```

This requires ANSI cursor movement (same pattern as `watchAll`'s dashboard redraw). The progress display replaces the terminal for the duration of the job.

---

## Decomposer Prompt Design

The decomposer is an LLM call that converts a user goal into a `SubtaskSpec[]`. Key requirements for the prompt:

1. Each subtask must be **self-contained**: it receives no context from siblings at runtime (they may not be done yet). If task B needs the output of task A, declare `dependsOn: [A]` and wait — the scheduler will inject A's output into B's prompt before dispatching.

2. The number of subtasks should be small (2–5). More subtasks = more rate-limit exposure and more synthesis complexity.

3. Each subtask should be assigned to the agent best suited to it:
   - `claude-code` for tasks requiring deep reasoning, long context reads, architecture decisions
   - `codex` for mechanical changes, boilerplate generation, grep-and-replace style work  
   - `gemini-cli` for large file analysis (2M token window), summarization across many files

4. The decomposer output must be parseable JSON matching `SubtaskSpec[]`. Use a small Zod schema to validate and retry once on parse failure.

---

## Phasing

### Phase 1 — Manual dispatch, no decomposer (MVP)

The user writes subtasks explicitly:

```
macc parallel --task "Write tests for src/auth.ts" --agent claude-code \
              --task "Document the auth API" --agent gemini-cli
```

No LLM decomposition. The scheduler, worker, and synthesizer are the only new pieces. This validates the infrastructure with zero new LLM API spend.

### Phase 2 — LLM decomposition

Add the decomposer LLM call. Now `macc parallel "Refactor the auth module"` works end-to-end. Gate it behind a config flag (`parallelOrchestration: true`) since it makes LLM calls without the user typing them explicitly.

### Phase 3 — Interactive delegation (side-car model)

A running interactive claude-code session can write a subtask spec to `~/.macc/tasks/<id>.json`. MACC's parallel engine picks it up, runs it, writes the result to `~/.macc/results/<id>.txt`. The claude-code system prompt is augmented (via `--append-system-prompt`) with instructions for using this delegation protocol.

This is the most powerful mode — it makes the interactive agent feel like it has sub-agents — but it depends entirely on the interactive agent reliably following the file-based protocol. Treat it as experimental until that reliability is confirmed in practice.

---

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Rate limit cascade from N parallel calls | Per-agent concurrency cap (default 1), configurable per user |
| Subtask output is truncated (non-interactive agents may cap output) | Document known limits per agent; add `--max-output` warning |
| Decomposer produces non-self-contained prompts | Validate in decomposer prompt; retry with explicit constraint on each subtask |
| Terminal corruption if interactive + parallel modes mix | Hard architectural separation — parallel mode uses `stdio: pipe`, interactive uses `stdio: inherit` |
| Cost surprise (many LLM calls per job) | Show estimated call count before dispatch; require `--yes` flag to proceed |

---

## Non-Goals

- Shared memory / shared context between parallel workers during execution (each worker is isolated)
- Running two interactive sessions simultaneously (not possible without a multiplexer like tmux)
- Streaming partial outputs from workers to the terminal mid-job (too complex for phase 1; consider for phase 3)
- Fault tolerance / retry within the parallel engine (the outer retry model is: re-run the failed subtask manually)

---

## Open Questions

1. **Synthesis quality**: The synthesizer receives N outputs and must combine them coherently. For code changes, "apply in order" may work. For analysis tasks, an LLM synthesis call is needed — but which model, and what's the prompt structure?

2. **Dependency injection**: When task B depends on task A, do we inject A's raw output into B's prompt, or a summary of it? Raw output is simpler but may exceed B's context window.

3. **Agent discovery**: Phase 1 requires the user to name agents explicitly. Should Phase 2 pick agents automatically based on subtask characteristics, or always ask?

4. **Cost visibility**: Should MACC estimate the total token cost of a parallel job before starting, and show it to the user for confirmation?

These are intentionally left open — they should be resolved with real user feedback once Phase 1 is running.
