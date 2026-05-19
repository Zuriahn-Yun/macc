import { spawn } from 'node:child_process';
import readline from 'node:readline';
import chalk from 'chalk';
import type { IAgentAdapter } from '../adapters/base.js';
import type { IModelBackend } from '../backends/base.js';
import { compressContext } from './compressor.js';
import { ContextStore } from './context-store.js';
import { printWarning, printHandoffMenu, printHandoffStart, printHandoffDone, printSwitchBanner } from '../utils/display.js';

const POLL_INTERVAL_MS = 5_000;
const WARNING_THRESHOLD = 90;
const HANDOFF_THRESHOLD = 98;

export async function watchAndOrchestrate(
  source: IAgentAdapter,
  targets: IAgentAdapter[],
  compressBackend: IModelBackend
): Promise<void> {
  console.log(chalk.bold(`\n  MACC — watching ${source.commandName} session`));
  console.log(chalk.dim('  Polling every 5 seconds. Press Ctrl+C to stop.\n'));

  let warnedOnce = false;

  const poll = setInterval(async () => {
    try {
      const snap = await source.getUsageSnapshot();
      if (!snap.isRunning) return;

      process.stdout.write(
        chalk.dim(`\r  ${source.commandName} context: ${snap.contextUsedPercent.toFixed(1)}%  `)
      );

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
      // ignore transient read errors during polling
    }
  }, POLL_INTERVAL_MS);

  // Keep alive until Ctrl+C
  await new Promise<void>(resolve => process.on('SIGINT', () => { clearInterval(poll); resolve(); }));
}

export async function triggerHandoff(
  source: IAgentAdapter,
  targets: IAgentAdapter[],
  compressBackend: IModelBackend
): Promise<void> {
  const ctx = await source.extractSessionContext();
  if (!ctx) {
    console.error(chalk.red(`\n  Could not read session context from ${source.commandName}.`));
    return;
  }

  const targetNames = targets.map(t => t.commandName);
  printHandoffMenu(targetNames);

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
  printHandoffStart(target.commandName);

  // Build a temporary ContextStore from the extracted session so the compressor
  // can call backend.stream() with the full conversation history.
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
    const packet = await compressContext(compressBackend, store, target.commandName, ctx.cwd);
    printHandoffDone(target.commandName, Date.now() - start);
    printSwitchBanner(target.commandName, packet.summary.ultimateGoal);

    const { args, stdin } = target.buildLaunchArgs(packet);
    const child = spawn(target.commandName, args, {
      stdio: stdin ? ['pipe', 'inherit', 'inherit'] : 'inherit',
      detached: false,
    });
    if (stdin && child.stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
    await new Promise<void>(resolve => child.on('close', resolve));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`\n  Handoff failed: ${message}`));
  }
}
