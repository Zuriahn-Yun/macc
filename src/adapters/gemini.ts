import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { IAgentAdapter, SessionContext, UsageSnapshot, LaunchArgs } from './base.js';
import type { HandoffPacket } from '../models/handoff-packet.js';

// Gemini 2.5 Pro context window
const CONTEXT_WINDOW = 1_048_576;

// Sessions live at ~/.gemini/tmp/<project-hash>/chats/session-*.jsonl
// The project hash is an opaque short ID maintained by Gemini CLI's registry,
// so we do a global scan and pick the most-recently modified file.
function findLatestGeminiSession(): string | null {
  const chatsGlob = path.join(os.homedir(), '.gemini', 'tmp');
  if (!fs.existsSync(chatsGlob)) return null;

  const allFiles: { file: string; mtime: number }[] = [];

  try {
    for (const hash of fs.readdirSync(chatsGlob)) {
      const chatsDir = path.join(chatsGlob, hash, 'chats');
      if (!fs.existsSync(chatsDir)) continue;
      for (const f of fs.readdirSync(chatsDir)) {
        if (!f.startsWith('session-') || !f.match(/\.jsonl?$/)) continue;
        const fp = path.join(chatsDir, f);
        try {
          allFiles.push({ file: fp, mtime: fs.statSync(fp).mtimeMs });
        } catch { /* skip */ }
      }
    }
  } catch { /* ~/.gemini/tmp not readable */ }

  allFiles.sort((a, b) => b.mtime - a.mtime);
  return allFiles.length > 0 ? allFiles[0].file : null;
}

// Extract readable text from a Gemini PartListUnion content value.
// Parts can be: { text }, { functionCall: { name, args } }, { functionResponse: { name, response } }
function extractGeminiContent(content: unknown): string {
  if (!content) return '';
  const parts = Array.isArray(content) ? content : [content];
  const out: string[] = [];

  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    const p = part as Record<string, unknown>;

    if (typeof p.text === 'string' && p.text) {
      out.push(p.text);
    } else if (p.functionCall && typeof p.functionCall === 'object') {
      const fc = p.functionCall as Record<string, unknown>;
      const args = fc.args ? JSON.stringify(fc.args).slice(0, 400) : '';
      out.push(`[Tool: ${fc.name}(${args})]`);
    } else if (p.functionResponse && typeof p.functionResponse === 'object') {
      const fr = p.functionResponse as Record<string, unknown>;
      const resp = fr.response ? JSON.stringify(fr.response).slice(0, 600) : '';
      out.push(`[Result: ${resp}]`);
    }
  }
  return out.join('\n');
}

// Gemini CLI JSONL format (from chatRecordingTypes.ts):
// Each line is a MessageRecord:
//   { id, timestamp, content: PartListUnion, type: 'user'|'gemini'|'info'|'error'|'warning', ... }
// Gemini-type messages also carry: tokens?: { input, output, cached, total }
function parseGeminiSession(filePath: string): {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  totalTokens: number;
} {
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  let totalTokens = 0;

  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const record = JSON.parse(line) as Record<string, unknown>;

      // Skip metadata/rewind records
      if ('$set' in record || '$rewindTo' in record) continue;

      const type = record.type as string;
      const content = extractGeminiContent(record.content);

      if (type === 'user' && content) {
        messages.push({ role: 'user', content });
      } else if (type === 'gemini') {
        if (content) messages.push({ role: 'assistant', content });
        // Use real token counts when available
        const tokens = record.tokens as Record<string, number> | null | undefined;
        if (tokens?.total && tokens.total > totalTokens) {
          totalTokens = tokens.total;
        }
      }
      // skip 'info', 'error', 'warning' — not useful for compression
    } catch { /* skip malformed lines */ }
  }

  // Fall back to character-based estimation if token counts were not recorded
  if (totalTokens === 0 && messages.length > 0) {
    const chars = messages.reduce((s, m) => s + m.content.length, 0);
    totalTokens = Math.round(chars * 1.3);
  }

  return { messages, totalTokens };
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
      return output.split('\n').some(line => /\bgemini\b/.test(line) && !line.includes('grep') && !line.includes('macc'));
    } catch {
      return false;
    }
  }

  async getUsageSnapshot(): Promise<UsageSnapshot> {
    const sessionFile = findLatestGeminiSession();
    if (!sessionFile) {
      return { agentId: this.id, isRunning: false, contextUsedPercent: 0, inputTokensUsed: 0, contextWindowTokens: CONTEXT_WINDOW };
    }
    const { totalTokens } = parseGeminiSession(sessionFile);
    const isRunning = await this.isRunning();
    return {
      agentId: this.id,
      isRunning,
      contextUsedPercent: (totalTokens / CONTEXT_WINDOW) * 100,
      inputTokensUsed: totalTokens,
      contextWindowTokens: CONTEXT_WINDOW,
    };
  }

  async extractSessionContext(): Promise<SessionContext | null> {
    const sessionFile = findLatestGeminiSession();
    if (!sessionFile) return null;
    const { messages, totalTokens } = parseGeminiSession(sessionFile);
    return { messages, cwd: process.cwd(), inputTokensUsed: totalTokens, contextWindowTokens: CONTEXT_WINDOW };
  }

  buildLaunchArgs(packet: HandoffPacket): LaunchArgs {
    return { args: [packet.handoffPrompt] };
  }
}
