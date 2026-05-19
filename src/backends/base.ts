import type { Message, TokenUsage } from '../models/message.js';
import type { HandoffPacket } from '../models/handoff-packet.js';

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
    onChunk: (chunk: StreamChunk) => void,
    debug?: boolean
  ): Promise<TokenUsage>;

  isAvailable(): Promise<boolean>;

  // Optional: native context compression. If absent, compressor falls back to
  // prompting this backend with COMPRESSION_PROMPT via stream().
  compress?(
    messages: Message[],
    fromModel: string,
    toModel: string,
    cwd: string
  ): Promise<HandoffPacket>;
}
