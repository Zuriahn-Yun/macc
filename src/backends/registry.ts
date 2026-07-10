import type { IModelBackend } from './base.js';
import { AnthropicBackend } from './anthropic.js';
import { GeminiBackend } from './gemini.js';
import { OpenAIBackend } from './openai.js';

const MODEL_MAP: Record<string, () => IModelBackend> = {
  // Anthropic — current generation
  'claude-opus-4-8':           () => new AnthropicBackend('claude-opus-4-8'),
  'claude-sonnet-5':           () => new AnthropicBackend('claude-sonnet-5'),
  'claude-sonnet-4-6':         () => new AnthropicBackend('claude-sonnet-4-6'),
  'claude-haiku-4-5-20251001': () => new AnthropicBackend('claude-haiku-4-5-20251001'),
  // Anthropic — previous (kept for backwards-compat with existing config files)
  'claude-opus-4-7':           () => new AnthropicBackend('claude-opus-4-7'),
  'claude-haiku-4-5':          () => new AnthropicBackend('claude-haiku-4-5'),
  // Google
  'gemini-2.5-pro':            () => new GeminiBackend('gemini-2.5-pro'),
  'gemini-2.0-flash':          () => new GeminiBackend('gemini-2.0-flash'),
  // OpenAI
  'gpt-4o':                    () => new OpenAIBackend('gpt-4o'),
  'gpt-4o-mini':               () => new OpenAIBackend('gpt-4o-mini'),
};

export function getBackend(modelId: string): IModelBackend {
  const factory = MODEL_MAP[modelId];
  if (!factory) throw new Error(`Unknown model: ${modelId}. Check the configured handoff models in ~/.macc/config.json.`);
  return factory();
}

export function listModels(): string[] {
  return Object.keys(MODEL_MAP);
}

// Returns the first backend whose API key is present, or null if none are set.
export async function detectAvailableBackend(): Promise<IModelBackend | null> {
  for (const factory of Object.values(MODEL_MAP)) {
    const backend = factory();
    if (await backend.isAvailable()) return backend;
  }
  return null;
}

// Returns ALL backends with credentials present, in registry order.
export async function detectAllAvailableBackends(): Promise<IModelBackend[]> {
  const results: IModelBackend[] = [];
  for (const factory of Object.values(MODEL_MAP)) {
    const backend = factory();
    if (await backend.isAvailable()) results.push(backend);
  }
  return results;
}
