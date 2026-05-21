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
  /** True when token count was estimated from character length rather than API-reported data. */
  isEstimated?: boolean;
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
  /** Args to resume a specific previous session (e.g. --resume <id>). Optional. */
  buildResumeArgs?(sessionId: string): string[];
  /** Returns the identifier of the most recently active session, for resume support. Optional. */
  getActiveSessionId?(): Promise<string | null>;
  /** Args + prompt for non-interactive (print) mode used by fanout subagents. Optional. */
  buildNonInteractiveArgs?(prompt: string): string[];
  isRunning(): Promise<boolean>;
  getContextWindowSize(): number;
}
