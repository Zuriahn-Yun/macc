import readline from 'node:readline';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import chalk from 'chalk';
import { getBackend } from '../backends/registry.js';
import type { IModelBackend } from '../backends/base.js';

interface Provider {
  label: string;
  envVar: string;
  defaultModel: string;
}

const PROVIDERS: Provider[] = [
  { label: 'Anthropic (Claude)',  envVar: 'ANTHROPIC_API_KEY', defaultModel: 'claude-sonnet-4-6' },
  { label: 'Google (Gemini)',     envVar: 'GOOGLE_API_KEY',    defaultModel: 'gemini-2.5-pro'    },
  { label: 'OpenAI',             envVar: 'OPENAI_API_KEY',    defaultModel: 'gpt-4o'            },
];

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, resolve));
}

export async function runSetupWizard(): Promise<IModelBackend> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log('');
  console.log(chalk.bold('  MACC — First-time setup'));
  console.log('');
  console.log('  Which AI provider do you want to start with?');
  PROVIDERS.forEach((p, i) => {
    const tag = i === 0 ? chalk.dim(' — recommended') : '';
    console.log(`    [${i + 1}] ${p.label}${tag}`);
  });
  console.log('');

  let provider: Provider | undefined;
  while (!provider) {
    const answer = (await ask(rl, chalk.bold.green('  > '))).trim();
    const idx = parseInt(answer, 10) - 1;
    if (idx >= 0 && idx < PROVIDERS.length) {
      provider = PROVIDERS[idx];
    } else {
      console.log(chalk.dim(`  Please enter a number between 1 and ${PROVIDERS.length}.`));
    }
  }

  console.log('');
  console.log(chalk.dim(`  Enter your ${provider.label} API key`));
  console.log(chalk.dim(`  (or press Enter to skip and set ${provider.envVar} in your shell later)`));
  console.log('');

  const key = (await ask(rl, chalk.bold.green('  > '))).trim();
  rl.close();

  if (key) {
    process.env[provider.envVar] = key;
    persistKey(provider.envVar, key);
    console.log(chalk.green(`\n  Key saved to ~/.macc/.env`));
    console.log(chalk.dim(`  Add this to your shell profile for persistence:`));
    console.log(chalk.dim(`    export ${provider.envVar}="${key.slice(0, 8)}..."\n`));
  } else {
    console.log(chalk.dim(`\n  OK — set ${provider.envVar} in your shell to skip this prompt next time.\n`));
  }

  return getBackend(provider.defaultModel);
}

function persistKey(envVar: string, key: string): void {
  const dir = path.join(os.homedir(), '.macc');
  const file = path.join(dir, '.env');
  fs.mkdirSync(dir, { recursive: true });

  let contents = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  // Replace existing entry for this var, or append
  const line = `${envVar}="${key}"`;
  const regex = new RegExp(`^${envVar}=.*$`, 'm');
  contents = regex.test(contents) ? contents.replace(regex, line) : contents + (contents.endsWith('\n') || !contents ? '' : '\n') + line + '\n';
  fs.writeFileSync(file, contents, { mode: 0o600 });
}
