#!/usr/bin/env node
import { Command } from 'commander';
import { startSession } from './repl/session.js';
import { listModels, detectAvailableBackend } from './backends/registry.js';
import { discoverAdapters, allAdapters } from './adapters/registry.js';
import { watchAll, watchAndOrchestrate, triggerHandoff } from './core/orchestrator.js';
import chalk from 'chalk';

const program = new Command();

program
  .name('macc')
  .description('Transfer context seamlessly between Claude Code, Gemini CLI, Codex, and Qoder')
  .version('0.2.0');

// Default command: agent dashboard + auto-watch
program
  .command('watch', { isDefault: true })
  .description('Show agent context dashboard and auto-handoff when any session hits the limit')
  .option('-s, --source <agent>', 'watch only one agent: claude-code, gemini-cli, codex, qodo')
  .action(async (opts) => {
    const cwd = process.cwd();
    const backend = await detectAvailableBackend();
    if (!backend) {
      console.error(chalk.red('\n  No AI credentials found for compression.'));
      console.error(chalk.dim('  Log in with: claude auth login  OR  set ANTHROPIC_API_KEY / GOOGLE_API_KEY\n'));
      process.exit(1);
    }

    if (opts.source) {
      const adapters = discoverAdapters(cwd);
      const source = adapters.find(a => a.id === opts.source);
      if (!source) {
        console.error(chalk.red(`\n  Agent "${opts.source}" not found or not installed.\n`));
        process.exit(1);
      }
      const targets = adapters.filter(a => a.id !== source.id);
      await watchAndOrchestrate(source, targets, backend);
    } else {
      const agents = allAdapters(cwd);
      await watchAll(agents, backend);
    }
  });

// Manual handoff
program
  .command('handoff')
  .description('Compress the active session and hand it off to another agent')
  .option('-s, --source <agent>', 'agent to read from (auto-detects if omitted)')
  .action(async (opts) => {
    const cwd = process.cwd();
    const adapters = discoverAdapters(cwd);

    if (adapters.length < 2) {
      console.error(chalk.red('\n  Need at least two supported agents installed (claude, gemini, codex, qoder).\n'));
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
      console.error(chalk.red('\n  No AI credentials found for compression.\n'));
      process.exit(1);
    }
    await triggerHandoff(source, targets, backend);
  });

// Direct AI chat (kept for power users / testing)
program
  .command('chat')
  .description('Start a direct AI chat session (switches between AI models, not agent CLIs)')
  .option('-m, --model <model>', 'model to use (default: claude-sonnet-4-6)')
  .option('--debug', 'print verbose API debug info to stderr')
  .action(async (opts) => {
    await startSession(opts.model, opts.debug ?? false);
  });

// List available models for the chat command
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
