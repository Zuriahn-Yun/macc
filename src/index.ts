#!/usr/bin/env node
import { Command } from 'commander';
import { startSession } from './repl/session.js';
import { listModels, detectAvailableBackend } from './backends/registry.js';
import { discoverAdapters } from './adapters/registry.js';
import { watchAndOrchestrate, triggerHandoff } from './core/orchestrator.js';
import chalk from 'chalk';

const program = new Command();

program
  .name('macc')
  .description('Multi-Agent Coding Client — AI coding assistant that switches models when context limits are hit')
  .version('0.1.0')
  .option('-m, --model <model>', 'model to use (default: claude-sonnet-4-6)')
  .option('--debug', 'print verbose API debug info to stderr')
  .action(async (options) => {
    await startSession(options.model, options.debug ?? false);
  });

program
  .command('models')
  .description('List all available models')
  .action(() => {
    console.log('');
    console.log(chalk.bold('  Available models:'));
    listModels().forEach(m => console.log(`    ${m}`));
    console.log('');
  });

program
  .command('watch')
  .description('Monitor the active Claude Code / Gemini CLI session and trigger handoff when context is near the limit')
  .option('-s, --source <agent>', 'agent to watch: claude-code, gemini-cli, qodo (auto-detects if omitted)')
  .action(async (opts) => {
    const adapters = discoverAdapters();
    if (adapters.length === 0) {
      console.error(chalk.red('\n  No supported agents found on PATH (claude, gemini, qoder).\n'));
      process.exit(1);
    }
    const source = opts.source
      ? adapters.find(a => a.id === opts.source)
      : adapters.find(a => a.isRunning()) ?? adapters[0];
    if (!source) {
      console.error(chalk.red(`\n  Agent "${opts.source}" not found or not installed.\n`));
      process.exit(1);
    }
    const targets = adapters.filter(a => a.id !== source.id);
    const backend = await detectAvailableBackend();
    if (!backend) {
      console.error(chalk.red('\n  No AI backend credentials found for compression. Run macc to set one up.\n'));
      process.exit(1);
    }
    await watchAndOrchestrate(source, targets, backend);
  });

program
  .command('handoff')
  .description('Manually compress the active session and hand it off to another agent')
  .option('-s, --source <agent>', 'agent to read from (auto-detects if omitted)')
  .action(async (opts) => {
    const adapters = discoverAdapters();
    if (adapters.length < 2) {
      console.error(chalk.red('\n  Need at least two supported agents installed to perform a handoff.\n'));
      process.exit(1);
    }
    const source = opts.source
      ? adapters.find(a => a.id === opts.source)
      : adapters[0];
    if (!source) {
      console.error(chalk.red(`\n  Agent "${opts.source}" not found.\n`));
      process.exit(1);
    }
    const targets = adapters.filter(a => a.id !== source.id);
    const backend = await detectAvailableBackend();
    if (!backend) {
      console.error(chalk.red('\n  No AI backend credentials found for compression. Run macc to set one up.\n'));
      process.exit(1);
    }
    await triggerHandoff(source, targets, backend);
  });

program.parse();
