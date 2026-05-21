import type { HandoffPacket } from '../models/handoff-packet.js';

export interface SessionContext {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  cwd: string;
  inputTokensUsed: number;
  contextWindowTokens: number;
}

export interface UsageSnapshot {
  agentId: string;
  isRunning: boolean;
  contextUsedPercent: number;
  inputTokensUsed: number;
  contextWindowTokens: number;
}

export interface LaunchArgs {
  args: string[];
  stdin?: string;
}

export interface IAgentAdapter {
  readonly id: string;
  readonly commandName: string;
  getUsageSnapshot(): Promise<UsageSnapshot>;
  extractSessionContext(): Promise<SessionContext | null>;
  buildLaunchArgs(packet: HandoffPacket): LaunchArgs;
  /** Extra flags prepended on every spawn (e.g. --append-system-prompt). Optional. */
  buildBaseArgs?(): string[];
  isRunning(): Promise<boolean>;
  getContextWindowSize(): number;
}
