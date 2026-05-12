import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import chalk from 'chalk';
import { getBackend } from '../backends/registry.js';
import type { IModelBackend } from '../backends/base.js';
import { readClaudeCredentials, readGcloudAccessToken, hasCliTool } from '../auth/credentials.js';

interface Provider {
  label: string;
  defaultModel: string;
  checkAvailable: () => boolean;
  login: () => boolean; // returns true if login succeeded
}

const PROVIDERS: Provider[] = [
  {
    label: 'Claude (via Claude CLI)',
    defaultModel: 'claude-sonnet-4-6',
    checkAvailable: () => !!readClaudeCredentials(),
    login: loginClaude,
  },
  {
    label: 'Google Gemini (via gcloud)',
    defaultModel: 'gemini-2.5-pro',
    checkAvailable: () => !!(readGcloudAccessToken()),
    login: loginGoogle,
  },
  {
    label: 'Qodo (coming soon)',
    defaultModel: '',
    checkAvailable: () => false,
    login: () => { console.log(chalk.dim('\n  Qodo integration is coming soon.\n')); return false; },
  },
];

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, resolve));
}

export async function runSetupWizard(): Promise<IModelBackend> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log('');
  console.log(chalk.bold('  MACC — First-time setup'));
  console.log(chalk.dim('  No credentials found. Log in to a provider to get started.'));
  console.log('');

  PROVIDERS.forEach((p, i) => {
    const already = p.checkAvailable();
    const status = already ? chalk.green('✓ logged in') : '';
    console.log(`    [${i + 1}] ${p.label}  ${status}`);
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

  rl.close();

  if (provider.defaultModel === '') {
    // Unsupported provider selected
    provider.login();
    console.log(chalk.yellow('\n  Please choose a supported provider to continue.\n'));
    return runSetupWizard();
  }

  // If already logged in, skip the login step
  if (provider.checkAvailable()) {
    console.log(chalk.green(`\n  Already logged in. Starting with ${provider.defaultModel}...\n`));
    return getBackend(provider.defaultModel);
  }

  console.log('');
  const ok = provider.login();
  if (!ok) {
    console.log(chalk.yellow('\n  Login was not completed. Please try again.\n'));
    process.exit(1);
  }

  return getBackend(provider.defaultModel);
}

// --- login helpers ---

function loginClaude(): boolean {
  if (!hasCliTool('claude')) {
    console.log(chalk.yellow('\n  Claude CLI not found.'));
    console.log(chalk.dim('  Install it from https://claude.ai/code, then run `claude auth login`.\n'));
    return false;
  }

  console.log(chalk.dim('\n  Opening browser for Claude login...\n'));
  const result = spawnSync('claude', ['auth', 'login'], { stdio: 'inherit' });
  if (result.status !== 0) {
    console.log(chalk.red('\n  Claude login failed or was cancelled.\n'));
    return false;
  }

  const creds = readClaudeCredentials();
  if (!creds) {
    console.log(chalk.red('\n  Login completed but no credentials were saved. Try running `claude auth login` manually.\n'));
    return false;
  }

  console.log(chalk.green('\n  Claude login successful.\n'));
  return true;
}

function loginGoogle(): boolean {
  if (!hasCliTool('gcloud')) {
    console.log(chalk.yellow('\n  gcloud CLI not found.'));
    console.log(chalk.dim('  Install it from https://cloud.google.com/sdk, then run:'));
    console.log(chalk.dim('    gcloud auth application-default login\n'));
    return false;
  }

  console.log(chalk.dim('\n  Opening browser for Google login...\n'));

  // Set up application default credentials
  const result = spawnSync('gcloud', ['auth', 'application-default', 'login'], { stdio: 'inherit' });
  if (result.status !== 0) {
    console.log(chalk.red('\n  Google login failed or was cancelled.\n'));
    return false;
  }

  // Verify credentials work
  const token = readGcloudAccessToken();
  if (!token) {
    console.log(chalk.red('\n  Login completed but could not read credentials. Try running `gcloud auth application-default login` manually.\n'));
    return false;
  }

  console.log(chalk.green('\n  Google login successful.\n'));
  console.log(chalk.dim('  Note: Set GOOGLE_CLOUD_PROJECT to your project ID to use Vertex AI.\n'));
  return true;
}
