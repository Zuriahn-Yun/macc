import { spawn, execFileSync } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import chalk from 'chalk';
import type { IAgentAdapter } from '../adapters/base.js';
import type { IModelBackend } from '../backends/base.js';
import { compressWithFallback } from './compressor.js';
import { ContextStore } from './context-store.js';
import {
  printHandoffMenu,
  startHandoffProgress,
  printHandoffSummary,
  printSwitchBanner,
  printWarning,
  printDashboardHeader,
  printStatusHeader,
  printAgentRow,
} from '../utils/display.js';

const POLL_INTERVAL_MS = 5_000;
const MACC_DIR = path.join(os.homedir(), '.macc');
const PID_FILE = path.join(MACC_DIR, 'running.pid');
const SWITCH_TARGET_FILE = path.join(MACC_DIR, 'switch-target');

// Collect git status, diff --stat, and recent commits from the working directory.
// Returns null silently if cwd is not a git repo or git is not installed.
export function collectGitState(cwd: string): string | null {
  const git = (args: string[]): string => {
    try {
      return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) as string;
    } catch {
      return '';
    }
  };
  try {
    const status = git(['status', '--short']);
    const stat   = git(['diff', '--stat', 'HEAD']);
    const log    = git(['log', '--oneline', '-10']);
    const parts: string[] = ['[GIT STATE]'];
    if (status.trim()) parts.push(`Uncommitted changes:\n${status.trim()}`);
    if (stat.trim())   parts.push(`Diff vs HEAD:\n${stat.trim()}`);
    if (log.trim())    parts.push(`Recent commits:\n${log.trim()}`);
    return parts.length > 1 ? parts.join('\n\n') : null;
  } catch {
    return null;
  }
}

function writePid(): void {
  try {
    fs.mkdirSync(MACC_DIR, { recursive: true });
    fs.writeFileSync(PID_FILE, String(process.pid));
  } catch { /* non-fatal */ }
}

function clearPid(): void {
  try { fs.unlinkSync(PID_FILE); } catch { /* already gone */ }
}

// ---------------------------------------------------------------------------
// Compact status table — printed at the top of the terminal before handing
// off to the agent, and refreshed every 2 minutes while the agent runs.
// ---------------------------------------------------------------------------

async function printStatusTable(current: IAgentAdapter, others: IAgentAdapter[]): Promise<void> {
  const all = [current, ...others];
  const snapshots = await Promise.all(
    all.map(a => a.getUsageSnapshot().catch(() => null))
  );

  console.log('');
  console.log(chalk.bold('  ┌─ MACC ') + chalk.dim('─'.repeat(52) + '┐'));
  for (let i = 0; i < all.length; i++) {
    const snap = snapshots[i];
    const pct = snap?.contextUsedPercent ?? 0;
    const used = snap?.inputTokensUsed ?? 0;
    const total = snap?.contextWindowTokens ?? all[i].getContextWindowSize();
    const remaining = Math.max(0, total - used);
    const remainingK = remaining >= 1000 ? `${(remaining / 1000).toFixed(0)}k` : String(remaining);

    const filled = Math.round(Math.min(pct, 100) / 10);
    const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
    const pctStr = `${pct.toFixed(0)}%`.padStart(4);
    const remainStr = chalk.dim(`${remainingK} left`).padEnd(12);
    const running = snap?.isRunning ? chalk.green('●') : chalk.dim('○');
    const name = all[i].id.padEnd(14);
    const barStr = pct >= 98 ? chalk.red(bar) : pct >= 90 ? chalk.yellow(bar) : chalk.dim(bar);
    const active = i === 0 ? chalk.bold('→ ') : '  ';
    console.log(`  │ ${active}${running} ${name} ${barStr} ${pctStr}  ${remainStr} │`);
  }
  console.log(chalk.dim('  └' + '─'.repeat(59) + '┘'));
  console.log('');
}

// ---------------------------------------------------------------------------
// Main loop: start an agent, let the user work in it, rotate on exit if full.
// ---------------------------------------------------------------------------

