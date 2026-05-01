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
  if (!factory) throw new Error(`Unknown model: ${modelId}. Run \`macc models\` to see available models.`);
  return factory();
}

export function listModels(): string[] {
  return Object.keys(MODEL_MAP);
}
