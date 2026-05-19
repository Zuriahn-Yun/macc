import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { IAgentAdapter, SessionContext, UsageSnapshot, LaunchArgs } from './base.js';
import type { HandoffPacket } from '../models/handoff-packet.js';

const CONTEXT_WINDOW = 200_000;

// Claude Code escapes the project cwd by replacing every path separator and
// colon with '-'. The leading '-' from the initial '/' is kept as-is.
// e.g. /mnt/c/Users/zuria/Projects/MACC → -mnt-c-Users-zuria-Projects-MACC
function escapeCwd(cwd: string): string {
  return cwd.replace(/[/\\:]/g, '-');
}

// Find the most recently modified JSONL across all Claude projects.
// When global=true (default for watch/start), ignores cwd and returns
// whichever session was touched most recently across all projects.
function findLatestSessionFile(cwd: string, global = false): string | null {
  const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(projectsRoot)) return null;

  const dirs = global
    ? fs.readdirSync(projectsRoot).map(d => path.join(projectsRoot, d)).filter(d => fs.statSync(d).isDirectory())
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

// Extract text from a Claude content block (handles 'text' and 'thinking' block types).
function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: { type?: string }) => b.type === 'text')
      .map((b: { text?: string }) => b.text ?? '')
      .join('');
  }
  return '';
}

function parseSessionFile(filePath: string): {
  inputTokens: number;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
} {
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  let inputTokens = 0;
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const type = entry.type as string;

      if (type === 'assistant') {
        const msg = entry.message ?? {};
        const usage = msg.usage ?? {};
        // Total context = regular input + cache-read + cache-creation tokens
        const total =
          (usage.input_tokens ?? 0) +
          (usage.cache_read_input_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0);
        if (total > inputTokens) inputTokens = total; // keep the highest seen (last turn)

        const text = extractText(msg.content);
        if (text) messages.push({ role: 'assistant', content: text });
      }

      if (type === 'user') {
        const text = extractText(entry.message?.content ?? entry.message ?? '');
        if (text) messages.push({ role: 'user', content: text });
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
      const claudeLines = output.split('\n').filter(
        line => /\bclaude\b/.test(line) && !line.includes('grep') && !line.includes('macc')
      );
      if (claudeLines.length === 0) return false;

      // On Linux/WSL2 confirm at least one claude process cwd matches
      for (const line of claudeLines) {
        const pid = line.trim().split(/\s+/)[1];
        if (!pid) continue;
        try {
          const procCwd = fs.readlinkSync(`/proc/${pid}/cwd`);
          if (procCwd === this.cwd) return true;
        } catch { /* pid may have exited */ }
      }
      // If /proc cwd check fails (non-Linux), fall back to trusting the process exists
      return claudeLines.length > 0;
    } catch {
      return false;
    }
  }

  async getUsageSnapshot(): Promise<UsageSnapshot> {
    // Global scan: always pick the most recently active session across all projects.
    const sessionFile = findLatestSessionFile(this.cwd, true);
    if (!sessionFile) {
      return { agentId: this.id, isRunning: false, contextUsedPercent: 0, inputTokensUsed: 0, contextWindowTokens: CONTEXT_WINDOW };
    }

    const { inputTokens } = parseSessionFile(sessionFile);
    const isRunning = await this.isRunning();
    const contextUsedPercent = (inputTokens / CONTEXT_WINDOW) * 100;

    return { agentId: this.id, isRunning, contextUsedPercent, inputTokensUsed: inputTokens, contextWindowTokens: CONTEXT_WINDOW };
  }

  async extractSessionContext(): Promise<SessionContext | null> {
    // Global scan: compress the most recently active session, regardless of cwd.
    const sessionFile = findLatestSessionFile(this.cwd, true);
    if (!sessionFile) return null;

    const { inputTokens, messages } = parseSessionFile(sessionFile);
    return { messages, cwd: this.cwd, inputTokensUsed: inputTokens, contextWindowTokens: CONTEXT_WINDOW };
  }

  buildLaunchArgs(packet: HandoffPacket): LaunchArgs {
    // `claude "prompt"` starts an interactive session with the prompt as the
    // first user message — the model sees it and begins working immediately.
    return { args: [packet.handoffPrompt] };
  }
}
