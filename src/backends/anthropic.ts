import Anthropic from '@anthropic-ai/sdk';
import type { IModelBackend, StreamChunk } from './base.js';
import type { Message, TokenUsage } from '../models/message.js';

const CONTEXT_WINDOWS: Record<string, number> = {
  'claude-opus-4-7':       200_000,
  'claude-sonnet-4-6':     200_000,
  'claude-haiku-4-5':      200_000,
};

export class AnthropicBackend implements IModelBackend {
  readonly provider = 'anthropic' as const;
  readonly contextWindowTokens: number;
  readonly displayName: string;

  private client: Anthropic;

  constructor(readonly modelId: string) {
    this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    this.contextWindowTokens = CONTEXT_WINDOWS[modelId] ?? 200_000;
    this.displayName = modelId;
  }

  async stream(
    messages: Message[],
    systemPrompt: string,
    onChunk: (chunk: StreamChunk) => void
  ): Promise<TokenUsage> {
    const apiMessages = messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    let inputTokens = 0;
    let outputTokens = 0;

    const stream = await this.client.messages.stream({
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
    return !!process.env.ANTHROPIC_API_KEY;
  }
}
