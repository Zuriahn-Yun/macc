import type { Message, TokenUsage } from '../models/message.js';

export interface StreamChunk {
  text: string;
  done: boolean;
  usage?: TokenUsage;
}

export interface IModelBackend {
  readonly modelId: string;
  readonly displayName: string;
  readonly contextWindowTokens: number;
  readonly provider: 'anthropic' | 'google' | 'openai';

  stream(
    messages: Message[],
    systemPrompt: string,
    onChunk: (chunk: StreamChunk) => void
  ): Promise<TokenUsage>;

  isAvailable(): Promise<boolean>;
}
