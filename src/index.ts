#!/usr/bin/env node
import { Command } from 'commander';
import readline from 'node:readline';
import chalk from 'chalk';
import { startSession } from './repl/session.js';
import { listModels, detectAvailableBackend } from './backends/registry.js';
import { discoverAdapters, allAdapters } from './adapters/registry.js';
import { runWithRotation, watchAll, triggerHandoff } from './core/orchestrator.js';

const program = new Command();

program
  .name('macc')
  .description('Run any AI coding agent and rotate to the next one when context fills up')
  .version('0.3.1');

// Default: interactive agent launcher with auto-rotation
program
  .command('start', { isDefault: true })
  .description('Start an agent and rotate to another when context is full')
  .option('-a, --agent <id>', 'agent to start: claude-code, gemini-cli, codex, qodo')
  .action(async (opts) => {
    const cwd = process.cwd();
    const adapters = discoverAdapters(cwd);

    if (adapters.length === 0) {
      console.error(chalk.red('\n  No supported agents found on PATH.'));
      console.error(chalk.dim('  Install one of: claude, gemini, codex, qoder\n'));
      process.exit(1);
    }

    const backend = await detectAvailableBackend();
    if (!backend) {
      console.error(chalk.red('\n  No AI credentials found for compression.'));
      console.error(chalk.dim('  Log in: claude auth login  OR  set ANTHROPIC_API_KEY / GOOGLE_API_KEY\n'));
      process.exit(1);
    }

    let chosen = opts.agent
      ? adapters.find(a => a.id === opts.agent)
      : null;

    if (!chosen && adapters.length === 1) {
      chosen = adapters[0];
    }

    if (!chosen) {
      // Ask the user to pick
      console.log(chalk.bold('\n  MACC — Agent Rotator'));
      console.log(chalk.dim('  Pick an agent to start:\n'));
      adapters.forEach((a, i) => {
        const ctx = (a.getContextWindowSize() / 1000).toFixed(0);
        console.log(`    [${i + 1}] ${a.id.padEnd(14)} ${chalk.dim(`${ctx}k ctx`)}`);
      });
      console.log('');

      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>(r => rl.question(chalk.bold.green('> '), r));
      rl.close();

      const n = parseInt(answer.trim(), 10);
      if (isNaN(n) || n < 1 || n > adapters.length) {
        console.log(chalk.dim('\n  Cancelled.\n'));
        process.exit(0);
      }
      chosen = adapters[n - 1];
    }

    const targets = adapters.filter(a => a.id !== chosen!.id);
    await runWithRotation(chosen!, targets, backend);
  });

// Passive monitor (dashboard only, does not launch agents)
program
  .command('watch')
  .description('Dashboard — monitor running agents without launching them')
  .action(async () => {
    const cwd = process.cwd();
    const backend = await detectAvailableBackend();
    if (!backend) {
      console.error(chalk.red('\n  No AI credentials found for compression.\n'));
      process.exit(1);
    }
    const agents = allAdapters(cwd);
    await watchAll(agents, backend);
  });

// Manual one-shot handoff
program
  .command('handoff')
  .description('Compress the active session and hand it off to another agent')
  .option('-s, --source <agent>', 'agent to read from (first installed if omitted)')
  .action(async (opts) => {
    const cwd = process.cwd();
    const adapters = discoverAdapters(cwd);
    if (adapters.length < 2) {
      console.error(chalk.red('\n  Need at least two agents installed to hand off.\n'));
      process.exit(1);
    }
    const source = opts.source ? adapters.find(a => a.id === opts.source) : adapters[0];
    if (!source) { console.error(chalk.red(`\n  Agent "${opts.source}" not found.\n`)); process.exit(1); }
    const targets = adapters.filter(a => a.id !== source.id);
    const backend = await detectAvailableBackend();
    if (!backend) { console.error(chalk.red('\n  No AI credentials found.\n')); process.exit(1); }
    await triggerHandoff(source, targets, backend);
  });

// Direct AI chat (for testing / no agent CLIs installed)
program
  .command('chat')
  .description('Direct AI chat (switches AI models, not agent CLIs)')
  .option('-m, --model <model>', 'model to use (default: claude-sonnet-4-6)')
  .option('--debug', 'verbose API debug output')
  .action(async (opts) => {
    await startSession(opts.model, opts.debug ?? false);
  });

program
  .command('models')
  .description('List models available for macc chat')
  .action(() => {
    console.log('');
    console.log(chalk.bold('  Models for macc chat:'));
    listModels().forEach(m => console.log(`    ${m}`));
    console.log('');
  });

program.parse();
