import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { IAgentAdapter, SessionContext, UsageSnapshot, LaunchArgs } from './base.js';
import type { HandoffPacket } from '../models/handoff-packet.js';

// OpenAI Codex CLI — https://github.com/openai/codex
// Sessions live at ~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl
// Each line: { type, payload }
//   type='event_msg',    payload.type='user_message' → user turn (payload.message = text)
//   type='response_item',payload.role='assistant'    → assistant turn (payload.content=[{text}])
//   type='event_msg',    payload.model_context_window → context window size for this model
//   type='event_msg',    payload.rate_limits.primary.used_percent → usage %

const CONTEXT_WINDOW_DEFAULT = 128_000;

function findLatestCodexSession(): string | null {
  const sessionsRoot = path.join(os.homedir(), '.codex', 'sessions');
  if (!fs.existsSync(sessionsRoot)) return null;

  const allFiles: { file: string; mtime: number }[] = [];

  function scan(dir: string, depth = 0): void {
    if (depth > 4) return;
    try {
      for (const entry of fs.readdirSync(dir)) {
        const fp = path.join(dir, entry);
        try {
          const stat = fs.statSync(fp);
          if (stat.isDirectory()) {
            scan(fp, depth + 1);
          } else if (entry.startsWith('rollout-') && entry.endsWith('.jsonl')) {
            allFiles.push({ file: fp, mtime: stat.mtimeMs });
          }
        } catch { /* skip */ }
      }
    } catch { /* skip unreadable */ }
  }

  scan(sessionsRoot);
  allFiles.sort((a, b) => b.mtime - a.mtime);
  return allFiles.length > 0 ? allFiles[0].file : null;
}

function parseCodexSession(filePath: string): {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  contextWindow: number;
  usedPercent: number;
} {
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  let contextWindow = CONTEXT_WINDOW_DEFAULT;
  let usedPercent = 0;

  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as { type: string; payload: Record<string, unknown> };
      const { type, payload } = obj;

      if (type === 'event_msg') {
        // User message
        if (payload.type === 'user_message' && typeof payload.message === 'string' && payload.message) {
          messages.push({ role: 'user', content: payload.message });
        }
        // Model context window size
        if (typeof payload.model_context_window === 'number') {
          contextWindow = payload.model_context_window;
        }
        // Rate limit / usage info
        const rl = payload.rate_limits as Record<string, unknown> | null | undefined;
        const primary = rl?.primary as Record<string, unknown> | null | undefined;
        if (typeof primary?.used_percent === 'number') {
          usedPercent = primary.used_percent;
        }
      }

      if (type === 'response_item') {
        if (payload.role === 'assistant') {
          const content = payload.content;
          let text = '';
          if (Array.isArray(content)) {
            text = content
              .map(c => (typeof c === 'object' && c && typeof (c as Record<string, unknown>).text === 'string' ? (c as Record<string, unknown>).text : ''))
              .join('');
          } else if (typeof content === 'string') {
            text = content;
          }
          if (text) messages.push({ role: 'assistant', content: text });
        }
      }
    } catch { /* skip malformed lines */ }
  }

  return { messages, contextWindow, usedPercent };
}

export class CodexAdapter implements IAgentAdapter {
  readonly id = 'codex';
  readonly commandName = 'codex';

  getContextWindowSize(): number {
    return CONTEXT_WINDOW_DEFAULT;
  }

  async isRunning(): Promise<boolean> {
    try {
      const output = execFileSync('ps', ['aux'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return output.split('\n').some(line => /\bcodex\b/.test(line) && !line.includes('grep') && !line.includes('macc'));
    } catch {
      return false;
    }
  }

  async getUsageSnapshot(): Promise<UsageSnapshot> {
    const sessionFile = findLatestCodexSession();
    if (!sessionFile) {
      return { agentId: this.id, isRunning: false, contextUsedPercent: 0, inputTokensUsed: 0, contextWindowTokens: CONTEXT_WINDOW_DEFAULT };
    }
    const { messages, contextWindow, usedPercent } = parseCodexSession(sessionFile);
    const isRunning = await this.isRunning();
    // Use the API-reported usage % when available; fall back to char estimation (~4 chars/token)
    const isEstimated = usedPercent === 0;
    const inputTokensUsed = usedPercent > 0
      ? Math.round((usedPercent / 100) * contextWindow)
      : Math.round(messages.reduce((s, m) => s + m.content.length, 0) / 4);
    const contextUsedPercent = usedPercent > 0
      ? usedPercent
      : (inputTokensUsed / contextWindow) * 100;

    return { agentId: this.id, isRunning, contextUsedPercent, inputTokensUsed, contextWindowTokens: contextWindow, isEstimated };
  }

  async extractSessionContext(): Promise<SessionContext | null> {
    const sessionFile = findLatestCodexSession();
    if (!sessionFile) return null;
    const { messages, contextWindow } = parseCodexSession(sessionFile);
    if (messages.length === 0) return null;
    const inputTokensUsed = Math.round(messages.reduce((s, m) => s + m.content.length, 0) / 4);
    return { messages, cwd: process.cwd(), inputTokensUsed, contextWindowTokens: contextWindow };
  }

  buildNonInteractiveArgs(prompt: string): string[] {
    // Codex CLI: `codex --full-auto "prompt"` runs non-interactively
    return ['--full-auto', prompt];
  }

  buildLaunchArgs(packet: HandoffPacket): LaunchArgs {
    return { args: [packet.handoffPrompt] };
  }
}
