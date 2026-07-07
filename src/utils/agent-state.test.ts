import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// In-memory fs — hoisted so the mock factory can close over it before imports
// are evaluated by vitest's module loader.
// ---------------------------------------------------------------------------

const fsStore = vi.hoisted(() => ({ data: null as string | null }));

vi.mock('node:fs', () => ({
  default: {
    existsSync: () => fsStore.data !== null,
    readFileSync: () => fsStore.data ?? '[]',
    writeFileSync: (_path: string, data: string) => { fsStore.data = data; },
    mkdirSync: () => {},
  },
}));

import {
  recordAgentPaused,
  clearAgentPause,
  getAgentPause,
  getJustRecoveredAgents,
  formatResetTime,
} from './agent-state.js';

// ---------------------------------------------------------------------------
// recordAgentPaused / getAgentPause
// ---------------------------------------------------------------------------

describe('recordAgentPaused + getAgentPause', () => {
  beforeEach(() => { fsStore.data = null; });

  it('writes a pause record with reason and null resetAt', () => {
    recordAgentPaused('claude-code', 'usage-limit', null);
    const record = getAgentPause('claude-code');
    expect(record).not.toBeNull();
    expect(record!.agentId).toBe('claude-code');
    expect(record!.reason).toBe('usage-limit');
    expect(record!.resetAt).toBeNull();
    expect(typeof record!.since).toBe('string');
  });

  it('stores resetAt as ISO string', () => {
    const reset = new Date('2025-06-15T18:00:00Z');
    recordAgentPaused('gemini', 'credits-exhausted', reset);
    const record = getAgentPause('gemini');
    expect(record!.resetAt).toBe('2025-06-15T18:00:00.000Z');
    expect(record!.reason).toBe('credits-exhausted');
  });

  it('overwrites an existing record for the same agentId', () => {
    recordAgentPaused('claude-code', 'usage-limit', null);
    const reset = new Date('2025-06-15T20:00:00Z');
    recordAgentPaused('claude-code', 'credits-exhausted', reset);
    const record = getAgentPause('claude-code');
    expect(record!.reason).toBe('credits-exhausted');
    expect(record!.resetAt).toBe('2025-06-15T20:00:00.000Z');
    // Only one record should remain
    const raw = JSON.parse(fsStore.data!) as unknown[];
    expect(raw).toHaveLength(1);
  });

  it('keeps records for other agents when writing a new one', () => {
    recordAgentPaused('claude-code', 'usage-limit', null);
    recordAgentPaused('gemini', 'usage-limit', null);
    expect(getAgentPause('claude-code')).not.toBeNull();
    expect(getAgentPause('gemini')).not.toBeNull();
  });

  it('returns null when agent has no pause record', () => {
    expect(getAgentPause('codex')).toBeNull();
  });

  it('returns null on empty store', () => {
    expect(getAgentPause('claude-code')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// clearAgentPause
// ---------------------------------------------------------------------------

describe('clearAgentPause', () => {
  beforeEach(() => { fsStore.data = null; });

  it('removes the pause record for the specified agent', () => {
    recordAgentPaused('claude-code', 'usage-limit', null);
    clearAgentPause('claude-code');
    expect(getAgentPause('claude-code')).toBeNull();
  });

  it('does not affect records for other agents', () => {
    recordAgentPaused('claude-code', 'usage-limit', null);
    recordAgentPaused('gemini', 'usage-limit', null);
    clearAgentPause('claude-code');
    expect(getAgentPause('claude-code')).toBeNull();
    expect(getAgentPause('gemini')).not.toBeNull();
  });

  it('is a no-op when the agent has no record', () => {
    recordAgentPaused('gemini', 'usage-limit', null);
    clearAgentPause('codex'); // codex has no record
    expect(getAgentPause('gemini')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getJustRecoveredAgents
// ---------------------------------------------------------------------------

describe('getJustRecoveredAgents', () => {
  beforeEach(() => {
    fsStore.data = null;
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-06-15T16:00:00Z')); // 4 PM UTC
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns empty array when no agents are paused', () => {
    expect(getJustRecoveredAgents(['claude-code', 'gemini'])).toEqual([]);
  });

  it('returns agents whose resetAt is in the past', () => {
    // 3 PM — already passed our faked 4 PM "now"
    const past = new Date('2025-06-15T15:00:00Z');
    recordAgentPaused('claude-code', 'usage-limit', past);
    const recovered = getJustRecoveredAgents(['claude-code']);
    expect(recovered).toHaveLength(1);
    expect(recovered[0].agentId).toBe('claude-code');
    expect(recovered[0].reason).toBe('usage-limit');
  });

  it('does not return agents whose resetAt is in the future', () => {
    // 5 PM — still in the future
    const future = new Date('2025-06-15T17:00:00Z');
    recordAgentPaused('claude-code', 'usage-limit', future);
    expect(getJustRecoveredAgents(['claude-code'])).toEqual([]);
  });

  it('does not return agents with null resetAt', () => {
    recordAgentPaused('claude-code', 'usage-limit', null);
    expect(getJustRecoveredAgents(['claude-code'])).toEqual([]);
  });

  it('only checks agents in the provided list', () => {
    const past = new Date('2025-06-15T15:00:00Z');
    recordAgentPaused('claude-code', 'usage-limit', past);
    // Pass a list that doesn't include claude-code
    expect(getJustRecoveredAgents(['gemini', 'codex'])).toEqual([]);
  });

  it('returns multiple recovered agents', () => {
    const past = new Date('2025-06-15T15:00:00Z');
    recordAgentPaused('claude-code', 'usage-limit', past);
    recordAgentPaused('gemini', 'credits-exhausted', past);
    const recovered = getJustRecoveredAgents(['claude-code', 'gemini']);
    expect(recovered).toHaveLength(2);
    const ids = recovered.map(r => r.agentId);
    expect(ids).toContain('claude-code');
    expect(ids).toContain('gemini');
  });

  it('includes agents recovered exactly at resetAt (boundary)', () => {
    // resetAt equals "now"
    const now = new Date('2025-06-15T16:00:00Z');
    recordAgentPaused('claude-code', 'usage-limit', now);
    const recovered = getJustRecoveredAgents(['claude-code']);
    expect(recovered).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// formatResetTime
// ---------------------------------------------------------------------------

describe('formatResetTime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-06-15T14:00:00Z')); // 2 PM UTC
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns "now" for a date in the past', () => {
    const past = new Date(Date.now() - 5_000);
    expect(formatResetTime(past)).toBe('now');
  });

  it('returns "now" for current time (diffMs = 0)', () => {
    const exact = new Date(Date.now());
    expect(formatResetTime(exact)).toBe('now');
  });

  it('returns "in N min" for times under an hour away', () => {
    const soon = new Date(Date.now() + 23 * 60_000);
    expect(formatResetTime(soon)).toBe('in 23 min');
  });

  it('rounds up minutes (1 ms → 1 min)', () => {
    const almostNow = new Date(Date.now() + 1);
    expect(formatResetTime(almostNow)).toBe('in 1 min');
  });

  it('returns "in Nh" for times 1–23 hours away', () => {
    const threeHours = new Date(Date.now() + 3 * 3_600_000);
    expect(formatResetTime(threeHours)).toBe('in 3h');
  });

  it('rounds up hours (61 min → 2h)', () => {
    const sixtyOneMin = new Date(Date.now() + 61 * 60_000);
    expect(formatResetTime(sixtyOneMin)).toBe('in 2h');
  });

  it('returns a formatted time string for dates 24+ hours away', () => {
    const tomorrow = new Date(Date.now() + 25 * 3_600_000);
    const result = formatResetTime(tomorrow);
    // Should NOT be "in N min" or "in Nh" — just a time string
    expect(result).not.toMatch(/^in \d+ min$/);
    expect(result).not.toMatch(/^in \d+h$/);
    expect(result).not.toBe('now');
    // Should start with "at "
    expect(result).toMatch(/^at /);
  });
});