export async function runWithRotation(
  agent: IAgentAdapter,
  targets: IAgentAdapter[],
  compressBackends: IModelBackend[],
  handoffPrompt?: string, // set when continuing from a previous agent
  resumeSessionId?: string, // set when returning to a previously used agent
  sessionMap: Map<string, string> = new Map(), // agentId → last session ID
): Promise<void> {
  // Build launch args. Resume takes priority over handoff prompt.
  const baseArgs = resumeSessionId && agent.buildResumeArgs
    ? agent.buildResumeArgs(resumeSessionId)
    : agent.buildBaseArgs?.() ?? [];
  const launchArgs = (!resumeSessionId && handoffPrompt)
    ? [...baseArgs, handoffPrompt]
    : baseArgs;

  console.log(chalk.bold(`\n  Starting ${agent.commandName}...`));
  if (handoffPrompt) {
    console.log(chalk.dim('  Session context loaded from previous agent.\n'));
  } else {
    console.log(chalk.dim('  To switch agents at any time:'));
    console.log(chalk.dim('    • Exit the agent normally (Ctrl+C or /exit) — MACC will ask where to go next'));
    console.log(chalk.dim('    • Or run ') + chalk.bold.white('macc switch') + chalk.dim(' in another terminal to switch immediately\n'));
  }

  // Capture session ID before launch so we can detect the new one after exit.
  const preLaunchSessionId = await agent.getActiveSessionId?.() ?? null;

  // Print the status table once before handing off the terminal.
  await printStatusTable(agent, targets);

  // Spawn the agent with the full terminal handed to it.
  const child = spawn(agent.commandName, launchArgs, { stdio: 'inherit' });

  // SIGUSR1 = manual switch request from "macc switch" command.
  // Kill the child so we regain the terminal and can show the menu.
  let forceSwitch = false;
  writePid();
  const sigusr1Handler = () => {
    forceSwitch = true;
    child.kill('SIGTERM');
  };
  process.once('SIGUSR1', sigusr1Handler);

  // Poll context silently in the background — never write to stdout while
  // the agent owns the terminal, it would corrupt the agent's UI.
  let lastSnapshot = await agent.getUsageSnapshot().catch(() => null);
  const monitor = setInterval(async () => {
    lastSnapshot = await agent.getUsageSnapshot().catch(() => lastSnapshot);
  }, POLL_INTERVAL_MS);

  // Wait for the user to exit the agent (Ctrl+C, /exit, "macc switch", etc.)
  await new Promise<void>(resolve => child.on('close', resolve));
  clearInterval(monitor);
  process.off('SIGUSR1', sigusr1Handler);
  clearPid();

  // Re-read context after exit for accuracy.
  const snap = await agent.getUsageSnapshot().catch(() => lastSnapshot);
  const pct = snap?.contextUsedPercent ?? 0;

  // Record the session that just ran so we can resume it later.
  const postExitSessionId = await agent.getActiveSessionId?.() ?? preLaunchSessionId;
  if (postExitSessionId) sessionMap.set(agent.id, postExitSessionId);

  console.log(''); // newline after agent's terminal output

  if (pct >= 85) {
    printWarning(pct, snap?.inputTokensUsed ?? 0, snap?.contextWindowTokens ?? agent.getContextWindowSize());
  } else {
    console.log(chalk.dim(`  Session ended. Context was at ${pct.toFixed(0)}%.`));
  }

  // Include the current agent in the menu so the user can return to it.
  const allTargets = [...targets, agent];

  // Refresh the dashboard before showing the menu.
  await printStatusTable(agent, targets);

  // Pick the next agent — either from a "macc switch <id>" file or via interactive menu.
  const target = await (async (): Promise<IAgentAdapter | null> => {
    if (fs.existsSync(SWITCH_TARGET_FILE)) {
      const requestedId = fs.readFileSync(SWITCH_TARGET_FILE, 'utf8').trim();
      fs.unlinkSync(SWITCH_TARGET_FILE);
      const found = allTargets.find(t => t.id === requestedId);
      if (found) {
        console.log(chalk.dim(`  Switching to ${found.id}...\n`));
        return found;
      }
      console.log(chalk.yellow(`  Agent "${requestedId}" not found — pick one:\n`));
    }

    const menuTitle = forceSwitch
      ? chalk.bold('  Manual switch — pick an agent:')
      : pct >= 85
        ? chalk.dim('  Rotate to another agent to continue?')
        : chalk.dim('  Switch to another agent?');
    console.log(menuTitle + '\n');

    const menuLabels = allTargets.map(t => {
      const canResume = sessionMap.has(t.id) && t.buildResumeArgs;
      return canResume ? `${t.id} (resume)` : t.id;
    });
    printHandoffMenu(menuLabels, forceSwitch);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>(r => rl.question(chalk.bold.green('> '), r));
    rl.close();

    const choice = parseInt(answer.trim(), 10);
    if (isNaN(choice) || choice === 0 || choice > allTargets.length) {
      console.log(chalk.dim('\n  Exiting MACC.\n'));
      return null;
    }
    return allTargets[choice - 1];
  })();

  if (!target) return;

  const storedSessionId = sessionMap.get(target.id) ?? undefined;
  const isResume = !!storedSessionId && !!target.buildResumeArgs;

  // When resuming, skip compression and just re-enter the session.
  if (isResume) {
    console.log(chalk.dim(`\n  Resuming ${target.id} session...\n`));
    const remaining = allTargets.filter(t => t.id !== target.id);
    await runWithRotation(target, remaining, compressBackends, undefined, storedSessionId, sessionMap);
    return;
  }

  // Give the user a chance to append notes before compression runs.
  const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log(chalk.dim('  Anything to add to the handoff context? (Enter to skip)'));
  const extraContext = await new Promise<string>(r => rl2.question(chalk.dim('  > '), r));
  rl2.close();

  const start = Date.now();
  const progress = startHandoffProgress();

  // Build a ContextStore from the extracted session for compression.
  const ctx = await agent.extractSessionContext();
  if (!ctx || ctx.messages.length === 0) {
    progress.finish(Date.now() - start);
    console.log(chalk.dim('  No session context available — starting fresh in ' + target.id + '.\n'));
    const remaining = allTargets.filter(t => t.id !== target.id);
    await runWithRotation(target, remaining, compressBackends, undefined, undefined, sessionMap);
    return;
  }

  const primaryBackend = compressBackends[0];
  const store = new ContextStore(
    primaryBackend.modelId,
    primaryBackend.contextWindowTokens,
    90, 98,
    'You are a helpful AI coding assistant.'
  );
  for (const m of ctx.messages) {
    if (m.role === 'user') store.addUserMessage(m.content);
    else store.addAssistantMessage(m.content, { inputTokens: 0, outputTokens: 0 });
  }

  // Append git state so the receiving agent knows exactly what changed on disk.
  const gitContext = collectGitState(ctx.cwd);
  if (gitContext) store.addUserMessage(gitContext);

  // Inject any extra notes the user added before compression.
  if (extraContext.trim()) store.addUserMessage(`[USER NOTE FOR HANDOFF] ${extraContext.trim()}`);

  try {
    const packet = await compressWithFallback(
      compressBackends, store, target.id, ctx.cwd,
      agent.id === 'claude-code' ? 'anthropic' : undefined,
      progress.onProgress,
    );
    progress.finish(Date.now() - start);
    printHandoffSummary(packet.summary);

    const remaining = allTargets.filter(t => t.id !== target.id);
    await runWithRotation(target, remaining, compressBackends, packet.handoffPrompt, undefined, sessionMap);
  } catch (err: unknown) {
    progress.finish(Date.now() - start);
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`\n  Compression failed: ${msg}\n`));
  }
}

