import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { IAgentAdapter, SessionContext, UsageSnapshot, LaunchArgs } from './base.js';
import type { HandoffPacket } from '../models/handoff-packet.js';
import { extractContentBlocks } from './claude.js';

// Qoder uses the same JSONL session format as Claude Code (same content block
// structure, same tool_use/tool_result fields) stored at ~/.qoder/projects/<cwd>/.
// Token counts are not populated by Qoder's backend — we estimate from chars.
const CONTEXT_WINDOW = 200_000; // conservative; Qoder doesn't publish exact limits

// Same cwd-escaping rule as Claude Code.
function escapeCwd(cwd: string): string {
  return cwd.replace(/[/\\:]/g, '-');
}

function findLatestQoderSession(cwd: string, global = false): string | null {
  const projectsRoot = path.join(os.homedir(), '.qoder', 'projects');
  if (!fs.existsSync(projectsRoot)) return null;

  const dirs = global
    ? fs.readdirSync(projectsRoot)
        .map(d => path.join(projectsRoot, d))
        .filter(d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } })
    : [path.join(projectsRoot, escapeCwd(cwd))].filter(d => fs.existsSync(d));

  const allFiles: { file: string; mtime: number }[] = [];
  for (const dir of dirs) {
    try {
      for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'))) {
        const fp = path.join(dir, f);
        allFiles.push({ file: fp, mtime: fs.statSync(fp).mtimeMs });
      }
    } catch { /* skip unreadable dirs */ }
  }

  allFiles.sort((a, b) => b.mtime - a.mtime);
  return allFiles.length > 0 ? allFiles[0].file : null;
}

function parseQoderSession(filePath: string): {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  inputTokens: number;
} {
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  let chars = 0;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;

      // Skip metadata entries (isMeta flag or non-message types)
      if (entry.isMeta) continue;
      const type = entry.type as string;

      if (type === 'assistant') {
        const msg = entry.message as Record<string, unknown> ?? {};
        const text = extractContentBlocks(msg.content);
        if (text) {
          messages.push({ role: 'assistant', content: text });
          chars += text.length;
        }
      }

      if (type === 'user') {
        const msg = entry.message as Record<string, unknown> ?? {};
        const text = extractContentBlocks((msg.content as unknown) ?? (entry.message as unknown) ?? '');
        if (text) {
          messages.push({ role: 'user', content: text });
          chars += text.length;
        }
      }
    } catch { /* skip malformed lines */ }
  }

  // Qoder doesn't populate token counts — estimate from characters
  const inputTokens = Math.round(chars * 1.3);
  return { messages, inputTokens };
}

export class QodoAdapter implements IAgentAdapter {
  readonly id = 'qodercli';
  readonly commandName = 'qodercli';

  constructor(private readonly cwd = process.cwd()) {}

  getContextWindowSize(): number {
    return CONTEXT_WINDOW;
  }

  async isRunning(): Promise<boolean> {
    try {
      const output = execFileSync('ps', ['aux'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return output.split('\n').some(
        line => /\bqodercli\b/.test(line) && !line.includes('grep') && !line.includes('macc')
      );
    } catch {
      return false;
    }
  }

  async getUsageSnapshot(): Promise<UsageSnapshot> {
    const sessionFile = findLatestQoderSession(this.cwd, true);
    if (!sessionFile) {
      return { agentId: this.id, isRunning: false, contextUsedPercent: 0, inputTokensUsed: 0, contextWindowTokens: CONTEXT_WINDOW };
    }
    const { inputTokens } = parseQoderSession(sessionFile);
    const isRunning = await this.isRunning();
    return {
      agentId: this.id,
      isRunning,
      contextUsedPercent: (inputTokens / CONTEXT_WINDOW) * 100,
      inputTokensUsed: inputTokens,
      contextWindowTokens: CONTEXT_WINDOW,
    };
  }

  async extractSessionContext(): Promise<SessionContext | null> {
    const sessionFile = findLatestQoderSession(this.cwd, true);
    if (!sessionFile) return null;
    const { messages, inputTokens } = parseQoderSession(sessionFile);
    return { messages, cwd: this.cwd, inputTokensUsed: inputTokens, contextWindowTokens: CONTEXT_WINDOW };
  }

  buildLaunchArgs(packet: HandoffPacket): LaunchArgs {
    // qodercli "prompt" starts an interactive session with the prompt as the first message
    return { args: [packet.handoffPrompt] };
  }
}
