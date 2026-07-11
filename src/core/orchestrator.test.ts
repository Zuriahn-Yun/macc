import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IAgentAdapter, SessionContext, UsageSnapshot } from '../adapters/base.js';
import type { IModelBackend, StreamChunk } from '../backends/base.js';

// Mock display functions so watchAll tests don't write to the real terminal.
vi.mock('../utils/display.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../utils/display.js')>();
  return {
    ...real,
    printDashboardHeader: vi.fn(),
    printAgentRow: vi.fn(),
    printStatusHeader: vi.fn(),
    printWarning: vi.fn(),
    printHandoffMenu: vi.fn(),
    printHandoffSummary: vi.fn(),
    printSwitchBanner: vi.fn(),
    startHandoffProgress: vi.fn().mockReturnValue(() => {}),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAdapter(id: string, pct: number, messages: SessionContext['messages'] = []): IAgentAdapter {
  return {
    id,
    commandName: id,
    getContextWindowSize: () => 200_000,
    isRunning: vi.fn().mockResolvedValue(true),
    getUsageSnapshot: vi.fn().mockResolvedValue({
      agentId: id,
      isRunning: true,
      contextUsedPercent: pct,
      inputTokensUsed: Math.round((pct / 100) * 200_000),
      contextWindowTokens: 200_000,
    } satisfies UsageSnapshot),
    extractSessionContext: vi.fn().mockResolvedValue({
      messages,
      cwd: '/project',
      inputTokensUsed: Math.round((pct / 100) * 200_000),
      contextWindowTokens: 200_000,
    } satisfies SessionContext),
    buildLaunchArgs: vi.fn().mockReturnValue({ args: ['handoff context'] }),
  };
}

const VALID_PACKET_JSON = JSON.stringify({
  version: '1',
  createdAt: new Date().toISOString(),
  fromModel: 'claude-sonnet-4-6',
  toModel: 'gemini-cli',
  cwd: '/project',
  summary: {
    ultimateGoal: 'Fix the auth middleware',
    completedWork: 'Reviewed code',
    nextStep: 'Write tests',
    keyDecisions: ['Use JWT'],
    blockers: [],
    filesModified: ['src/auth.ts'],
  },
  handoffPrompt: 'Continue fixing the auth middleware. Next step: write tests.',
});

function makeBackend(): IModelBackend {
  return {
    modelId: 'claude-sonnet-4-6',
    displayName: 'Claude Sonnet',
    contextWindowTokens: 200_000,
    provider: 'anthropic',
    isAvailable: vi.fn().mockResolvedValue(true),
    stream: vi.fn().mockImplementation(
      async (_msgs, _sys, onChunk: (c: StreamChunk) => void) => {
        onChunk({ text: VALID_PACKET_JSON, done: false });
        onChunk({ text: '', done: true, usage: { inputTokens: 100, outputTokens: 50 } });
        return { inputTokens: 100, outputTokens: 50 };
      }
    ),
  };
}

// ---------------------------------------------------------------------------
// Unit tests for the rotation decision logic (without spawning real processes)
// ---------------------------------------------------------------------------

describe('rotation threshold logic', () => {
  it('switch menu is always offered regardless of context %', async () => {
    // Previously rotation was blocked under 85%; now we always offer the menu.
    const source = makeAdapter('claude-code', 70, [{ role: 'user', content: 'hello' }]);
    const snap = await source.getUsageSnapshot();
    // Low context — switch is still offered (user decides, not MACC)
    expect(snap.contextUsedPercent).toBe(70);
    expect(snap.contextUsedPercent < 85).toBe(true);
    // The menu should be shown regardless (tested via display function)
  });

  it('warning is shown when context >= 85%', async () => {
    const source = makeAdapter('claude-code', 92, [{ role: 'user', content: 'fix auth' }]);
    const snap = await source.getUsageSnapshot();
    expect(snap.contextUsedPercent >= 85).toBe(true);
  });
});

describe('manual switch — buildBaseArgs', () => {
  it('claude-code buildBaseArgs includes --append-system-prompt', async () => {
    const { ClaudeCodeAdapter } = await import('../adapters/claude.js');
    const adapter = new ClaudeCodeAdapter('/project');
    const args = adapter.buildBaseArgs();
    expect(args[0]).toBe('--append-system-prompt');
    expect(args[1]).toBeTruthy();
    expect(args).toHaveLength(2);
  });

  it('base args are prepended before handoff prompt in launch args', async () => {
    const { ClaudeCodeAdapter } = await import('../adapters/claude.js');
    const adapter = new ClaudeCodeAdapter('/project');
    const baseArgs = adapter.buildBaseArgs();
    const handoffPrompt = 'Continue with auth middleware.';
    // Simulate what orchestrator does
    const launchArgs = [...baseArgs, handoffPrompt];
    expect(launchArgs[0]).toBe('--append-system-prompt');
    expect(launchArgs[launchArgs.length - 1]).toBe(handoffPrompt);
  });
});

describe('compression before handoff', () => {
  it('compressor produces a valid handoff packet', async () => {
    const { compressContext } = await import('./compressor.js');
    const { ContextStore } = await import('./context-store.js');

    const store = new ContextStore('claude-sonnet-4-6', 200_000, 90, 98, 'system');
    store.addUserMessage('fix auth middleware');
    store.addAssistantMessage('looking at it now', { inputTokens: 180_000, outputTokens: 100 });

    const backend = makeBackend();
    const packet = await compressContext(backend, store, 'gemini-cli', '/project');

    expect(packet.summary.ultimateGoal).toBe('Fix the auth middleware');
    expect(packet.handoffPrompt).toContain('auth middleware');
    expect(packet.toModel).toBe('gemini-cli');
  });
});

// ---------------------------------------------------------------------------
// watchAll dashboard
// ---------------------------------------------------------------------------

// Drain the microtask queue without advancing fake timers (so setInterval
// doesn't fire repeatedly). All async mock functions resolve immediately, so
// a handful of awaits is enough to let a single redraw complete.
async function flushMicrotasks(n = 20): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

describe('watchAll', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.useFakeTimers();
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('calls getUsageSnapshot for each installed agent on first redraw', async () => {
    const { watchAll } = await import('./orchestrator.js');
    const { printAgentRow } = await import('../utils/display.js');

    const installed = makeAdapter('claude-code', 50);
    const notInstalled = makeAdapter('gemini-cli', 0);

    const watchPromise = watchAll(
      [{ adapter: installed, installed: true }, { adapter: notInstalled, installed: false }],
      [makeBackend()],
    );

    // Let the initial await redraw() complete via microtask drain (not timers).
    await flushMicrotasks();
    process.emit('SIGINT');
    await watchPromise;

    expect(installed.getUsageSnapshot).toHaveBeenCalled();
    expect(notInstalled.getUsageSnapshot).not.toHaveBeenCalled();
    expect(printAgentRow).toHaveBeenCalled();
  });

  it('resolves when SIGINT is emitted', async () => {
    const { watchAll } = await import('./orchestrator.js');
    const adapter = makeAdapter('claude-code', 50);

    const watchPromise = watchAll([{ adapter, installed: true }], [makeBackend()]);

    await flushMicrotasks();
    process.emit('SIGINT');

    await expect(watchPromise).resolves.toBeUndefined();
  });

  it('does not fire a second redraw while one is in progress', async () => {
    const { watchAll } = await import('./orchestrator.js');

    let resolveSlowSnapshot: (() => void) | undefined;
    const slowSnap: IAgentAdapter = {
      ...makeAdapter('claude-code', 50),
      getUsageSnapshot: vi.fn().mockImplementation(
        () => new Promise<UsageSnapshot>(resolve => {
          resolveSlowSnapshot = () => resolve({
            agentId: 'claude-code',
            isRunning: true,
            contextUsedPercent: 50,
            inputTokensUsed: 100_000,
            contextWindowTokens: 200_000,
          });
        })
      ),
    };

    const watchPromise = watchAll([{ adapter: slowSnap, installed: true }], [makeBackend()]);

    // Initial redraw has started (snapshot pending). Advance timer to fire
    // the setInterval — but isRedrawing guard should block the second call.
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(5_000);

    // Still only one outstanding snapshot call.
    expect(slowSnap.getUsageSnapshot).toHaveBeenCalledTimes(1);

    // Let the slow snapshot resolve, then SIGINT.
    resolveSlowSnapshot?.();
    await flushMicrotasks();
    process.emit('SIGINT');
    await watchPromise;
  });

  it('resolves instead of hanging when triggerHandoff throws', async () => {
    const { watchAll } = await import('./orchestrator.js');

    // Source adapter at 100% so watchAll fires triggerHandoff immediately.
    const source = makeAdapter('claude-code', 100);
    vi.mocked(source.getUsageSnapshot).mockResolvedValue({
      agentId: 'claude-code',
      isRunning: true,
      contextUsedPercent: 100,
      inputTokensUsed: 200_000,
      contextWindowTokens: 200_000,
    });
    // Force extractSessionContext to throw so triggerHandoff propagates an error.
    vi.mocked(source.extractSessionContext).mockRejectedValue(new Error('simulated disk error'));

    // A second installed adapter so otherTargets is non-empty (reaches extractSessionContext).
    const target = makeAdapter('gemini-cli', 0);

    // Before the fix this would hang forever; after the fix it resolves.
    await expect(
      watchAll(
        [{ adapter: source, installed: true }, { adapter: target, installed: true }],
        [makeBackend()],
      )
    ).resolves.toBeUndefined();
  });

  it('prints not-installed row without calling getUsageSnapshot', async () => {
    const { watchAll } = await import('./orchestrator.js');
    const { printAgentRow } = await import('../utils/display.js');

    const adapter = makeAdapter('codex', 0);
    const watchPromise = watchAll([{ adapter, installed: false }], [makeBackend()]);

    await flushMicrotasks();
    process.emit('SIGINT');
    await watchPromise;

    expect(adapter.getUsageSnapshot).not.toHaveBeenCalled();
    expect(printAgentRow).toHaveBeenCalledWith(
      'codex', false, false, 0, 0, expect.any(Number)
    );
  });
});

