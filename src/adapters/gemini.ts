import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { IAgentAdapter, SessionContext, UsageSnapshot, LaunchArgs } from './base.js';
import type { HandoffPacket } from '../models/handoff-packet.js';

// Gemini CLI's context window (Gemini 2.5 Pro).
const CONTEXT_WINDOW = 1_048_576;
// Gemini CLI doesn't always expose exact token counts; treat 70% as the trigger.
const ESTIMATED_LIMIT_FRACTION = 0.7;

function findLatestGeminiSession(): string | null {
  const geminiDir = path.join(os.homedir(), '.gemini');
  if (!fs.existsSync(geminiDir)) return null;

  const files = fs.readdirSync(geminiDir)
    .filter(f => f.endsWith('.json'))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(geminiDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  return files.length > 0 ? path.join(geminiDir, files[0].name) : null;
}

function estimateTokens(messages: Array<{ role: string; content: string }>): number {
  // Rough estimate: ~1.3 tokens per character of content
  const chars = messages.reduce((sum, m) => sum + m.content.length, 0);
  return Math.round(chars * 1.3);
}

function parseGeminiSession(filePath: string): Array<{ role: 'user' | 'assistant'; content: string }> {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const turns: Array<{ role: 'user' | 'assistant'; content: string }> = [];

    // Gemini CLI session format is still evolving — handle known structures gracefully.
    const entries = Array.isArray(raw) ? raw : (raw.messages ?? raw.history ?? []);
    for (const entry of entries) {
      const role = entry.role === 'model' ? 'assistant' : (entry.role ?? 'user');
      const content = typeof entry.content === 'string'
        ? entry.content
        : entry.parts?.map((p: { text?: string }) => p.text ?? '').join('') ?? '';
      if (content) turns.push({ role: role as 'user' | 'assistant', content });
    }
    return turns;
  } catch {
    return [];
  }
}

export class GeminiAdapter implements IAgentAdapter {
  readonly id = 'gemini-cli';
  readonly commandName = 'gemini';

  getContextWindowSize(): number {
    return CONTEXT_WINDOW;
  }

  async isRunning(): Promise<boolean> {
    try {
      const output = execFileSync('ps', ['aux'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return output.split('\n').some(line => /\bgemini\b/.test(line) && !line.includes('grep'));
    } catch {
      return false;
    }
  }

  async getUsageSnapshot(): Promise<UsageSnapshot> {
    const sessionFile = findLatestGeminiSession();
    if (!sessionFile) {
      return { agentId: this.id, isRunning: false, contextUsedPercent: 0, inputTokensUsed: 0, contextWindowTokens: CONTEXT_WINDOW };
    }

    const messages = parseGeminiSession(sessionFile);
    const estimated = estimateTokens(messages);
    const isRunning = await this.isRunning();
    // Scale the estimate so that a full 1M context = ESTIMATED_LIMIT_FRACTION on our scale.
    const contextUsedPercent = (estimated / CONTEXT_WINDOW) * 100;

    return { agentId: this.id, isRunning, contextUsedPercent, inputTokensUsed: estimated, contextWindowTokens: CONTEXT_WINDOW };
  }

  async extractSessionContext(): Promise<SessionContext | null> {
    const sessionFile = findLatestGeminiSession();
    if (!sessionFile) return null;

    const messages = parseGeminiSession(sessionFile);
    const estimated = estimateTokens(messages);
    return { messages, cwd: process.cwd(), inputTokensUsed: estimated, contextWindowTokens: CONTEXT_WINDOW };
  }

  buildLaunchArgs(packet: HandoffPacket): LaunchArgs {
    // Gemini CLI reads from stdin when not interactive, treating it as the first message.
    return { args: [], stdin: packet.handoffPrompt };
  }

  nearLimit(): boolean {
    return true; // evaluated against contextUsedPercent >= 70 by the orchestrator
  }
}
