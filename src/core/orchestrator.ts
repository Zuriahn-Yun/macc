import { spawn } from 'node:child_process';
import readline from 'node:readline';
import chalk from 'chalk';
import type { IAgentAdapter } from '../adapters/base.js';
import type { IModelBackend } from '../backends/base.js';
import { compressContext } from './compressor.js';
import { ContextStore } from './context-store.js';
import {
  printHandoffMenu,
  printHandoffStart,
  printHandoffDone,
  printSwitchBanner,
  printWarning,
  printDashboardHeader,
  printAgentRow,
} from '../utils/display.js';

const POLL_INTERVAL_MS = 5_000;        // how often to sample context internally
const DASHBOARD_REFRESH_MS = 120_000;  // how often to reprint the status table (2 min)

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
  console.log(chalk.bold('  ┌─ MACC ') + chalk.dim('─'.repeat(42) + '┐'));
  for (let i = 0; i < all.length; i++) {
    const snap = snapshots[i];
    const pct = snap?.contextUsedPercent ?? 0;
    const filled = Math.round(Math.min(pct, 100) / 10);
    const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
    const pctStr = `${pct.toFixed(0)}%`.padStart(4);
    const running = snap?.isRunning ? chalk.green('●') : chalk.dim('○');
    const name = all[i].id.padEnd(14);
    const barStr = pct >= 98 ? chalk.red(bar) : pct >= 90 ? chalk.yellow(bar) : chalk.dim(bar);
    const active = i === 0 ? chalk.bold('→ ') : '  ';
    console.log(`  │ ${active}${running} ${name} ${barStr} ${pctStr} │`);
  }
  console.log(chalk.dim('  └' + '─'.repeat(49) + '┘'));
  console.log('');
}

// ---------------------------------------------------------------------------
// Main loop: start an agent, let the user work in it, rotate on exit if full.
// ---------------------------------------------------------------------------

export async function runWithRotation(
  agent: IAgentAdapter,
  targets: IAgentAdapter[],
  compressBackend: IModelBackend,
  handoffPrompt?: string // set when continuing from a previous agent
): Promise<void> {
  // Build launch args: if this is a continuation, inject the handoff prompt
  const launchArgs = handoffPrompt
    ? [handoffPrompt]
    : [];

  console.log(chalk.bold(`\n  Starting ${agent.commandName}...`));
  if (handoffPrompt) {
    console.log(chalk.dim('  Session context loaded from previous agent.\n'));
  } else {
    console.log(chalk.dim('  MACC is watching context. When you exit, it will offer to rotate.\n'));
  }

  // Print the status table once before handing off the terminal.
  await printStatusTable(agent, targets);

  // Spawn the agent with the full terminal handed to it.
  const child = spawn(agent.commandName, launchArgs, { stdio: 'inherit' });

  // Poll context in the background while the user works.
  let lastSnapshot = await agent.getUsageSnapshot().catch(() => null);
  const monitor = setInterval(async () => {
    lastSnapshot = await agent.getUsageSnapshot().catch(() => lastSnapshot);
  }, POLL_INTERVAL_MS);

  // Reprint the status table every 2 minutes (the agent owns the terminal, so
  // this will appear between turns when there's no active output).
  const dashTimer = setInterval(async () => {
    await printStatusTable(agent, targets);
  }, DASHBOARD_REFRESH_MS);

  // Wait for the user to exit the agent (Ctrl+C, /exit, etc.)
  await new Promise<void>(resolve => child.on('close', resolve));
  clearInterval(monitor);
  clearInterval(dashTimer);

  // Re-read context after exit for accuracy.
  const snap = await agent.getUsageSnapshot().catch(() => lastSnapshot);
  const pct = snap?.contextUsedPercent ?? 0;

  console.log(''); // newline after agent's terminal output

  if (pct < 70 || targets.length === 0) {
    // Not near the limit — no rotation needed.
    if (pct > 0) {
      console.log(chalk.dim(`  Session ended. Context was at ${pct.toFixed(0)}%.`));
    }
    return;
  }

  // Context was high — offer to rotate.
  printWarning(pct, snap?.inputTokensUsed ?? 0, snap?.contextWindowTokens ?? agent.getContextWindowSize());
  console.log(chalk.dim('  Session ended. Rotate to another agent to continue?\n'));

  printHandoffMenu(targets.map(t => t.id));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>(r => rl.question(chalk.bold.green('> '), r));
  rl.close();

  const choice = parseInt(answer.trim(), 10);
  if (isNaN(choice) || choice < 1 || choice > targets.length) {
    console.log(chalk.dim('\n  Staying put. Run macc again to continue.\n'));
    return;
  }

  const target = targets[choice - 1];
  const start = Date.now();
  printHandoffStart(target.id);

  // Build a ContextStore from the extracted session for compression.
  const ctx = await agent.extractSessionContext();
  if (!ctx || ctx.messages.length === 0) {
    console.error(chalk.red('\n  Could not read session context — handoff aborted.\n'));
    return;
  }

  const store = new ContextStore(
    compressBackend.modelId,
    compressBackend.contextWindowTokens,
    90, 98,
    'You are a helpful AI coding assistant.'
  );
  for (const m of ctx.messages) {
    if (m.role === 'user') store.addUserMessage(m.content);
    else store.addAssistantMessage(m.content, { inputTokens: 0, outputTokens: 0 });
  }

  try {
    const packet = await compressContext(compressBackend, store, target.id, ctx.cwd);
    printHandoffDone(target.id, Date.now() - start);
    printSwitchBanner(target.id, packet.summary.ultimateGoal);

    // Recurse: start the new agent with the handoff prompt, and so on.
    const remaining = targets.filter(t => t.id !== target.id);
    await runWithRotation(target, remaining, compressBackend, packet.handoffPrompt);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`\n  Compression failed: ${msg}\n`));
  }
}

