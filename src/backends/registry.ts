import type { IModelBackend } from './base.js';
import { AnthropicBackend } from './anthropic.js';
import { GeminiBackend } from './gemini.js';

const MODEL_MAP: Record<string, () => IModelBackend> = {
  'claude-opus-4-7':    () => new AnthropicBackend('claude-opus-4-7'),
  'claude-sonnet-4-6':  () => new AnthropicBackend('claude-sonnet-4-6'),
  'claude-haiku-4-5':   () => new AnthropicBackend('claude-haiku-4-5'),
  'gemini-2.5-pro':     () => new GeminiBackend('gemini-2.5-pro'),
  'gemini-2.0-flash':   () => new GeminiBackend('gemini-2.0-flash'),
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
