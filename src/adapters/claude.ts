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

// Injected into every Claude Code session so the model narrates its work.
// This makes the JSONL far more useful when the compressor reads it back.
export const VERBOSE_STATUS_PROMPT =
  'After completing each task or group of tool calls, append a brief status ' +
  'line to your response in this exact format:\n' +
  '[STATUS] files=<paths or none> cmds=<count> goal=<objective in ≤10 words>\n' +
  'This enables seamless handoff when the context window fills up.';

// Extract all meaningful content from a Claude content block array.
// Captures text, tool_use calls, and tool_result outputs — not just text blocks.
export function extractContentBlocks(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || !block) continue;
    const b = block as Record<string, unknown>;

    if (b.type === 'text' && typeof b.text === 'string') {
      if (b.text) parts.push(b.text);
    } else if (b.type === 'tool_use') {
      const name = String(b.name ?? 'unknown');
      const input = b.input ? JSON.stringify(b.input).slice(0, 400) : '';
      parts.push(`[Tool: ${name}(${input})]`);
    } else if (b.type === 'tool_result') {
      const raw = typeof b.content === 'string'
        ? b.content
        : JSON.stringify(b.content ?? '');
      const preview = raw.slice(0, 600);
      const suffix = raw.length > 600 ? '…' : '';
      const errFlag = b.is_error ? ' ERROR' : '';
      parts.push(`[Result${errFlag}: ${preview}${suffix}]`);
    }
    // skip 'thinking' blocks — not useful for compression
  }
  return parts.join('\n');
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

        const text = extractContentBlocks(msg.content);
        if (text) messages.push({ role: 'assistant', content: text });
      }

      if (type === 'user') {
        const text = extractContentBlocks(entry.message?.content ?? entry.message ?? '');
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

  async getActiveSessionId(): Promise<string | null> {
    // Must use global=false so the returned ID lives in the current project's
    // directory — `claude --resume <id>` only searches there, not globally.
    const file = findLatestSessionFile(this.cwd, false);
    return file ? path.basename(file, '.jsonl') : null;
  }

  buildBaseArgs(): string[] {
    return ['--append-system-prompt', VERBOSE_STATUS_PROMPT];
  }

  buildResumeArgs(sessionId: string): string[] {
    return ['--resume', sessionId, '--append-system-prompt', VERBOSE_STATUS_PROMPT];
  }

  buildNonInteractiveArgs(prompt: string): string[] {
    return ['--print', prompt];
  }

  buildLaunchArgs(packet: HandoffPacket): LaunchArgs {
    // `claude "prompt"` starts an interactive session with the prompt as the
    // first user message — the model sees it and begins working immediately.
    return { args: [packet.handoffPrompt] };
  }
}
