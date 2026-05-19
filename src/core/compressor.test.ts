import { describe, it, expect, vi } from 'vitest';
import { compressContext } from './compressor.js';
import { ContextStore } from './context-store.js';
import type { IModelBackend, StreamChunk } from '../backends/base.js';

function makeMockBackend(jsonResponse: string): IModelBackend {
  return {
    modelId: 'claude-sonnet-4-6',
    displayName: 'Claude Sonnet',
    contextWindowTokens: 200_000,
    provider: 'anthropic',
    isAvailable: vi.fn().mockResolvedValue(true),
    stream: vi.fn().mockImplementation(
      async (_msgs, _sys, onChunk: (c: StreamChunk) => void) => {
        onChunk({ text: jsonResponse, done: false });
        onChunk({ text: '', done: true, usage: { inputTokens: 100, outputTokens: 50 } });
        return { inputTokens: 100, outputTokens: 50 };
      }
    ),
  };
}

const VALID_PACKET = JSON.stringify({
  version: '1',
  createdAt: new Date().toISOString(),
  fromModel: 'claude-sonnet-4-6',
  toModel: 'gemini-2.5-pro',
  cwd: '/project',
  summary: {
    ultimateGoal: 'Fix the auth middleware',
    completedWork: 'Reviewed the code',
    nextStep: 'Write the test',
    keyDecisions: ['Use JWT'],
    blockers: [],
    filesModified: ['src/auth.ts'],
  },
  handoffPrompt: 'Continue fixing the auth middleware. You have reviewed the code and next step is to write the test.',
});

describe('compressContext', () => {
  it('returns a valid HandoffPacket when backend returns well-formed JSON', async () => {
    const store = new ContextStore('claude-sonnet-4-6', 200_000, 90, 98, 'system');
    store.addUserMessage('fix auth');
    store.addAssistantMessage('looking at it', { inputTokens: 1000, outputTokens: 20 });

    const backend = makeMockBackend(VALID_PACKET);
    const packet = await compressContext(backend, store, 'gemini-2.5-pro', '/project');

    expect(packet.summary.ultimateGoal).toBe('Fix the auth middleware');
    expect(packet.fromModel).toBe('claude-sonnet-4-6');
    expect(packet.toModel).toBe('gemini-2.5-pro');
  });

  it('throws when backend returns no JSON', async () => {
    const store = new ContextStore('claude-sonnet-4-6', 200_000, 90, 98, 'system');
    store.addUserMessage('hi');
    store.addAssistantMessage('hello', { inputTokens: 100, outputTokens: 5 });

    const backend = makeMockBackend('Sorry, I cannot compress this.');
    await expect(compressContext(backend, store, 'gemini-2.5-pro', '/project'))
      .rejects.toThrow('Model did not return valid JSON');
  });

  it('uses native compress() if backend provides it', async () => {
    const store = new ContextStore('claude-sonnet-4-6', 200_000, 90, 98, 'system');
    store.addUserMessage('go');
    store.addAssistantMessage('done', { inputTokens: 100, outputTokens: 5 });

    const nativePacket = JSON.parse(VALID_PACKET);
    const backend: IModelBackend = {
      ...makeMockBackend(''),
      compress: vi.fn().mockResolvedValue(nativePacket),
    };

    const packet = await compressContext(backend, store, 'gemini-2.5-pro', '/project');
    expect(backend.compress).toHaveBeenCalled();
    expect((backend.stream as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(packet.summary.ultimateGoal).toBe('Fix the auth middleware');
  });
});
