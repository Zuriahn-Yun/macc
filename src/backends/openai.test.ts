import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Expose the mock stream fn so individual tests can control its return value.
const mockChatStream = vi.fn();

vi.mock('openai', () => {
  return {
    default: class MockOpenAI {
      chat = { completions: { stream: mockChatStream } };
    },
  };
});

import type { StreamChunk } from './base.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChunks(texts: string[], usage = { prompt_tokens: 200, completion_tokens: 80 }) {
  const chunks = texts.map(t => ({
    choices: [{ delta: { content: t } }],
    usage: null,
  }));
  // Last chunk carries usage
  const last = { choices: [{ delta: {} }], usage };
  return [...chunks, last];
}

async function* asyncIter<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OpenAIBackend', () => {
  let originalApiKey: string | undefined;

  beforeEach(() => {
    originalApiKey = process.env.OPENAI_API_KEY;
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalApiKey;
    }
  });

  // --- isAvailable ---

  it('isAvailable returns true when OPENAI_API_KEY is set', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const { OpenAIBackend } = await import('./openai.js');
    const backend = new OpenAIBackend('gpt-4o');
    expect(await backend.isAvailable()).toBe(true);
  });

  it('isAvailable returns false when OPENAI_API_KEY is not set', async () => {
    delete process.env.OPENAI_API_KEY;
    const { OpenAIBackend } = await import('./openai.js');
    const backend = new OpenAIBackend('gpt-4o');
    expect(await backend.isAvailable()).toBe(false);
  });

  // --- context windows ---

  it('gpt-4o has 128k context window', async () => {
    const { OpenAIBackend } = await import('./openai.js');
    expect(new OpenAIBackend('gpt-4o').contextWindowTokens).toBe(128_000);
  });

  it('gpt-4o-mini has 128k context window', async () => {
    const { OpenAIBackend } = await import('./openai.js');
    expect(new OpenAIBackend('gpt-4o-mini').contextWindowTokens).toBe(128_000);
  });

  it('unknown model defaults to 128k context window', async () => {
    const { OpenAIBackend } = await import('./openai.js');
    expect(new OpenAIBackend('gpt-9000').contextWindowTokens).toBe(128_000);
  });

  // --- provider identity ---

  it('has provider = openai', async () => {
    const { OpenAIBackend } = await import('./openai.js');
    expect(new OpenAIBackend('gpt-4o').provider).toBe('openai');
  });

  // --- stream ---

  it('stream collects text chunks and returns token usage', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    mockChatStream.mockReturnValue(asyncIter(makeChunks(['Hello', ', ', 'world'])));

    const { OpenAIBackend } = await import('./openai.js');
    const backend = new OpenAIBackend('gpt-4o');

    const chunks: StreamChunk[] = [];
    const usage = await backend.stream(
      [{ role: 'user', content: 'Say hello', timestamp: new Date() }],
      'You are helpful.',
      c => chunks.push(c),
    );

    const textChunks = chunks.filter(c => !c.done);
    expect(textChunks.map(c => c.text).join('')).toBe('Hello, world');
    expect(usage.inputTokens).toBe(200);
    expect(usage.outputTokens).toBe(80);

    const doneChunk = chunks.find(c => c.done);
    expect(doneChunk?.usage?.inputTokens).toBe(200);
    expect(doneChunk?.usage?.outputTokens).toBe(80);
  });

  it('stream includes system prompt as first message', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    let capturedMessages: unknown[] = [];
    mockChatStream.mockImplementation(({ messages }: { messages: unknown[] }) => {
      capturedMessages = messages;
      return asyncIter(makeChunks(['ok']));
    });

    const { OpenAIBackend } = await import('./openai.js');
    const backend = new OpenAIBackend('gpt-4o');

    await backend.stream(
      [{ role: 'user', content: 'do the thing', timestamp: new Date() }],
      'You are an expert.',
      () => {},
    );

    expect((capturedMessages[0] as { role: string }).role).toBe('system');
    expect((capturedMessages[0] as { content: string }).content).toBe('You are an expert.');
    expect((capturedMessages[1] as { role: string }).role).toBe('user');
  });

  it('stream handles empty delta content without throwing', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const chunks = [
      { choices: [{ delta: { content: undefined } }], usage: null },
      { choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ];
    mockChatStream.mockReturnValue(asyncIter(chunks));

    const { OpenAIBackend } = await import('./openai.js');
    const backend = new OpenAIBackend('gpt-4o');

    await expect(
      backend.stream([{ role: 'user', content: 'hi', timestamp: new Date() }], 'sys', () => {})
    ).resolves.toBeDefined();
  });
});

// --- registry integration ---

describe('registry includes OpenAI models', () => {
  it('getBackend returns OpenAIBackend for gpt-4o', async () => {
    const { getBackend } = await import('./registry.js');
    const backend = getBackend('gpt-4o');
    expect(backend.provider).toBe('openai');
    expect(backend.modelId).toBe('gpt-4o');
    expect(backend.contextWindowTokens).toBe(128_000);
  });

  it('getBackend returns OpenAIBackend for gpt-4o-mini', async () => {
    const { getBackend } = await import('./registry.js');
    const backend = getBackend('gpt-4o-mini');
    expect(backend.provider).toBe('openai');
  });

  it('listModels includes gpt-4o and gpt-4o-mini', async () => {
    const { listModels } = await import('./registry.js');
    const models = listModels();
    expect(models).toContain('gpt-4o');
    expect(models).toContain('gpt-4o-mini');
  });

  it('all models in default handoffOrder exist in registry', async () => {
    const { loadConfig } = await import('../utils/config.js');
    const { listModels } = await import('./registry.js');
    const config = await loadConfig();
    const available = listModels();
    for (const model of config.handoffOrder) {
      expect(available, `${model} is in handoffOrder but not in MODEL_MAP`).toContain(model);
    }
  });
});
