import OpenAI from 'openai';
import type { IModelBackend, StreamChunk } from './base.js';
import type { Message, TokenUsage } from '../models/message.js';
import { CreditsExhaustedError, isCreditsExhaustedOutput } from '../utils/errors.js';

const CONTEXT_WINDOWS: Record<string, number> = {
  'gpt-4o':       128_000,
  'gpt-4o-mini':  128_000,
  'o1':           200_000,
  'o1-mini':      128_000,
};

export class OpenAIBackend implements IModelBackend {
  readonly provider = 'openai' as const;
  readonly contextWindowTokens: number;
  readonly displayName: string;

  constructor(readonly modelId: string) {
    this.contextWindowTokens = CONTEXT_WINDOWS[modelId] ?? 128_000;
    this.displayName = modelId;
  }

  private getClient(): OpenAI {
    return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }

  async stream(
    messages: Message[],
    systemPrompt: string,
    onChunk: (chunk: StreamChunk) => void,
    debug = false,
  ): Promise<TokenUsage> {
    const client = this.getClient();
    if (debug) console.error(`[debug] openai: streaming to model=${this.modelId} messages=${messages.length}`);

    const apiMessages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...messages
        .filter(m => m.role !== 'system')
        .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    ];

    let inputTokens = 0;
    let outputTokens = 0;

    try {
      const stream = await client.chat.completions.create({
        model: this.modelId,
        messages: apiMessages,
        stream: true,
        stream_options: { include_usage: true },
      });

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) onChunk({ text: delta, done: false });

        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens;
          outputTokens = chunk.usage.completion_tokens;
        }
      }
    } catch (err) {
      const status = (err as { status?: number }).status;
      const msg = err instanceof Error ? err.message : String(err);
      if (status === 402 || /insufficient_quota|exceeded.*quota/i.test(msg) || isCreditsExhaustedOutput(msg)) {
        throw new CreditsExhaustedError('openai', msg);
      }
      throw err;
    }

    onChunk({ text: '', done: true, usage: { inputTokens, outputTokens } });
    return { inputTokens, outputTokens };
  }

  async isAvailable(): Promise<boolean> {
    return !!process.env.OPENAI_API_KEY;
  }
}
