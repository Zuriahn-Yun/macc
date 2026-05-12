import readline from 'node:readline';
import process from 'node:process';
import chalk from 'chalk';
import { getBackend, detectAvailableBackend } from '../backends/registry.js';
import { runSetupWizard } from '../commands/setup.js';
import { ContextStore } from '../core/context-store.js';
import { compressContext } from '../core/compressor.js';
import { loadConfig } from '../utils/config.js';
import {
  printWelcome,
  printUsageBar,
  printWarning,
  printHandoffMenu,
  printHandoffStart,
  printHandoffDone,
  printSwitchBanner,
  printHelp,
} from '../utils/display.js';

const SYSTEM_PROMPT = `You are a helpful AI coding assistant. You help users write, debug, and understand code.
Be concise and practical. When working with code, prefer showing changes over explaining them.`;

export async function startSession(initialModelId?: string): Promise<void> {
  const config = await loadConfig();

  let backend: ReturnType<typeof getBackend>;

  if (initialModelId) {
    backend = getBackend(initialModelId);
    if (!(await backend.isAvailable())) {
      console.error(chalk.red(`\n  Error: No API key found for ${initialModelId}.`));
      console.error(chalk.dim(`  Set ANTHROPIC_API_KEY, GOOGLE_API_KEY, or OPENAI_API_KEY and try again.\n`));
      process.exit(1);
    }
  } else {
    const detected = await detectAvailableBackend();
    backend = detected ?? await runSetupWizard();
  }

  let store = new ContextStore(
    backend.modelId,
    backend.contextWindowTokens,
    config.warningThresholdPercent,
    config.autoPromptThresholdPercent,
    SYSTEM_PROMPT
  );

  printWelcome(backend.modelId);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.bold.green('\n> '),
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    // Slash commands
    if (input.startsWith('/')) {
      await handleCommand(input, store, backend, config.handoffOrder);
      rl.prompt();
      return;
    }

    rl.pause();

    store.addUserMessage(input);
    console.log('');

    let fullResponse = '';
    try {
      const usage = await backend.stream(
        store.getMessages(),
        SYSTEM_PROMPT,
        chunk => {
          if (!chunk.done) {
            process.stdout.write(chunk.text);
            fullResponse += chunk.text;
          }
        }
      );

      store.addAssistantMessage(fullResponse, usage);

      console.log('');
      const snapshot = store.getSnapshot();
      printUsageBar(snapshot.usagePercent, snapshot.inputTokensUsed, snapshot.contextWindowTokens);

      // Warn at threshold
      if (snapshot.nearLimit && !snapshot.overLimit) {
        printWarning(snapshot.usagePercent, snapshot.inputTokensUsed, snapshot.contextWindowTokens);
      }

      // Auto-prompt handoff at limit
      if (snapshot.overLimit) {
        printWarning(snapshot.usagePercent, snapshot.inputTokensUsed, snapshot.contextWindowTokens);
        const result = await promptHandoff(store, backend, config.handoffOrder, rl);
        if (result) {
          backend = result.backend;
          store = result.store;
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`\n  Error: ${message}`));
    }

    rl.resume();
    rl.prompt();
  });

  rl.on('close', () => {
    console.log(chalk.dim('\n  Goodbye.\n'));
    process.exit(0);
  });
}

async function handleCommand(
  input: string,
  store: ContextStore,
  backend: ReturnType<typeof getBackend>,
  handoffOrder: string[]
): Promise<void> {
  const cmd = input.split(' ')[0];
  switch (cmd) {
    case '/status': {
      const snap = store.getSnapshot();
      console.log('');
      printUsageBar(snap.usagePercent, snap.inputTokensUsed, snap.contextWindowTokens);
      console.log(chalk.dim(`  Model: ${snap.modelId}  |  Turns: ${store.getTurnCount()}`));
      break;
    }
    case '/model':
      console.log(chalk.dim(`\n  Current model: ${backend.modelId}`));
      break;
    case '/help':
      printHelp();
      break;
    case '/switch':
      console.log(chalk.dim('\n  Use /switch to manually trigger handoff — not yet implemented in MVP.'));
      break;
    default:
      console.log(chalk.dim(`\n  Unknown command: ${cmd}. Type /help for available commands.`));
  }
}

async function promptHandoff(
  store: ContextStore,
  currentBackend: ReturnType<typeof getBackend>,
  handoffOrder: string[],
  rl: readline.Interface
): Promise<{ backend: ReturnType<typeof getBackend>; store: ContextStore } | null> {
  const options = handoffOrder.filter(m => m !== currentBackend.modelId);
  printHandoffMenu(options);

  return new Promise(resolve => {
    rl.question(chalk.bold.green('> '), async (answer) => {
      const choice = parseInt(answer.trim(), 10);
      if (isNaN(choice) || choice > options.length) {
        console.log(chalk.dim('\n  Staying in current session.'));
        resolve(null);
        return;
      }

      const toModel = options[choice - 1];
      const cwd = process.cwd();

      const start = Date.now();
      printHandoffStart(toModel);

      try {
        const packet = await compressContext(currentBackend, store, toModel, cwd);
        printHandoffDone(toModel, Date.now() - start);

        const newBackend = getBackend(toModel);
        const newStore = new ContextStore(
          newBackend.modelId,
          newBackend.contextWindowTokens,
          90,
          98,
          packet.handoffPrompt
        );

        printSwitchBanner(toModel, packet.summary.ultimateGoal);
        resolve({ backend: newBackend, store: newStore });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\n  Compression failed: ${message}`));
        resolve(null);
      }
    });
  });
}
