import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IAgentAdapter, SessionContext, UsageSnapshot } from '../adapters/base.js';
import type { IModelBackend, StreamChunk } from '../backends/base.js';

// ---------------------------------------------------------------------------
// Mock child_process at top level (vi.mock is hoisted before all imports)
// ---------------------------------------------------------------------------

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAdapter(messages: SessionContext['messages'] = []): IAgentAdapter {
  return {
    id: 'claude-code',
    commandName: 'claude',
    getContextWindowSize: () => 200_000,
    isRunning: vi.fn().mockResolvedValue(true),
    getUsageSnapshot: vi.fn().mockResolvedValue({
      agentId: 'claude-code',
      isRunning: true,
      contextUsedPercent: 80,
      inputTokensUsed: 160_000,
      contextWindowTokens: 200_000,
    } satisfies UsageSnapshot),
    extractSessionContext: vi.fn().mockResolvedValue({
      messages,
      cwd: '/project',
      inputTokensUsed: 160_000,
      contextWindowTokens: 200_000,
    } satisfies SessionContext),
    buildLaunchArgs: vi.fn().mockReturnValue({ args: ['prompt'] }),
  };
}

function makeBackendWithResponses(responses: string[]): IModelBackend {
  let callIdx = 0;
  return {
    modelId: 'claude-sonnet-4-6',
    displayName: 'Claude Sonnet',
    contextWindowTokens: 200_000,
    provider: 'anthropic',
    isAvailable: vi.fn().mockResolvedValue(true),
    stream: vi.fn().mockImplementation(
      async (_msgs: unknown, _sys: unknown, onChunk: (c: StreamChunk) => void) => {
        const resp = responses[callIdx++ % responses.length];
        onChunk({ text: resp, done: false });
        onChunk({ text: '', done: true, usage: { inputTokens: 100, outputTokens: 50 } });
        return { inputTokens: 100, outputTokens: 50 };
      }
    ),
  };
}

function makeChild(exitCode: number, stdout = 'subagent output') {
  return {
    stdout: {
      on: vi.fn((event: string, cb: (d: Buffer) => void) => {
        if (event === 'data') cb(Buffer.from(stdout));
      }),
    },
    stderr: {
      on: vi.fn((event: string, cb: (d: Buffer) => void) => {
        if (event === 'data' && exitCode !== 0) cb(Buffer.from('error details'));
      }),
    },
    on: vi.fn((event: string, cb: (code: number) => void) => {
      if (event === 'close') cb(exitCode);
    }),
    error: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fanOut', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Re-import spawn mock after clearing
    const cp = await import('node:child_process');
    vi.mocked(cp.spawn).mockReturnValue(makeChild(0) as unknown as ReturnType<typeof cp.spawn>);
  });

  it('aborts gracefully when session has no messages', async () => {
    const { fanOut } = await import('./fanout.js');
    const adapter = makeAdapter([]); // empty session
    const backend = makeBackendWithResponses(['{}']);

    await expect(
      fanOut(adapter, backend, { count: 2, commandName: 'claude', printFlag: '--print' })
    ).resolves.toBeUndefined();

    // No backend calls — bailed out before decomposition
    expect(backend.stream).not.toHaveBeenCalled();
  });

  it('calls decompose and synthesize backends with session context', async () => {
    const { fanOut } = await import('./fanout.js');

    const decompositionResponse = JSON.stringify({
      subtasks: [
        { title: 'Write tests for auth', prompt: 'Write unit tests for /src/auth.ts' },
        { title: 'Fix the login bug', prompt: 'Fix bug on line 42 of /src/auth.ts' },
      ],
    });
    const synthesisResponse = JSON.stringify({
      summary: 'Both subtasks completed successfully.',
      nextStep: 'Deploy to staging.',
      combinedOutput: 'Tests written and bug fixed.',
    });

    const backend = makeBackendWithResponses([decompositionResponse, synthesisResponse]);

    const cp = await import('node:child_process');
    vi.mocked(cp.spawn).mockReturnValue(makeChild(0, 'task done') as unknown as ReturnType<typeof cp.spawn>);

    const messages: SessionContext['messages'] = [
      { role: 'user', content: 'Fix the auth middleware and add tests' },
      { role: 'assistant', content: 'I will look at the auth module.\n[Tool: Read({"file_path":"/src/auth.ts"})]' },
      { role: 'user', content: '[Result: export function login() { ... }]' },
    ];
    const adapter = makeAdapter(messages);

    await fanOut(adapter, backend, { count: 2, commandName: 'claude', printFlag: '--print' });

    // decompose + synthesize = 2 backend calls
    expect(backend.stream).toHaveBeenCalledTimes(2);
    // Two subagents spawned
    expect(cp.spawn).toHaveBeenCalledTimes(2);
    // Each called with --print flag
    expect(cp.spawn).toHaveBeenCalledWith('claude', ['--print', expect.any(String)], expect.any(Object));
  });

  it('handles all subagents failing without throwing', async () => {
    const { fanOut } = await import('./fanout.js');

    const decompositionResponse = JSON.stringify({
      subtasks: [
        { title: 'Task A', prompt: 'Do task A' },
        { title: 'Task B', prompt: 'Do task B' },
      ],
    });
    const backend = makeBackendWithResponses([decompositionResponse]);

    const cp = await import('node:child_process');
    vi.mocked(cp.spawn).mockReturnValue(makeChild(1, '') as unknown as ReturnType<typeof cp.spawn>);

    const messages: SessionContext['messages'] = [
      { role: 'user', content: 'Do some work' },
    ];
    const adapter = makeAdapter(messages);

    // Should not throw even when all subagents fail
    await expect(
      fanOut(adapter, backend, { count: 2, commandName: 'claude', printFlag: '--print' })
    ).resolves.toBeUndefined();
  });

  it('slices subtasks to requested count', async () => {
    const { fanOut } = await import('./fanout.js');

    // Backend returns more subtasks than requested — fanOut should cap at count
    const decompositionResponse = JSON.stringify({
      subtasks: [
        { title: 'Task 1', prompt: 'prompt 1' },
        { title: 'Task 2', prompt: 'prompt 2' },
        { title: 'Task 3', prompt: 'prompt 3' },
        { title: 'Task 4', prompt: 'prompt 4' },
      ],
    });
    const synthesisResponse = JSON.stringify({
      summary: 'Done.',
      nextStep: 'Deploy.',
      combinedOutput: 'Output.',
    });
    const backend = makeBackendWithResponses([decompositionResponse, synthesisResponse]);

    const cp = await import('node:child_process');
    vi.mocked(cp.spawn).mockReturnValue(makeChild(0) as unknown as ReturnType<typeof cp.spawn>);

    const messages: SessionContext['messages'] = [{ role: 'user', content: 'do things' }];
    const adapter = makeAdapter(messages);

    await fanOut(adapter, backend, { count: 2, commandName: 'claude', printFlag: '--print' });

    // Only 2 subagents should have been spawned despite 4 subtasks returned
    expect(cp.spawn).toHaveBeenCalledTimes(2);
  });
});