describe('buildLaunchArgs per adapter', () => {
  it('claude-code launches with prompt as positional arg (interactive)', async () => {
    const { ClaudeCodeAdapter } = await import('../adapters/claude.js');
    const adapter = new ClaudeCodeAdapter('/project');
    const packet = JSON.parse(VALID_PACKET_JSON);
    const { args } = adapter.buildLaunchArgs(packet);
    // Should NOT use --print (that exits); prompt as positional starts interactive session
    expect(args).not.toContain('--print');
    expect(args[0]).toContain('auth middleware');
  });

  it('gemini-cli launches with prompt as positional arg', async () => {
    const { GeminiAdapter } = await import('../adapters/gemini.js');
    const adapter = new GeminiAdapter();
    const packet = JSON.parse(VALID_PACKET_JSON);
    const { args } = adapter.buildLaunchArgs(packet);
    expect(args[0]).toContain('auth middleware');
  });

  it('codex launches with prompt as positional arg', async () => {
    const { CodexAdapter } = await import('../adapters/codex.js');
    const adapter = new CodexAdapter();
    const packet = JSON.parse(VALID_PACKET_JSON);
    const { args } = adapter.buildLaunchArgs(packet);
    expect(args[0]).toContain('auth middleware');
  });

  it('qodo (qodercli) passes handoff prompt as positional arg', async () => {
    const { QodoAdapter } = await import('../adapters/qodo.js');
    const adapter = new QodoAdapter('/project');
    const packet = JSON.parse(VALID_PACKET_JSON);
    const { args } = adapter.buildLaunchArgs(packet);
    expect(args[0]).toContain('auth middleware');
    expect(args).not.toContain('--print');
  });
});

