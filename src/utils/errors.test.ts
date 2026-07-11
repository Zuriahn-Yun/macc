import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isCreditsExhaustedOutput,
  detectExitReason,
  parseResetTime,
  printCreditsExhaustedNoTarget,
  printNoTargetAvailable,
} from './errors.js';

// Silence chalk output from print* helpers — tested separately via spies where needed.
vi.mock('chalk', () => {
  const id = (s: string) => s;
  const builder: Record<string, unknown> = {};
  const proxy = new Proxy(builder, {
    get: (_t, p) => typeof p === 'string' ? Object.assign(id, proxy) : id,
  });
  return { default: proxy };
});

// ---------------------------------------------------------------------------
// isCreditsExhaustedOutput
// ---------------------------------------------------------------------------

describe('isCreditsExhaustedOutput', () => {
  it('matches Anthropic insufficient_quota', () => {
    expect(isCreditsExhaustedOutput('Error: insufficient_quota — billing required')).toBe(true);
  });

  it('matches generic "payment required"', () => {
    expect(isCreditsExhaustedOutput('402 Payment Required')).toBe(true);
  });

  it('matches "no funds"', () => {
    expect(isCreditsExhaustedOutput('Account has no funds available')).toBe(true);
  });

  it('matches OpenAI billing quota message', () => {
    expect(isCreditsExhaustedOutput('You exceeded your current quota, please check your plan and billing details')).toBe(true);
  });

  it('matches Vertex AI billing not enabled', () => {
    expect(isCreditsExhaustedOutput('billing is not enabled on this project')).toBe(true);
  });

  it('matches Gemini free tier permanently exceeded', () => {
    expect(isCreditsExhaustedOutput('Free tier usage limit exceeded for this project')).toBe(true);
  });

  it('does not match a rate-limit message', () => {
    expect(isCreditsExhaustedOutput('Rate limit reached for gpt-4o — please try again in 60s')).toBe(false);
  });

  it('does not match empty string', () => {
    expect(isCreditsExhaustedOutput('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// detectExitReason
// ---------------------------------------------------------------------------

describe('detectExitReason', () => {
  it('returns normal for empty stderr', () => {
    expect(detectExitReason('')).toBe('normal');
  });

  it('returns normal for unrelated output', () => {
    expect(detectExitReason('Process exited with code 0')).toBe('normal');
  });

  // Usage-limit patterns
  it('returns usage-limit for RESOURCE_EXHAUSTED (Gemini gRPC)', () => {
    expect(detectExitReason('RESOURCE_EXHAUSTED: 429 Quota exceeded')).toBe('usage-limit');
  });

  it('returns usage-limit for Anthropic rate_limit_error', () => {
    expect(detectExitReason('{"type":"error","error":{"type":"rate_limit_error","message":"too many tokens"}}')).toBe('usage-limit');
  });

  it('returns usage-limit for "too many requests"', () => {
    expect(detectExitReason('429 Too Many Requests')).toBe('usage-limit');
  });

  it('returns usage-limit for "usage limit" phrase', () => {
    expect(detectExitReason("You've reached your plan's usage limit")).toBe('usage-limit');
  });

  it('returns usage-limit for OpenAI rate_limit_exceeded', () => {
    expect(detectExitReason('rate_limit_exceeded: Rate limit reached for gpt-4o')).toBe('usage-limit');
  });

  it('returns usage-limit for "try again in"', () => {
    expect(detectExitReason('Please try again in 60 seconds')).toBe('usage-limit');
  });

  it('returns usage-limit for "resets at"', () => {
    expect(detectExitReason('Your limit resets at 8:00 PM')).toBe('usage-limit');
  });

  it('returns usage-limit for Gemini GenerateRequestsPerMinute', () => {
    expect(detectExitReason('Quota exceeded for GenerateRequestsPerMinute')).toBe('usage-limit');
  });

  it('returns usage-limit for User Rate Limit Exceeded (Gemini AI Studio)', () => {
    expect(detectExitReason('User Rate Limit Exceeded')).toBe('usage-limit');
  });

  // Credit patterns
  it('returns credits-exhausted for insufficient_quota', () => {
    expect(detectExitReason('insufficient_quota')).toBe('credits-exhausted');
  });

  it('returns credits-exhausted for "credit balance is too low"', () => {
    expect(detectExitReason('Your credit balance is too low to make this request')).toBe('credits-exhausted');
  });

  it('returns credits-exhausted for OpenAI billing quota', () => {
    expect(detectExitReason('You exceeded your current quota, please check your plan and billing details')).toBe('credits-exhausted');
  });

  // Ordering: usage-limit checked before credits-exhausted
  it('usage-limit wins if both patterns could match', () => {
    // "rate limit" is usage-limit; "payment required" is credits-exhausted
    // both in same stderr → usage-limit wins (checked first)
    expect(detectExitReason('rate limit error\npayment required')).toBe('usage-limit');
  });
});

// ---------------------------------------------------------------------------
// parseResetTime
// ---------------------------------------------------------------------------

describe('parseResetTime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-06-15T14:00:00Z')); // 2:00 PM UTC
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null for text with no time', () => {
    expect(parseResetTime('Rate limit hit. Try again later.')).toBeNull();
  });

  it('parses "in N hours"', () => {
    const result = parseResetTime('Please try again in 2 hours.');
    expect(result).not.toBeNull();
    const expectedMs = Date.now() + 2 * 3_600_000;
    expect(Math.abs(result!.getTime() - expectedMs)).toBeLessThan(100);
  });

  it('parses "in N minutes"', () => {
    const result = parseResetTime('Try again in 30 minutes.');
    expect(result).not.toBeNull();
    const expectedMs = Date.now() + 30 * 60_000;
    expect(Math.abs(result!.getTime() - expectedMs)).toBeLessThan(100);
  });

  it('parses "in N min" shorthand', () => {
    const result = parseResetTime('Available again in 15 min.');
    expect(result).not.toBeNull();
    const expectedMs = Date.now() + 15 * 60_000;
    expect(Math.abs(result!.getTime() - expectedMs)).toBeLessThan(100);
  });

  it('parses "resume at HH:MM AM/PM"', () => {
    // No timezone suffix so JS parses in local time (avoids EST→UTC shift in CI)
    const result = parseResetTime('You can resume at 8:00 PM');
    expect(result).not.toBeNull();
    // 8 PM local is in the future relative to the 2 PM UTC fake "now"
    expect(result!.getHours()).toBe(20);
  });

  it('parses "resets at HH:MM"', () => {
    const result = parseResetTime('Your limit resets at 23:00 UTC');
    expect(result).not.toBeNull();
    expect(result!.getHours()).toBe(23);
  });

  it('rolls over to tomorrow for past time', () => {
    // 1:00 AM is in the past relative to 2:00 PM → should be tomorrow
    const result = parseResetTime('Available again at 01:00 AM');
    expect(result).not.toBeNull();
    const now = new Date();
    expect(result!.getDate()).toBe(now.getDate() + 1);
  });

  it('parses "at midnight"', () => {
    const result = parseResetTime('Limit resets at midnight');
    expect(result).not.toBeNull();
    expect(result!.getHours()).toBe(0);
    expect(result!.getMinutes()).toBe(0);
    // midnight is always the *next* midnight
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    expect(result!.getDate()).toBe(tomorrow.getDate());
  });

  it('parses "at noon"', () => {
    // Current time is 2 PM, so noon today is in the past → rolls to tomorrow
    const result = parseResetTime('Try again at noon');
    expect(result).not.toBeNull();
    expect(result!.getHours()).toBe(12);
  });

  it('parses ISO timestamp', () => {
    const result = parseResetTime('Resets at 2025-06-15T18:00:00Z');
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toBe('2025-06-15T18:00:00.000Z');
  });

  it('ignores ISO timestamps in the past', () => {
    const result = parseResetTime('Last reset was 2025-06-15T10:00:00Z');
    // 10:00 UTC is before our 14:00 UTC fake time → should be null
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// credits-exhausted with no fallback agent
// ---------------------------------------------------------------------------

describe('credits-exhausted with no fallback agent', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('printCreditsExhaustedNoTarget surfaces a clear error and does not throw', () => {
    expect(() => printCreditsExhaustedNoTarget('claude-code')).not.toThrow();
    const output = consoleSpy.mock.calls.map(c => c.join('')).join('\n');
    expect(output).toContain('claude-code');
    expect(output).toContain('Credits exhausted');
  });

  it('printCreditsExhaustedNoTarget suggests adding another provider', () => {
    printCreditsExhaustedNoTarget('gemini-cli');
    const output = consoleSpy.mock.calls.map(c => c.join('')).join('\n');
    expect(output).toMatch(/macc agent add/i);
  });

  it('printNoTargetAvailable surfaces a clear error and does not throw', () => {
    expect(() => printNoTargetAvailable('claude-code')).not.toThrow();
    const output = consoleSpy.mock.calls.map(c => c.join('')).join('\n');
    expect(output).toContain('claude-code');
  });

  it('detectExitReason correctly routes common credit-exhaustion patterns', () => {
    // These are the messages that trigger the no-fallback path in the orchestrator.
    expect(detectExitReason('Error: insufficient_quota — please add a payment method')).toBe('credits-exhausted');
    expect(detectExitReason('Your credit balance is too low to make this request')).toBe('credits-exhausted');
    expect(detectExitReason('You exceeded your current quota, please check your plan and billing details')).toBe('credits-exhausted');
    // Rate-limit messages must NOT be misclassified as credits-exhausted.
    expect(detectExitReason('Rate limit reached — please try again in 60 seconds')).not.toBe('credits-exhausted');
  });
});
