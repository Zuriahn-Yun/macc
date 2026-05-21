# Future Ideas & Planned Implementations

## Multi-Agent Orchestration

### Option A — MACC as Conductor (Non-Interactive Pipeline)

MACC uses the Claude/Gemini API directly as the planning brain. The user gives it a high-level goal; MACC decomposes it into subtasks, routes each task to the best-fit agent (e.g. Codex for implementation, Qodercli for review, Gemini for large-context analysis), runs each agent non-interactively via `buildNonInteractiveArgs`, then synthesizes results.

This is a natural extension of the existing `fanout` command — `fanout` already does decompose→run→synthesize but always uses the same agent type and runs in parallel. The new pieces needed:

- Per-task agent routing (annotate each subtask with a target agent ID)
- Sequential task dependencies (not just parallel)
- A new `macc orchestrate` command (or enhanced `fanout --route`)

**Tradeoffs:**
- Simpler to build — most infrastructure already exists
- Fully automated, no interactive session
- Less flexible for exploratory work

---

### Option B — Claude Code as Primary with MACC as Side-Car (Interactive)

Claude Code runs as the normal interactive session. MACC watches a shared task directory (e.g. `~/.macc/tasks/`). When Claude Code wants to delegate something, it writes a task file there. MACC picks it up, runs it in Codex or Qodercli non-interactively, and writes the result back to a results file. Claude Code reads that file and continues.

Requires injecting awareness into Claude Code via its system prompt at session start so it knows the delegation convention.

**Tradeoffs:**
- Preserves the normal interactive Claude Code workflow
- More powerful for mid-session delegation
- Relies on Claude Code reliably following the side-car file convention via prompt injection
- More moving parts (file watching, result passing, prompt injection)

---

## `macc switch <agent>` Auto-Target from Primary Agent

Already implemented (2025-05) — `macc switch gemini-cli` from a second terminal sends SIGUSR1 and skips the picker. Documented here for reference as the precursor to Option B above.