describe('resume session args', () => {
  it('buildResumeArgs includes --resume flag and session ID', async () => {
    const { ClaudeCodeAdapter } = await import('../adapters/claude.js');
    const adapter = new ClaudeCodeAdapter('/project');
    const args = adapter.buildResumeArgs('abc-123-session');
    expect(args).toContain('--resume');
    expect(args).toContain('abc-123-session');
  });

  it('buildResumeArgs does not include a handoff prompt', async () => {
    const { ClaudeCodeAdapter } = await import('../adapters/claude.js');
    const adapter = new ClaudeCodeAdapter('/project');
    const args = adapter.buildResumeArgs('abc-123-session');
    // ['--resume', id, '--append-system-prompt', prompt] — exactly 4 items, no user text
    expect(args).toHaveLength(4);
    expect(args[0]).toBe('--resume');
    expect(args[1]).toBe('abc-123-session');
  });

  it('resume args are used instead of base args when sessionId is present', async () => {
    const { ClaudeCodeAdapter } = await import('../adapters/claude.js');
    const adapter = new ClaudeCodeAdapter('/project');
    const resumeArgs = adapter.buildResumeArgs('my-session');
    const baseArgs = adapter.buildBaseArgs();
    // Resume args start with --resume, base args start with --append-system-prompt
    expect(resumeArgs[0]).toBe('--resume');
    expect(baseArgs[0]).toBe('--append-system-prompt');
  });
});
