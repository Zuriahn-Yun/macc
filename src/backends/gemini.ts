import { GoogleGenAI } from '@google/genai';
import type { IModelBackend, StreamChunk } from './base.js';
import type { Message, TokenUsage } from '../models/message.js';

const CONTEXT_WINDOWS: Record<string, number> = {
  'gemini-2.5-pro':    1_048_576,
  'gemini-2.0-flash':  1_048_576,
};

export class GeminiBackend implements IModelBackend {
  readonly provider = 'google' as const;
  readonly contextWindowTokens: number;
  readonly displayName: string;

  private client: GoogleGenAI;

  constructor(readonly modelId: string) {
    this.client = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY ?? '' });
    this.contextWindowTokens = CONTEXT_WINDOWS[modelId] ?? 1_000_000;
    this.displayName = modelId;
  }

  async stream(
    messages: Message[],
    systemPrompt: string,
    onChunk: (chunk: StreamChunk) => void
  ): Promise<TokenUsage> {
    const history = messages
      .filter(m => m.role !== 'system')
      .slice(0, -1)
      .map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

    const lastMessage = messages.filter(m => m.role !== 'system').at(-1);
    if (!lastMessage) return { inputTokens: 0, outputTokens: 0 };

    const chat = this.client.chats.create({
      model: this.modelId,
      history,
      config: { systemInstruction: systemPrompt },
    });

    let inputTokens = 0;
    let outputTokens = 0;

    const result = await chat.sendMessageStream({ message: lastMessage.content });

    for await (const chunk of result) {
      if (chunk.text) {
        onChunk({ text: chunk.text, done: false });
      }
      if (chunk.usageMetadata) {
        inputTokens = chunk.usageMetadata.promptTokenCount ?? 0;
        outputTokens = chunk.usageMetadata.candidatesTokenCount ?? 0;
      }
    }

    onChunk({ text: '', done: true, usage: { inputTokens, outputTokens } });
    return { inputTokens, outputTokens };
  }

  async isAvailable(): Promise<boolean> {
    return !!process.env.GOOGLE_API_KEY;
  }
}
