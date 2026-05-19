import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { IAgentAdapter, SessionContext, UsageSnapshot, LaunchArgs } from './base.js';
import type { HandoffPacket } from '../models/handoff-packet.js';

// OpenAI Codex CLI — https://github.com/openai/codex
// Session files live in ~/.codex/
const CONTEXT_WINDOW = 128_000; // gpt-4o default; codex uses whatever model is configured

function findLatestCodexSession(): string | null {
  const codexDir = path.join(os.homedir(), '.codex');
  if (!fs.existsSync(codexDir)) return null;

  const files = fs.readdirSync(codexDir)
    .filter(f => f.endsWith('.json') || f.endsWith('.jsonl'))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(codexDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  return files.length > 0 ? path.join(codexDir, files[0].name) : null;
}

function parseCodexSession(filePath: string): Array<{ role: 'user' | 'assistant'; content: string }> {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

    // JSONL format
    if (filePath.endsWith('.jsonl')) {
      for (const line of raw.split('\n').filter(Boolean)) {
        try {
          const entry = JSON.parse(line);
          const role = entry.role === 'assistant' ? 'assistant' : 'user';
          const content = typeof entry.content === 'string'
            ? entry.content
            : Array.isArray(entry.content)
              ? entry.content.map((c: { text?: string }) => c.text ?? '').join('')
              : '';
          if (content) messages.push({ role, content });
        } catch { /* skip */ }
      }
      return messages;
    }

    // JSON array format
    const entries = JSON.parse(raw);
    for (const entry of (Array.isArray(entries) ? entries : [])) {
      const role = entry.role === 'assistant' ? 'assistant' : 'user';
      const content = typeof entry.content === 'string' ? entry.content : '';
      if (content) messages.push({ role, content });
    }
    return messages;
  } catch {
    return [];
  }
}

function estimateTokens(messages: Array<{ content: string }>): number {
  return Math.round(messages.reduce((s, m) => s + m.content.length, 0) * 1.3);
}

export class CodexAdapter implements IAgentAdapter {
  readonly id = 'codex';
  readonly commandName = 'codex';

  getContextWindowSize(): number {
    return CONTEXT_WINDOW;
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
      return { agentId: this.id, isRunning: false, contextUsedPercent: 0, inputTokensUsed: 0, contextWindowTokens: CONTEXT_WINDOW };
    }
    const messages = parseCodexSession(sessionFile);
    const estimated = estimateTokens(messages);
    const isRunning = await this.isRunning();
    return {
      agentId: this.id,
      isRunning,
      contextUsedPercent: (estimated / CONTEXT_WINDOW) * 100,
      inputTokensUsed: estimated,
      contextWindowTokens: CONTEXT_WINDOW,
    };
  }

  async extractSessionContext(): Promise<SessionContext | null> {
    const sessionFile = findLatestCodexSession();
    if (!sessionFile) return null;
    const messages = parseCodexSession(sessionFile);
    const estimated = estimateTokens(messages);
    return { messages, cwd: process.cwd(), inputTokensUsed: estimated, contextWindowTokens: CONTEXT_WINDOW };
  }

  buildLaunchArgs(packet: HandoffPacket): LaunchArgs {
    // codex "prompt" starts an interactive session with the prompt as the first message
    return { args: [packet.handoffPrompt] };
  }
}
