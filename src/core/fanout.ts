import { spawn } from 'node:child_process';
import chalk from 'chalk';
import { z } from 'zod';
import type { IAgentAdapter } from '../adapters/base.js';
import type { IModelBackend, StreamChunk } from '../backends/base.js';
import type { Message } from '../models/message.js';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const SubtaskSchema = z.object({
  title: z.string(),
  prompt: z.string(),
});

const DecompositionSchema = z.object({
  subtasks: z.array(SubtaskSchema),
});

const SynthesisSchema = z.object({
  summary: z.string(),
  nextStep: z.string(),
  combinedOutput: z.string(),
});

// ---------------------------------------------------------------------------
// AI helpers
// ---------------------------------------------------------------------------

async function callBackend(backend: IModelBackend, system: string, userMsg: string): Promise<string> {
  const messages: Message[] = [{ role: 'user', content: userMsg, timestamp: new Date() }];
  let out = '';
  await backend.stream(messages, system, (chunk: StreamChunk) => {
    if (!chunk.done) out += chunk.text;
  });
  return out;
}

async function decompose(
  backend: IModelBackend,
  context: string,
  count: number,
): Promise<Array<{ title: string; prompt: string }>> {
  const system = `You decompose coding tasks into independent parallel subtasks.
Return ONLY valid JSON matching: { "subtasks": [{ "title": "...", "prompt": "..." }] }
Each prompt must be fully self-contained — the subagent has no conversation history.
Include all necessary context inside each prompt. Maximum ${count} subtasks.`;

  const user = `Decompose the next coding step from this session into ${count} independent subtasks that can run in parallel:

${context}

Return ${count} subtasks as JSON.`;

  const raw = await callBackend(backend, system, user);
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Decomposition model returned no JSON');

  return DecompositionSchema.parse(JSON.parse(match[0])).subtasks.slice(0, count);
}

async function synthesize(
  backend: IModelBackend,
  originalContext: string,
  results: Array<{ title: string; output: string }>,
): Promise<{ summary: string; nextStep: string; combinedOutput: string }> {
  const system = `You synthesize outputs from parallel coding subagents into a coherent result.
Return ONLY valid JSON matching: { "summary": "...", "nextStep": "...", "combinedOutput": "..." }`;

  const resultsText = results
    .map((r, i) => `--- Subagent ${i + 1}: ${r.title} ---\n${r.output.slice(0, 2000)}`)
    .join('\n\n');

  const user = `Original task context:\n${originalContext}\n\nSubagent results:\n${resultsText}\n\nSynthesize into a combined result.`;

  const raw = await callBackend(backend, system, user);
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Synthesis model returned no JSON');

  return SynthesisSchema.parse(JSON.parse(match[0]));
}

// ---------------------------------------------------------------------------
// Run one subagent non-interactively and capture its output.
// Uses the adapter's buildNonInteractiveArgs to get the right flags per CLI.
// ---------------------------------------------------------------------------

const DEFAULT_SUBAGENT_TIMEOUT_MS = 5 * 60 * 1_000; // 5 minutes

