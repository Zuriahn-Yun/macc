import chalk from 'chalk';

export class CreditsExhaustedError extends Error {
  constructor(public readonly provider: string, message?: string) {
    super(message ?? `Credits exhausted for provider: ${provider}`);
    this.name = 'CreditsExhaustedError';
  }
}

// Patterns found in stderr / API error messages from each provider when credits run out.
const PATTERNS: RegExp[] = [
  /credit balance is too low/i,
  /insufficient.{0,30}credits?/i,
  /not enough credits?/i,
  /out of credits?/i,
  /payment required/i,
  /quota.{0,30}exceeded/i,
  /exceeded.{0,30}quota/i,
  /RESOURCE_EXHAUSTED/,
  /insufficient_quota/i,
  /account.{0,20}suspended/i,
  /no funds/i,
];

export function isCreditsExhaustedOutput(text: string): boolean {
  return PATTERNS.some(p => p.test(text));
}

export function printCreditsExhausted(fromAgent: string, toAgent: string): void {
  console.log('');
  console.log(chalk.yellow(`  ⚡ Credits exhausted on ${chalk.bold(fromAgent)}.`));
  console.log(chalk.dim(`  Automatically switching to ${chalk.bold(toAgent)}...\n`));
}

export function printCreditsExhaustedNoTarget(fromAgent: string): void {
  console.log('');
  console.log(chalk.red(`  ⚡ Credits exhausted on ${chalk.bold(fromAgent)} — no other agents available.`));
  console.log(chalk.dim('  Add another provider: ') + chalk.bold('macc agent add') + '\n');
}
