import type { Message, TokenUsage } from '../models/message.js';
import type { UsageSnapshot } from '../models/usage.js';

export class ContextStore {
  private messages: Message[] = [];
  private totalInputTokens = 0;

  constructor(
    private modelId: string,
    private contextWindowTokens: number,
    private warningThresholdPercent: number,
    private overLimitThresholdPercent: number,
    systemPrompt?: string
  ) {
    if (systemPrompt) {
      this.messages.push({ role: 'system', content: systemPrompt, timestamp: new Date() });
    }
  }

  addUserMessage(content: string): void {
    this.messages.push({ role: 'user', content, timestamp: new Date() });
  }

  addAssistantMessage(content: string, usage: TokenUsage): void {
    this.messages.push({ role: 'assistant', content, timestamp: new Date(), usage });
    // Track by input tokens of last turn — most accurate reflection of context fill
    this.totalInputTokens = usage.inputTokens;
  }

  getMessages(): Message[] {
    return [...this.messages];
  }

  getUsagePercent(): number {
    return (this.totalInputTokens / this.contextWindowTokens) * 100;
  }

  isNearLimit(thresholdPercent: number): boolean {
    return this.getUsagePercent() >= thresholdPercent;
  }

  getSnapshot(): UsageSnapshot {
    const usagePercent = this.getUsagePercent();
    return {
      modelId: this.modelId,
      contextWindowTokens: this.contextWindowTokens,
      inputTokensUsed: this.totalInputTokens,
      outputTokensUsed: 0,
      usagePercent,
      nearLimit: usagePercent >= this.warningThresholdPercent,
      overLimit: usagePercent >= this.overLimitThresholdPercent,
    };
  }

  getTurnCount(): number {
    return this.messages.filter(m => m.role === 'user').length;
  }
}
