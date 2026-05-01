export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  usage?: TokenUsage;
}