// ---------------------------------------------------------------------------
// Passive dashboard: monitors all agents without launching them.
// ---------------------------------------------------------------------------

export async function watchAll(
  agents: Array<{ adapter: IAgentAdapter; installed: boolean }>,
  compressBackend: IModelBackend
): Promise<void> {
  const installed = agents.filter(a => a.installed).map(a => a.adapter);
  const warnedAgents = new Set<string>();

  const redraw = async () => {
    process.stdout.write('\x1b[H\x1b[J');
    printDashboardHeader();

    for (const { adapter, installed: isInstalled } of agents) {
      if (!isInstalled) {
        printAgentRow(adapter.id, false, false, 0, 0, adapter.getContextWindowSize());
        continue;
      }
      try {
        const snap = await adapter.getUsageSnapshot();
        printAgentRow(adapter.id, true, snap.isRunning, snap.contextUsedPercent, snap.inputTokensUsed, snap.contextWindowTokens);

        if (snap.isRunning && snap.contextUsedPercent >= 98) {
          clearInterval(poll);
          console.log('');
          printWarning(snap.contextUsedPercent, snap.inputTokensUsed, snap.contextWindowTokens);
          const otherTargets = installed.filter(a => a.id !== adapter.id);
          await triggerHandoff(adapter, otherTargets, compressBackend);
          return;
        }

        if (snap.isRunning && snap.contextUsedPercent >= 90 && !warnedAgents.has(adapter.id)) {
          warnedAgents.add(adapter.id);
        }
      } catch {
        printAgentRow(adapter.id, true, false, 0, 0, adapter.getContextWindowSize());
      }
    }
  };

  process.stdout.write('\x1b[2J');
  await redraw();
  const poll = setInterval(redraw, POLL_INTERVAL_MS);

  await new Promise<void>(resolve => process.on('SIGINT', () => { clearInterval(poll); resolve(); }));
  console.log(chalk.dim('\n  MACC stopped.\n'));
}

// ---------------------------------------------------------------------------
// Manual one-shot handoff (macc handoff command).
// ---------------------------------------------------------------------------

export async function triggerHandoff(
  source: IAgentAdapter,
  targets: IAgentAdapter[],
  compressBackend: IModelBackend
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
  printHandoffStart(target.id);

  const store = new ContextStore(
    compressBackend.modelId,
    compressBackend.contextWindowTokens,
    90, 98,
    'You are a helpful AI coding assistant.'
  );
  for (const m of ctx.messages) {
    if (m.role === 'user') store.addUserMessage(m.content);
    else store.addAssistantMessage(m.content, { inputTokens: 0, outputTokens: 0 });
  }

  try {
    const packet = await compressContext(compressBackend, store, target.id, ctx.cwd);
    printHandoffDone(target.id, Date.now() - start);
    printSwitchBanner(target.id, packet.summary.ultimateGoal);

    const remaining = targets.filter(t => t.id !== target.id);
    await runWithRotation(target, remaining, compressBackend, packet.handoffPrompt);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`\n  Handoff failed: ${msg}\n`));
  }
}
