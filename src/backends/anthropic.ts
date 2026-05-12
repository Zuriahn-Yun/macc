import Anthropic from '@anthropic-ai/sdk';
import type { IModelBackend, StreamChunk } from './base.js';
import type { Message, TokenUsage } from '../models/message.js';
import { readClaudeCredentials } from '../auth/credentials.js';

const CONTEXT_WINDOWS: Record<string, number> = {
  'claude-opus-4-7':       200_000,
  'claude-sonnet-4-6':     200_000,
  'claude-haiku-4-5':      200_000,
};

export class AnthropicBackend implements IModelBackend {
  readonly provider = 'anthropic' as const;
  readonly contextWindowTokens: number;
  readonly displayName: string;

  constructor(readonly modelId: string) {
    this.contextWindowTokens = CONTEXT_WINDOWS[modelId] ?? 200_000;
    this.displayName = modelId;
  }

  private getClient(): Anthropic {
    // Prefer Claude CLI OAuth token over raw API key
    const creds = readClaudeCredentials();
    if (creds) {
      return new Anthropic({ authToken: creds.accessToken });
    }
    // Fallback: ANTHROPIC_API_KEY env var (set by the user manually)
    return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }

  async stream(
    messages: Message[],
    systemPrompt: string,
    onChunk: (chunk: StreamChunk) => void
  ): Promise<TokenUsage> {
    const client = this.getClient();
    const apiMessages = messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    let inputTokens = 0;
    let outputTokens = 0;

    const stream = await client.messages.stream({
      model: this.modelId,
      max_tokens: 8096,
      system: systemPrompt,
      messages: apiMessages,
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        onChunk({ text: event.delta.text, done: false });
      }
      if (event.type === 'message_delta' && event.usage) {
        outputTokens = event.usage.output_tokens;
      }
      if (event.type === 'message_start' && event.message.usage) {
        inputTokens = event.message.usage.input_tokens;
      }
    }

    onChunk({ text: '', done: true, usage: { inputTokens, outputTokens } });
    return { inputTokens, outputTokens };
  }

  async isAvailable(): Promise<boolean> {
    return !!(readClaudeCredentials() || process.env.ANTHROPIC_API_KEY);
  }
}