async function runSubagent(
  commandName: string,
  args: string[],
  index: number,
  timeoutMs = DEFAULT_SUBAGENT_TIMEOUT_MS,
): Promise<{ title: string; output: string; elapsed: number }> {
  const start = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawn(commandName, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`Subagent ${index + 1} timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const elapsed = Date.now() - start;
      if (code !== 0 && !stdout) {
        reject(new Error(`Subagent ${index + 1} exited ${code}: ${stderr.slice(0, 200)}`));
      } else {
        resolve({ title: `Subagent ${index + 1}`, output: stdout || stderr, elapsed });
      }
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface FanOutOptions {
  count: number;       // number of parallel subagents (default 3)
  timeoutMs?: number;  // per-subagent timeout in ms (default 5 minutes)
}

export async function fanOut(
  source: IAgentAdapter,
  backend: IModelBackend,
  opts: FanOutOptions,
): Promise<void> {
  const { count, timeoutMs } = opts;
  const commandName = source.commandName;

  // 1. Extract current session context
  process.stdout.write(chalk.dim('  Reading session context...'));
  const ctx = await source.extractSessionContext();
  if (!ctx || ctx.messages.length === 0) {
    console.log(chalk.red('\n  No session context found. Start working in an agent first.\n'));
    return;
  }
  console.log(chalk.dim(` ${ctx.messages.length} messages (${(ctx.inputTokensUsed / 1000).toFixed(0)}k tokens)`));

  const contextSummary = ctx.messages
    .slice(-20) // last 20 messages for decomposition prompt
    .map(m => `${m.role.toUpperCase()}: ${m.content.slice(0, 500)}`)
    .join('\n\n');

  // 2. Decompose task into N subtasks
  process.stdout.write(chalk.dim(`  Decomposing into ${count} subtasks...`));
  let subtasks: Array<{ title: string; prompt: string }>;
  try {
    subtasks = await decompose(backend, contextSummary, count);
    console.log(chalk.green(' done'));
  } catch (err) {
    console.log(chalk.red('\n  Decomposition failed: ' + (err instanceof Error ? err.message : String(err))));
    return;
  }

  // 3. Show the plan
  console.log('');
  console.log(chalk.bold(`  Fanning out to ${subtasks.length} subagents:\n`));
  subtasks.forEach((t, i) => {
    console.log(`  ${chalk.cyan(`[${i + 1}]`)} ${t.title}`);
  });
  console.log('');

  // 4. Run all subagents in parallel
  console.log(chalk.dim(`  Running ${commandName} in parallel...\n`));
  const spinChars = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let spinIdx = 0;
  const spinner = setInterval(() => {
    process.stdout.write(`\r  ${chalk.cyan(spinChars[spinIdx++ % spinChars.length])} Working...`);
  }, 100);

  const settled = await Promise.allSettled(
    subtasks.map((t, i) => {
      const subArgs = source.buildNonInteractiveArgs?.(t.prompt) ?? ['--print', t.prompt];
      return runSubagent(commandName, subArgs, i, timeoutMs);
    })
  );
  clearInterval(spinner);
  process.stdout.write('\r' + ' '.repeat(30) + '\r');

  const results: Array<{ title: string; output: string }> = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      console.log(chalk.green(`  ✓ [${i + 1}] ${subtasks[i].title} — ${(r.value.elapsed / 1000).toFixed(1)}s`));
      results.push({ title: subtasks[i].title, output: r.value.output });
    } else {
      console.log(chalk.red(`  ✗ [${i + 1}] ${subtasks[i].title} — ${r.reason?.message ?? 'failed'}`));
      results.push({ title: subtasks[i].title, output: `[FAILED: ${r.reason?.message ?? 'unknown error'}]` });
    }
  });

  if (results.every(r => r.output.startsWith('[FAILED'))) {
    console.log(chalk.red('\n  All subagents failed. Check that the agent CLI is installed and authenticated.\n'));
    return;
  }

  // 5. Synthesize
  console.log('');
  process.stdout.write(chalk.dim('  Synthesizing results...'));
  try {
    const synthesis = await synthesize(backend, contextSummary, results);
    console.log(chalk.green(' done\n'));

    console.log(chalk.bold('  ┌─ Fan-out Result ' + '─'.repeat(32) + '┐'));
    console.log(chalk.bold('\n  Summary\n'));
    console.log(synthesis.summary.split('\n').map(l => '  ' + l).join('\n'));
    console.log(chalk.bold('\n  Combined Output\n'));
    console.log(synthesis.combinedOutput.split('\n').map(l => '  ' + l).join('\n'));
    console.log(chalk.bold('\n  Next Step\n'));
    console.log('  ' + chalk.green(synthesis.nextStep));
    console.log(chalk.dim('\n  └' + '─'.repeat(49) + '┘\n'));
  } catch (err) {
    // Synthesis failed — just print raw outputs
    console.log(chalk.yellow(' synthesis failed, showing raw outputs\n'));
    results.forEach((r, i) => {
      console.log(chalk.bold(`\n  [${i + 1}] ${r.title}`));
      console.log(r.output.slice(0, 1000));
    });
  }
}
