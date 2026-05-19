import { spawn } from 'node:child_process';
import readline from 'node:readline';
import chalk from 'chalk';
import type { IAgentAdapter } from '../adapters/base.js';
import type { IModelBackend } from '../backends/base.js';
import { compressContext } from './compressor.js';
import { ContextStore } from './context-store.js';
import {
  printDashboardHeader,
  printAgentRow,
  printWarning,
  printHandoffMenu,
  printHandoffStart,
  printHandoffDone,
  printSwitchBanner,
} from '../utils/display.js';

const POLL_INTERVAL_MS = 5_000;
const WARNING_THRESHOLD = 90;
const HANDOFF_THRESHOLD = 98;

interface AgentEntry {
  adapter: IAgentAdapter;
  installed: boolean;
}

// Watches all installed agents. When any hits the threshold, triggers a handoff.
export async function watchAll(
  agents: AgentEntry[],
  compressBackend: IModelBackend
): Promise<void> {
  const installed = agents.filter(a => a.installed).map(a => a.adapter);
  const warnedAgents = new Set<string>();

  const redraw = async () => {
    // Move cursor to top and overwrite dashboard lines
    process.stdout.write('\x1b[H\x1b[J'); // clear screen
    printDashboardHeader();

    for (const { adapter, installed: isInstalled } of agents) {
      if (!isInstalled) {
        printAgentRow(adapter.id, false, false, 0, 0, adapter.getContextWindowSize());
        continue;
      }
      try {
        const snap = await adapter.getUsageSnapshot();
        printAgentRow(adapter.id, true, snap.isRunning, snap.contextUsedPercent, snap.inputTokensUsed, snap.contextWindowTokens);

        if (snap.isRunning && snap.contextUsedPercent >= HANDOFF_THRESHOLD) {
          clearInterval(poll);
          console.log('');
          printWarning(snap.contextUsedPercent, snap.inputTokensUsed, snap.contextWindowTokens);
          const targets = installed.filter(a => a.id !== adapter.id);
          await triggerHandoff(adapter, targets, compressBackend);
          return;
        }

        if (snap.isRunning && snap.contextUsedPercent >= WARNING_THRESHOLD && !warnedAgents.has(adapter.id)) {
          warnedAgents.add(adapter.id);
        }
      } catch {
        printAgentRow(adapter.id, true, false, 0, 0, adapter.getContextWindowSize());
      }
    }

    // Show warning line if any agent is near limit
    const nearLimit = agents.find(a => warnedAgents.has(a.adapter.id));
    if (nearLimit) {
      console.log(chalk.yellow('\n  ⚠  One or more agents are approaching their context limit.'));
    }
  };

  process.stdout.write('\x1b[2J'); // initial clear
  await redraw();
  const poll = setInterval(redraw, POLL_INTERVAL_MS);

  await new Promise<void>(resolve => {
    process.on('SIGINT', () => { clearInterval(poll); resolve(); });
  });
  console.log(chalk.dim('\n  MACC stopped.\n'));
}

// Watches a single agent (used by `macc watch --source <agent>`).
export async function watchAndOrchestrate(
  source: IAgentAdapter,
  targets: IAgentAdapter[],
  compressBackend: IModelBackend
): Promise<void> {
  console.log(chalk.bold(`\n  MACC — watching ${source.id}`));
  console.log(chalk.dim('  Polling every 5 seconds. Press Ctrl+C to stop.\n'));

  let warnedOnce = false;

  const poll = setInterval(async () => {
    try {
      const snap = await source.getUsageSnapshot();
      if (!snap.isRunning) {
        process.stdout.write(chalk.dim(`\r  ${source.id}: not running  `));
        return;
      }

      process.stdout.write(chalk.dim(`\r  ${source.id}: ${snap.contextUsedPercent.toFixed(1)}%  `));

      if (snap.contextUsedPercent >= HANDOFF_THRESHOLD) {
        clearInterval(poll);
        console.log('');
        printWarning(snap.contextUsedPercent, snap.inputTokensUsed, snap.contextWindowTokens);
        await triggerHandoff(source, targets, compressBackend);
      } else if (snap.contextUsedPercent >= WARNING_THRESHOLD && !warnedOnce) {
        warnedOnce = true;
        console.log('');
        printWarning(snap.contextUsedPercent, snap.inputTokensUsed, snap.contextWindowTokens);
      }
    } catch {
      // ignore transient read errors
    }
  }, POLL_INTERVAL_MS);

  await new Promise<void>(resolve => {
    process.on('SIGINT', () => { clearInterval(poll); resolve(); });
  });
}

export async function triggerHandoff(
  source: IAgentAdapter,
  targets: IAgentAdapter[],
  compressBackend: IModelBackend
): Promise<void> {
  const ctx = await source.extractSessionContext();
  if (!ctx) {
    console.error(chalk.red(`\n  Could not read session context from ${source.id}.`));
    console.error(chalk.dim('  Make sure the agent has an active session in the current directory.'));
    return;
  }

  if (targets.length === 0) {
    console.error(chalk.red('\n  No other agents installed to hand off to.'));
    console.error(chalk.dim('  Install claude, gemini, codex, or qoder and try again.'));
    return;
  }

  printHandoffMenu(targets.map(t => t.id));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>(resolve => rl.question(chalk.bold.green('> '), resolve));
  rl.close();

  const choice = parseInt(answer.trim(), 10);
  if (isNaN(choice) || choice < 1 || choice > targets.length) {
    console.log(chalk.dim('\n  Handoff cancelled.'));
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

    const { args, stdin } = target.buildLaunchArgs(packet);

    console.log(chalk.dim(`  Launching ${target.commandName}...\n`));

    const child = spawn(target.commandName, args, {
      stdio: stdin ? ['pipe', 'inherit', 'inherit'] : 'inherit',
      detached: false,
    });
    if (stdin && child.stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
    // Hand control to the new agent process — wait for it to exit.
    await new Promise<void>(resolve => child.on('close', resolve));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`\n  Handoff failed: ${message}`));
  }
}
