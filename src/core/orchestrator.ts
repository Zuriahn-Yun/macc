import { spawn } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

const POLL_INTERVAL_MS = 5_000;
const MACC_DIR = path.join(os.homedir(), '.macc');
const PID_FILE = path.join(MACC_DIR, 'running.pid');

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
  // Build launch args: base flags (e.g. --append-system-prompt) always present;
  // handoff prompt appended as positional arg when continuing from another agent.
  const baseArgs = agent.buildBaseArgs?.() ?? [];
  const launchArgs = handoffPrompt
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

  console.log(''); // newline after agent's terminal output

  if (pct >= 85) {
    printWarning(pct, snap?.inputTokensUsed ?? 0, snap?.contextWindowTokens ?? agent.getContextWindowSize());
  } else {
    console.log(chalk.dim(`  Session ended. Context was at ${pct.toFixed(0)}%.`));
  }

  if (targets.length === 0) {
    console.log(chalk.dim('  No other agents available.\n'));
    return;
  }

  // Always offer to switch — user may want to rotate even at low context.
  const menuTitle = forceSwitch
    ? chalk.bold('  Manual switch — pick an agent:')
    : pct >= 85
      ? chalk.dim('  Rotate to another agent to continue?')
      : chalk.dim('  Switch to another agent? (context still has room)');
  console.log(menuTitle + '\n');

  printHandoffMenu(targets.map(t => t.id), forceSwitch);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>(r => rl.question(chalk.bold.green('> '), r));
  rl.close();

  const choice = parseInt(answer.trim(), 10);
  if (isNaN(choice) || choice === 0 || choice > targets.length) {
    console.log(chalk.dim('\n  Exiting MACC.\n'));
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
