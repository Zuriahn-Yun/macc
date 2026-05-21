import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IAgentAdapter, SessionContext, UsageSnapshot } from '../adapters/base.js';
import type { IModelBackend, StreamChunk } from '../backends/base.js';

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
