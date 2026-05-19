import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { IAgentAdapter, SessionContext, UsageSnapshot, LaunchArgs } from './base.js';
import type { HandoffPacket } from '../models/handoff-packet.js';

const CONTEXT_WINDOW = 200_000;

// Claude Code escapes the project cwd by replacing path separators with '-'.
function escapeCwd(cwd: string): string {
  return cwd.replace(/[/\\:]/g, '-').replace(/^-+/, '');
}

function findLatestSessionFile(cwd: string): string | null {
  const projectDir = path.join(os.homedir(), '.claude', 'projects', escapeCwd(cwd));
  if (!fs.existsSync(projectDir)) return null;

  const files = fs.readdirSync(projectDir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(projectDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  return files.length > 0 ? path.join(projectDir, files[0].name) : null;
}

function parseSessionFile(filePath: string): { inputTokens: number; messages: Array<{ role: 'user' | 'assistant'; content: string }> } {
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  let inputTokens = 0;
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  // Find the last assistant entry and read its usage.input_tokens — that is
  // the cumulative token count for the full conversation (per AGENTS.md spec).
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.type === 'assistant' && entry.usage?.input_tokens != null && inputTokens === 0) {
        inputTokens = entry.usage.input_tokens;
      }
      if (entry.type === 'user' || entry.type === 'assistant') {
        const content = typeof entry.message === 'string'
          ? entry.message
          : entry.message?.content ?? entry.content ?? '';
        if (content) {
          messages.unshift({ role: entry.type as 'user' | 'assistant', content });
        }
      }
    } catch {
      // skip malformed lines
    }
  }

  return { inputTokens, messages };
}

export class ClaudeCodeAdapter implements IAgentAdapter {
  readonly id = 'claude-code';
  readonly commandName = 'claude';

  constructor(private readonly cwd = process.cwd()) {}

  getContextWindowSize(): number {
    return CONTEXT_WINDOW;
  }

  async isRunning(): Promise<boolean> {
    try {
      const output = execFileSync('ps', ['aux'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      if (!output.includes('claude')) return false;

      // On Linux/WSL2 confirm the process cwd matches
      const pidMatch = output.split('\n')
        .find(line => line.includes('claude') && !line.includes('grep'));
      if (!pidMatch) return false;

      const pidPart = pidMatch.trim().split(/\s+/)[1];
      if (!pidPart) return false;

      const procCwd = fs.readlinkSync(`/proc/${pidPart}/cwd`);
      return procCwd === this.cwd;
    } catch {
      return false;
    }
  }

  async getUsageSnapshot(): Promise<UsageSnapshot> {
    const sessionFile = findLatestSessionFile(this.cwd);
    if (!sessionFile) {
      return { agentId: this.id, isRunning: false, contextUsedPercent: 0, inputTokensUsed: 0, contextWindowTokens: CONTEXT_WINDOW };
    }

    const { inputTokens } = parseSessionFile(sessionFile);
    const isRunning = await this.isRunning();
    const contextUsedPercent = (inputTokens / CONTEXT_WINDOW) * 100;

    return { agentId: this.id, isRunning, contextUsedPercent, inputTokensUsed: inputTokens, contextWindowTokens: CONTEXT_WINDOW };
  }

  async extractSessionContext(): Promise<SessionContext | null> {
    const sessionFile = findLatestSessionFile(this.cwd);
    if (!sessionFile) return null;

    const { inputTokens, messages } = parseSessionFile(sessionFile);
    return { messages, cwd: this.cwd, inputTokensUsed: inputTokens, contextWindowTokens: CONTEXT_WINDOW };
  }

  buildLaunchArgs(packet: HandoffPacket): LaunchArgs {
    // Pass prompt as a positional arg: `claude "prompt"` starts an interactive
    // session with the handoff as the first message (unlike --print which exits).
    return { args: [packet.handoffPrompt] };
  }
}
