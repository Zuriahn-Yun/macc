#!/usr/bin/env node
import { Command } from 'commander';
import { startSession } from './repl/session.js';
import { listModels } from './backends/registry.js';
import chalk from 'chalk';

const program = new Command();

program
  .name('macc')
  .description('Multi-Agent Coding Client — AI coding assistant that switches models when context limits are hit')
  .version('0.1.0')
  .option('-m, --model <model>', 'model to use (default: claude-sonnet-4-6)')
  .action(async (options) => {
    await startSession(options.model);
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

program.parse();