// ---------------------------------------------------------------------------
// One-shot status snapshot (macc status command).
// ---------------------------------------------------------------------------

export async function printStatusOnce(
  agents: Array<{ adapter: IAgentAdapter; installed: boolean }>,
): Promise<void> {
  printStatusHeader();
  for (const { adapter, installed: isInstalled } of agents) {
    if (!isInstalled) {
      printAgentRow(adapter.id, false, false, 0, 0, adapter.getContextWindowSize());
      continue;
    }
    try {
      const snap = await adapter.getUsageSnapshot();
      printAgentRow(adapter.id, true, snap.isRunning, snap.contextUsedPercent, snap.inputTokensUsed, snap.contextWindowTokens, snap.isEstimated);
    } catch {
      printAgentRow(adapter.id, true, false, 0, 0, adapter.getContextWindowSize());
    }
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// Passive dashboard: monitors all agents without launching them.
// ---------------------------------------------------------------------------

export async function watchAll(
  agents: Array<{ adapter: IAgentAdapter; installed: boolean }>,
  compressBackends: IModelBackend[]
): Promise<void> {
  const installed = agents.filter(a => a.installed).map(a => a.adapter);
  const warnedAgents = new Set<string>();

  let signalDone: (() => void) | undefined;
  const donePromise = new Promise<void>(resolve => { signalDone = resolve; });

  let isRedrawing = false;
  let hasFiredHandoff = false;

  const redraw = async () => {
    // Skip if a redraw or handoff is already in progress — prevents concurrent
    // redraws from corrupting the terminal and triggering duplicate handoffs.
    if (isRedrawing || hasFiredHandoff) return;
    isRedrawing = true;
    process.stdout.write('\x1b[H\x1b[J');
    printDashboardHeader();

    for (const { adapter, installed: isInstalled } of agents) {
      if (!isInstalled) {
        printAgentRow(adapter.id, false, false, 0, 0, adapter.getContextWindowSize());
        continue;
      }
      try {
        const snap = await adapter.getUsageSnapshot();
        printAgentRow(adapter.id, true, snap.isRunning, snap.contextUsedPercent, snap.inputTokensUsed, snap.contextWindowTokens, snap.isEstimated);

        if (snap.isRunning && snap.contextUsedPercent >= 98) {
          hasFiredHandoff = true;
          clearInterval(poll);
          isRedrawing = false;
          console.log('');
          printWarning(snap.contextUsedPercent, snap.inputTokensUsed, snap.contextWindowTokens);
          const otherTargets = installed.filter(a => a.id !== adapter.id);
          await triggerHandoff(adapter, otherTargets, compressBackends);
          signalDone?.();
          return;
        }

        if (snap.isRunning && snap.contextUsedPercent >= 90 && !warnedAgents.has(adapter.id)) {
          warnedAgents.add(adapter.id);
        }
      } catch {
        printAgentRow(adapter.id, true, false, 0, 0, adapter.getContextWindowSize());
      }
    }
    isRedrawing = false;
  };

  process.stdout.write('\x1b[2J');
  await redraw();
  const poll = setInterval(redraw, POLL_INTERVAL_MS);

  await Promise.race([
    donePromise,
    new Promise<void>(resolve => process.once('SIGINT', () => { clearInterval(poll); resolve(); })),
  ]);
  console.log(chalk.dim('\n  MACC stopped.\n'));
}

// ---------------------------------------------------------------------------
// Manual one-shot handoff (macc handoff command).
// ---------------------------------------------------------------------------

export async function triggerHandoff(
  source: IAgentAdapter,
  targets: IAgentAdapter[],
  compressBackends: IModelBackend[]
): Promise<void> {
  const ctx = await source.extractSessionContext();
  if (!ctx) {
    console.error(chalk.red(`\n  Could not read session from ${source.id}.\n`));
    return;
  }

  if (targets.length === 0) {
    console.error(chalk.red('\n  No other agents installed to hand off to.\n'));
    return;
  }

  printHandoffMenu(targets.map(t => t.id));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>(r => rl.question(chalk.bold.green('> '), r));
  rl.close();

  const choice = parseInt(answer.trim(), 10);
  if (isNaN(choice) || choice < 1 || choice > targets.length) {
    console.log(chalk.dim('\n  Handoff cancelled.\n'));
    return;
  }

  const target = targets[choice - 1];
  const start = Date.now();
  const progress = startHandoffProgress();

  const primaryBackend = compressBackends[0];
  const store = new ContextStore(
    primaryBackend.modelId,
    primaryBackend.contextWindowTokens,
    90, 98,
    'You are a helpful AI coding assistant.'
  );
  for (const m of ctx.messages) {
    if (m.role === 'user') store.addUserMessage(m.content);
    else store.addAssistantMessage(m.content, { inputTokens: 0, outputTokens: 0 });
  }

  const gitContext = collectGitState(ctx.cwd);
  if (gitContext) store.addUserMessage(gitContext);

  try {
    const packet = await compressWithFallback(
      compressBackends, store, target.id, ctx.cwd,
      source.id === 'claude-code' ? 'anthropic' : undefined,
      progress.onProgress,
    );
    progress.finish(Date.now() - start);
    printHandoffSummary(packet.summary);

    const remaining = targets.filter(t => t.id !== target.id);
    await runWithRotation(target, remaining, compressBackends, packet.handoffPrompt, undefined, new Map());
  } catch (err: unknown) {
    progress.finish(Date.now() - start);
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`\n  Handoff failed: ${msg}\n`));
  }
}
