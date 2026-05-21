import { describe, it, expect, vi } from 'vitest';
import { compressContext, compressWithFallback } from './compressor.js';
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

function makeFailingBackend(errorMsg: string, provider: IModelBackend['provider'] = 'anthropic'): IModelBackend {
  return {
    modelId: 'claude-sonnet-4-6',
    displayName: 'Claude Sonnet',
    contextWindowTokens: 200_000,
    provider,
    isAvailable: vi.fn().mockResolvedValue(true),
    stream: vi.fn().mockRejectedValue(new Error(errorMsg)),
  };
}

describe('compressWithFallback', () => {
  it('succeeds with the first backend when no errors', async () => {
    const store = new ContextStore('claude-sonnet-4-6', 200_000, 90, 98, 'system');
    store.addUserMessage('do the thing');
    store.addAssistantMessage('done', { inputTokens: 100, outputTokens: 10 });

    const good = makeMockBackend(VALID_PACKET);
    const packet = await compressWithFallback([good], store, 'gemini-2.5-pro', '/project');
    expect(packet.summary.ultimateGoal).toBe('Fix the auth middleware');
  });

  it('falls back to second backend when first returns 429', async () => {
    const store = new ContextStore('claude-sonnet-4-6', 200_000, 90, 98, 'system');
    store.addUserMessage('do the thing');
    store.addAssistantMessage('done', { inputTokens: 100, outputTokens: 10 });

    const rateLimited = makeFailingBackend('429 Too Many Requests rate_limit_error');
    const good = { ...makeMockBackend(VALID_PACKET), provider: 'google' as const };

    const packet = await compressWithFallback([rateLimited, good], store, 'gemini-2.5-pro', '/project');
    expect(packet.summary.ultimateGoal).toBe('Fix the auth middleware');
    expect(rateLimited.stream).toHaveBeenCalled();
    expect(good.stream).toHaveBeenCalled();
  });

  it('falls back to next backend on non-rate-limit error', async () => {
    const store = new ContextStore('claude-sonnet-4-6', 200_000, 90, 98, 'system');
    store.addUserMessage('hi');
    store.addAssistantMessage('yo', { inputTokens: 50, outputTokens: 5 });

    const broken = makeFailingBackend('Invalid API key');
    const backup = makeMockBackend(VALID_PACKET);

    const packet = await compressWithFallback([broken, backup], store, 'gemini-2.5-pro', '/project');
    expect(packet.summary.ultimateGoal).toBe('Fix the auth middleware');
    expect(backup.stream).toHaveBeenCalled();
  });

  it('returns a raw fallback packet when all backends are rate-limited', async () => {
    const store = new ContextStore('claude-sonnet-4-6', 200_000, 90, 98, 'system');
    store.addUserMessage('fix the auth middleware');
    store.addAssistantMessage('working on it', { inputTokens: 50, outputTokens: 5 });

    const b1 = makeFailingBackend('429 rate_limit exceeded');
    const b2 = makeFailingBackend('Too Many Requests 429', 'google');

    const packet = await compressWithFallback([b1, b2], store, 'gemini-2.5-pro', '/project');
    expect(packet.version).toBe('1');
    expect(packet.handoffPrompt).toContain('fix the auth middleware');
    expect(packet.summary.blockers[0]).toMatch(/rate-limited/i);
  });

  it('deprioritises same-provider backends when sourceProvider is set', async () => {
    const store = new ContextStore('claude-sonnet-4-6', 200_000, 90, 98, 'system');
    store.addUserMessage('hi');
    store.addAssistantMessage('yo', { inputTokens: 50, outputTokens: 5 });

    const callOrder: string[] = [];
    const anthropicBackend: IModelBackend = {
      ...makeMockBackend(VALID_PACKET),
      provider: 'anthropic',
      stream: vi.fn().mockImplementation(async (_m, _s, onChunk: (c: StreamChunk) => void) => {
        callOrder.push('anthropic');
        onChunk({ text: VALID_PACKET, done: false });
        onChunk({ text: '', done: true, usage: { inputTokens: 10, outputTokens: 5 } });
        return { inputTokens: 10, outputTokens: 5 };
      }),
    };
    const googleBackend: IModelBackend = {
      ...makeMockBackend(VALID_PACKET),
      provider: 'google',
      stream: vi.fn().mockImplementation(async (_m, _s, onChunk: (c: StreamChunk) => void) => {
        callOrder.push('google');
        onChunk({ text: VALID_PACKET, done: false });
        onChunk({ text: '', done: true, usage: { inputTokens: 10, outputTokens: 5 } });
        return { inputTokens: 10, outputTokens: 5 };
      }),
    };

    // Pass anthropic first in array, but tell fallback that source is anthropic
    await compressWithFallback([anthropicBackend, googleBackend], store, 'gemini-2.5-pro', '/project', 'anthropic');

    // Google should have been tried first even though it was second in the list
    expect(callOrder[0]).toBe('google');
    expect(anthropicBackend.stream).not.toHaveBeenCalled();
  });

  it('returns raw fallback when all backends fail with non-rate-limit errors', async () => {
    const store = new ContextStore('claude-sonnet-4-6', 200_000, 90, 98, 'system');
    store.addUserMessage('rewrite everything');
    store.addAssistantMessage('ok', { inputTokens: 50, outputTokens: 5 });

    const b1 = makeFailingBackend('Schema validation failed');
    const b2 = makeFailingBackend('Network timeout');

    const packet = await compressWithFallback([b1, b2], store, 'gemini-2.5-pro', '/project');
    expect(packet.version).toBe('1');
    expect(packet.handoffPrompt).toContain('rewrite everything');
    expect(packet.summary.blockers[0]).toMatch(/rate-limited/i);
  });

  it('throws when no backends provided', async () => {
    const store = new ContextStore('claude-sonnet-4-6', 200_000, 90, 98, 'system');
    store.addUserMessage('hi');

    await expect(compressWithFallback([], store, 'gemini-2.5-pro', '/project'))
      .rejects.toThrow('No AI backends available');
  });
});
