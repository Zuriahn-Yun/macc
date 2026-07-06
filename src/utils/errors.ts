import chalk from 'chalk';

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class CreditsExhaustedError extends Error {
  constructor(public readonly provider: string, message?: string) {
    super(message ?? `Credits exhausted for provider: ${provider}`);
    this.name = 'CreditsExhaustedError';
  }
}

export class UsageLimitError extends Error {
  constructor(
    public readonly provider: string,
    public readonly resetAt: Date | null,
    message?: string,
  ) {
    super(message ?? `Usage limit reached for provider: ${provider}`);
    this.name = 'UsageLimitError';
  }
}

// ---------------------------------------------------------------------------
// Pattern detection
// ---------------------------------------------------------------------------

// Permanent billing failures — account has no funds.
const CREDIT_PATTERNS: RegExp[] = [
  /credit balance is too low/i,
  /insufficient.{0,30}credits?/i,
  /not enough credits?/i,
  /out of credits?/i,
  /payment required/i,
  /insufficient_quota/i,
  /account.{0,20}suspended/i,
  /no funds/i,
];

// Temporary usage/rate limits — agent will recover after a cooldown.
const USAGE_LIMIT_PATTERNS: RegExp[] = [
  /usage.{0,20}limit/i,
  /limit.{0,20}reached/i,
  /temporarily.{0,20}limited/i,
  /rate.{0,20}limit/i,
  /too many requests/i,
  /quota.{0,30}exceeded/i,
  /exceeded.{0,30}quota/i,
  /RESOURCE_EXHAUSTED/,
  /you.{0,30}reached.{0,30}limit/i,
  /try again.{0,40}(after|in|at)/i,
  /resume.{0,20}at/i,
  /available.{0,20}again.{0,20}at/i,
];

/** Used by backends to check if an API error message indicates credit/billing failure. */
export function isCreditsExhaustedOutput(text: string): boolean {
  return CREDIT_PATTERNS.some(p => p.test(text));
}

export type ExitReason = 'credits-exhausted' | 'usage-limit' | 'normal';

export function detectExitReason(stderr: string): ExitReason {
  if (USAGE_LIMIT_PATTERNS.some(p => p.test(stderr))) return 'usage-limit';
  if (CREDIT_PATTERNS.some(p => p.test(stderr))) return 'credits-exhausted';
  return 'normal';
}

// ---------------------------------------------------------------------------
// Reset-time parsing
// ---------------------------------------------------------------------------

/**
 * Try to extract the reset time from Claude's "you can resume at X" messages.
 * Returns null if no time could be parsed — caller should fall back gracefully.
 *
 * Handles patterns like:
 *   "You can resume at 8:00 AM"
 *   "Try again after 5:30 PM EST"
 *   "Available again at 23:00 UTC"
 *   "Try again in 2 hours"
 *   "Try again in 30 minutes"
 *   "Resets at midnight"
 */
export function parseResetTime(text: string): Date | null {
  const now = new Date();

  // "in N hours" / "in N minutes"
  const inMatch = text.match(/in\s+(\d+(?:\.\d+)?)\s+(hour|minute|min|hr)s?/i);
  if (inMatch) {
    const n = parseFloat(inMatch[1]);
    const unit = inMatch[2].toLowerCase();
    const ms = unit.startsWith('h') ? n * 3_600_000 : n * 60_000;
    return new Date(now.getTime() + ms);
  }

  // "at HH:MM AM/PM [timezone]"
  const atTimeMatch = text.match(/(?:resume|try again|available|resets?|after)\s+at\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?(?:\s*\w{2,4})?)/i)
    ?? text.match(/at\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?(?:\s*\w{2,4})?)/i);
  if (atTimeMatch) {
    const parsed = new Date(`${now.toDateString()} ${atTimeMatch[1].trim()}`);
    if (!isNaN(parsed.getTime())) {
      // If the parsed time is in the past, assume it means tomorrow.
      if (parsed < now) parsed.setDate(parsed.getDate() + 1);
      return parsed;
    }
  }

  // "at midnight" / "at noon"
  if (/at midnight/i.test(text)) {
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    midnight.setDate(midnight.getDate() + 1); // next midnight
    return midnight;
  }
  if (/at noon/i.test(text)) {
    const noon = new Date(now);
    noon.setHours(12, 0, 0, 0);
    if (noon < now) noon.setDate(noon.getDate() + 1);
    return noon;
  }

  // ISO-ish timestamps: "2025-01-15 18:00:00" or "2025-01-15T18:00:00Z"
  const isoMatch = text.match(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?/);
  if (isoMatch) {
    const parsed = new Date(isoMatch[0]);
    if (!isNaN(parsed.getTime()) && parsed > now) return parsed;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

export function printUsageLimitHit(fromAgent: string, toAgent: string, resetAt: Date | null): void {
  console.log('');
  console.log(chalk.yellow(`  ⏸  Usage limit hit on ${chalk.bold(fromAgent)}.`));
  if (resetAt) {
    console.log(chalk.dim(`  ${chalk.bold(fromAgent)} resets at ${resetAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`));
  }
  console.log(chalk.dim(`  Automatically continuing on ${chalk.bold(toAgent)}...\n`));
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

export function printNoTargetAvailable(fromAgent: string): void {
  console.log('');
  console.log(chalk.red(`  ⚠  ${chalk.bold(fromAgent)} is unavailable and no other agents are configured.`));
  console.log(chalk.dim('  Add another provider: ') + chalk.bold('macc agent add') + '\n');
}
