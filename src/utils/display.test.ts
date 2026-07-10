import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Spy on console.log and process.stdout.write before importing so chalk output is captured.
const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

import {
  printWelcome,
  printUsageBar,
  printWarning,
  printHandoffMenu,
  startHandoffProgress,
  printHandoffSummary,
  printSwitchBanner,
  printDashboardHeader,
  printStatusHeader,
  printAgentRow,
  printHelp,
} from './display.js';

beforeEach(() => {
  consoleSpy.mockClear();
  stdoutSpy.mockClear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// printWelcome
// ---------------------------------------------------------------------------

describe('printWelcome', () => {
  it('prints MACC header with model id', () => {
    printWelcome('claude-sonnet-4-6');
    const output = consoleSpy.mock.calls.map(c => c.join('')).join('\n');
    expect(output).toContain('MACC');
    expect(output).toContain('claude-sonnet-4-6');
  });
});

// ---------------------------------------------------------------------------
// printUsageBar
// ---------------------------------------------------------------------------

describe('printUsageBar', () => {
  it('renders dim bar below 90%', () => {
    printUsageBar(50, 100_000, 200_000);
    const output = consoleSpy.mock.calls.map(c => c.join('')).join('');
    expect(output).toContain('50.0%');
    expect(output).toContain('100,000');
    expect(output).toContain('200,000');
  });

  it('renders yellow bar at 90%', () => {
    printUsageBar(90, 180_000, 200_000);
    const output = consoleSpy.mock.calls.map(c => c.join('')).join('');
    expect(output).toContain('90.0%');
  });

  it('renders red bar at 98%', () => {
    printUsageBar(98, 196_000, 200_000);
    const output = consoleSpy.mock.calls.map(c => c.join('')).join('');
    expect(output).toContain('98.0%');
  });

  it('renders at 0% with empty bar', () => {
    printUsageBar(0, 0, 200_000);
    const output = consoleSpy.mock.calls.map(c => c.join('')).join('');
    expect(output).toContain('0.0%');
    expect(output).toContain('0');
  });

  it('renders at 100% with full bar', () => {
    printUsageBar(100, 200_000, 200_000);
    const output = consoleSpy.mock.calls.map(c => c.join('')).join('');
    expect(output).toContain('100.0%');
  });
});

// ---------------------------------------------------------------------------
// printWarning
// ---------------------------------------------------------------------------

describe('printWarning', () => {
  it('includes usage percent and token counts', () => {
    printWarning(92, 184_000, 200_000);
    const output = consoleSpy.mock.calls.map(c => c.join('')).join('');
    expect(output).toContain('92%');
    expect(output).toContain('184,000');
    expect(output).toContain('200,000');
  });
});

// ---------------------------------------------------------------------------
// printHandoffMenu
// ---------------------------------------------------------------------------

describe('printHandoffMenu', () => {
  it('shows all model options with [0] exit', () => {
    printHandoffMenu(['gemini-2.5-pro', 'claude-sonnet-4-6']);
    const output = consoleSpy.mock.calls.map(c => c.join('')).join('\n');
    expect(output).toContain('[0]');
    expect(output).toContain('[1]');
    expect(output).toContain('[2]');
    expect(output).toContain('gemini-2.5-pro');
    expect(output).toContain('claude-sonnet-4-6');
  });

  it('marks first option as recommended in normal mode', () => {
    printHandoffMenu(['gemini-2.5-pro', 'claude-sonnet-4-6'], false);
    const output = consoleSpy.mock.calls.map(c => c.join('')).join('\n');
    expect(output).toContain('recommended');
  });

  it('handles empty model list', () => {
    printHandoffMenu([]);
    const output = consoleSpy.mock.calls.map(c => c.join('')).join('\n');
    expect(output).toContain('[0]');
  });

  it('forced mode shows switch title variant', () => {
    printHandoffMenu(['gemini-2.5-pro'], true);
    const output = consoleSpy.mock.calls.map(c => c.join('')).join('\n');
    expect(output).toContain('Switch to which agent?');
  });
});

// ---------------------------------------------------------------------------
// startHandoffProgress
// ---------------------------------------------------------------------------

describe('startHandoffProgress', () => {
  it('finish() writes done message', () => {
    const progress = startHandoffProgress();
    progress.finish(1500);
    vi.runAllTimers();
    const output = stdoutSpy.mock.calls.map(c => String(c[0])).join('');
    expect(output).toContain('done');
    expect(output).toContain('1.5s');
  });

  it('onProgress tracks chars and converts to approximate tokens', () => {
    const progress = startHandoffProgress();
    progress.onProgress(4000); // 4000 chars ≈ 1000 tokens
    vi.runOnlyPendingTimers(); // fire spinner tick
    const output = stdoutSpy.mock.calls.map(c => String(c[0])).join('');
    expect(output).toContain('1000 tokens');
    progress.finish(0);
  });

  it('spinner ticks until finish is called', () => {
    const progress = startHandoffProgress();
    vi.advanceTimersByTime(300); // 3 spinner ticks
    expect(stdoutSpy).toHaveBeenCalledTimes(3);
    progress.finish(0);
  });
});

// ---------------------------------------------------------------------------
// printHandoffSummary
// ---------------------------------------------------------------------------

describe('printHandoffSummary', () => {
  const baseSummary = {
    ultimateGoal: 'Fix the auth middleware',
    completedWork: 'Reviewed auth.ts',
    nextStep: 'Write tests',
    filesModified: ['src/auth.ts', 'src/middleware.ts'],
    blockers: ['Missing test fixtures'],
  };

  it('renders all five fields', () => {
    printHandoffSummary(baseSummary);
    const output = consoleSpy.mock.calls.map(c => c.join('')).join('\n');
    expect(output).toContain('Fix the auth middleware');
    expect(output).toContain('Reviewed auth.ts');
    expect(output).toContain('Write tests');
    expect(output).toContain('src/auth.ts');
    expect(output).toContain('Missing test fixtures');
  });

  it('truncates long goal with ellipsis', () => {
    const longGoal = 'A'.repeat(100);
    printHandoffSummary({ ...baseSummary, ultimateGoal: longGoal });
    const output = consoleSpy.mock.calls.map(c => c.join('')).join('\n');
    expect(output).toContain('…');
  });

  it('omits Files line when no files modified', () => {
    printHandoffSummary({ ...baseSummary, filesModified: [] });
    const output = consoleSpy.mock.calls.map(c => c.join('')).join('\n');
    expect(output).not.toContain('Files:');
  });

  it('omits Blockers line when no blockers', () => {
    printHandoffSummary({ ...baseSummary, blockers: [] });
    const output = consoleSpy.mock.calls.map(c => c.join('')).join('\n');
    expect(output).not.toContain('Blockers:');
  });
});

// ---------------------------------------------------------------------------
// printSwitchBanner
// ---------------------------------------------------------------------------

describe('printSwitchBanner', () => {
  it('includes model id and start of goal', () => {
    printSwitchBanner('gemini-2.5-pro', 'Fix the auth middleware for OAuth login');
    const output = consoleSpy.mock.calls.map(c => c.join('')).join('\n');
    expect(output).toContain('gemini-2.5-pro');
    expect(output).toContain('Continuing:');
  });

  it('truncates long goal at 60 chars', () => {
    const longGoal = 'A'.repeat(80);
    printSwitchBanner('gemini-2.5-pro', longGoal);
    const output = consoleSpy.mock.calls.map(c => c.join('')).join('\n');
    expect(output).toContain('…');
  });

  it('does not truncate short goal', () => {
    printSwitchBanner('gemini-2.5-pro', 'Short goal');
    const output = consoleSpy.mock.calls.map(c => c.join('')).join('\n');
    expect(output).toContain('Short goal');
    expect(output).not.toContain('…');
  });
});

// ---------------------------------------------------------------------------
// printDashboardHeader
// ---------------------------------------------------------------------------

describe('printDashboardHeader', () => {
  it('renders MACC dashboard header', () => {
    printDashboardHeader();
    const output = consoleSpy.mock.calls.map(c => c.join('')).join('\n');
    expect(output).toContain('MACC');
    expect(output).toContain('Agent');
    expect(output).toContain('Context');
  });
});

// ---------------------------------------------------------------------------
// printStatusHeader
// ---------------------------------------------------------------------------

describe('printStatusHeader', () => {
  it('renders status header with column labels', () => {
    printStatusHeader();
    const output = consoleSpy.mock.calls.map(c => c.join('')).join('\n');
    expect(output).toContain('MACC');
    expect(output).toContain('Agent');
    expect(output).toContain('Context');
  });
});

// ---------------------------------------------------------------------------
// printAgentRow
// ---------------------------------------------------------------------------

describe('printAgentRow', () => {
  it('shows "not installed" when agent is not installed', () => {
    printAgentRow('codex', false, false, 0, 0, 100_000);
    const output = consoleSpy.mock.calls.map(c => c.join('')).join('');
    expect(output).toContain('not installed');
  });

  it('shows running status for active agent', () => {
    printAgentRow('claude-code', true, true, 75, 150_000, 200_000);
    const output = consoleSpy.mock.calls.map(c => c.join('')).join('');
    expect(output).toContain('running');
    expect(output).toContain('75%');
  });

  it('shows idle status for installed but not running agent', () => {
    printAgentRow('gemini-cli', true, false, 0, 0, 1_000_000);
    const output = consoleSpy.mock.calls.map(c => c.join('')).join('');
    expect(output).toContain('idle');
  });

  it('renders at 0% for idle agent with no tokens', () => {
    printAgentRow('gemini-cli', true, false, 0, 0, 1_000_000);
    const output = consoleSpy.mock.calls.map(c => c.join('')).join('');
    expect(output).toContain('0%');
  });

  it('renders estimated tag when isEstimated is true', () => {
    printAgentRow('codex', true, true, 60, 60_000, 100_000, true);
    const output = consoleSpy.mock.calls.map(c => c.join('')).join('');
    expect(output).toContain('~est');
  });

  it('does not show estimated tag when isEstimated is false', () => {
    printAgentRow('codex', true, true, 60, 60_000, 100_000, false);
    const output = consoleSpy.mock.calls.map(c => c.join('')).join('');
    expect(output).not.toContain('~est');
  });

  it('clamps bar to 100% even when usage exceeds window', () => {
    // Should not throw or produce negative bar segments
    expect(() => printAgentRow('claude-code', true, true, 105, 210_000, 200_000)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// printHelp
// ---------------------------------------------------------------------------

describe('printHelp', () => {
  it('lists all major commands', () => {
    printHelp();
    const output = consoleSpy.mock.calls.map(c => c.join('')).join('\n');
    expect(output).toContain('start');
    expect(output).toContain('watch');
    expect(output).toContain('switch');
    expect(output).toContain('handoff');
    expect(output).toContain('agent');
    expect(output).toContain('status');
  });
});
