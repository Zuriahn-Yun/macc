import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { IAgentAdapter, SessionContext, UsageSnapshot, LaunchArgs } from './base.js';
import type { HandoffPacket } from '../models/handoff-packet.js';
import { extractContentBlocks } from './claude.js';
import { parseGeminiSession } from './gemini.js';

// ---------------------------------------------------------------------------
// Config schema
// ---------------------------------------------------------------------------

export type SessionFormat =
  | 'claude-compatible'   // JSONL with type/message/content blocks (Claude Code, Qoder, etc.)
  | 'gemini-compatible'   // Gemini CLI JSONL MessageRecord format
  | 'none';               // Cannot read sessions — handoff-to only

export interface CustomAgentConfig {
  id: string;
  displayName: string;
  commandName: string;
  contextWindow: number;
  sessionFormat: SessionFormat;
  /** Glob-style base dir for session files, ~ supported. Only used when sessionFormat !== 'none'. */
  sessionDir?: string;
  installCmd?: string;
}

// ---------------------------------------------------------------------------
// Persistent config storage at ~/.macc/agents.json
// ---------------------------------------------------------------------------

const MACC_DIR = path.join(os.homedir(), '.macc');
const AGENTS_CONFIG = path.join(MACC_DIR, 'agents.json');

export function loadCustomAgents(): CustomAgentConfig[] {
  try {
    if (!fs.existsSync(AGENTS_CONFIG)) return [];
    return JSON.parse(fs.readFileSync(AGENTS_CONFIG, 'utf8')) as CustomAgentConfig[];
  } catch {
    return [];
  }
}

export function saveCustomAgents(agents: CustomAgentConfig[]): void {
  fs.mkdirSync(MACC_DIR, { recursive: true });
  fs.writeFileSync(AGENTS_CONFIG, JSON.stringify(agents, null, 2));
}

export function addCustomAgent(agent: CustomAgentConfig): void {
  const existing = loadCustomAgents().filter(a => a.id !== agent.id);
  saveCustomAgents([...existing, agent]);
}

export function removeCustomAgent(id: string): boolean {
  const existing = loadCustomAgents();
  const next = existing.filter(a => a.id !== id);
  if (next.length === existing.length) return false;
  saveCustomAgents(next);
  return true;
}

// ---------------------------------------------------------------------------
// Generic adapter
// ---------------------------------------------------------------------------

function findLatestSessionFile(baseDir: string): string | null {
  const dir = baseDir.replace(/^~/, os.homedir());
  if (!fs.existsSync(dir)) return null;

  const allFiles: { file: string; mtime: number }[] = [];

  function scan(d: string, depth = 0): void {
    if (depth > 3) return;
    try {
      for (const entry of fs.readdirSync(d)) {
        const fp = path.join(d, entry);
        try {
          const stat = fs.statSync(fp);
          if (stat.isDirectory()) {
            scan(fp, depth + 1);
          } else if (entry.endsWith('.jsonl') || entry.endsWith('.json')) {
            allFiles.push({ file: fp, mtime: stat.mtimeMs });
          }
        } catch { /* skip */ }
      }
    } catch { /* skip unreadable */ }
  }

  scan(dir);
  allFiles.sort((a, b) => b.mtime - a.mtime);
  return allFiles.length > 0 ? allFiles[0].file : null;
}

function parseClaudeCompatible(filePath: string): {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  inputTokens: number;
  isEstimated: boolean;
} {
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  let inputTokens = 0;
  let chars = 0;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (entry.isMeta) continue;
      const type = entry.type as string;

      if (type === 'assistant') {
        const msg = entry.message as Record<string, unknown> ?? {};
        const usage = msg.usage as Record<string, number> ?? {};
        const total = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
        if (total > inputTokens) inputTokens = total;
        const text = extractContentBlocks(msg.content);
        if (text) { messages.push({ role: 'assistant', content: text }); chars += text.length; }
      }
      if (type === 'user') {
        const msg = entry.message as Record<string, unknown> ?? {};
        const text = extractContentBlocks((msg.content as unknown) ?? (entry.message as unknown) ?? '');
        if (text) { messages.push({ role: 'user', content: text }); chars += text.length; }
      }
    } catch { /* skip */ }
  }

  let isEstimated = false;
  if (inputTokens === 0) { inputTokens = Math.round(chars / 4); isEstimated = true; }
  return { messages, inputTokens, isEstimated };
}

export class GenericAgentAdapter implements IAgentAdapter {
  readonly id: string;
  readonly commandName: string;

  constructor(private readonly config: CustomAgentConfig, private readonly cwd = process.cwd()) {
    this.id = config.id;
    this.commandName = config.commandName;
  }

  getContextWindowSize(): number {
    return this.config.contextWindow;
  }

  async isRunning(): Promise<boolean> {
    try {
      // Escape regex metacharacters so commandName is matched literally,
      // then require it to appear as a whole word (space/slash before and after).
      const escaped = this.config.commandName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`(?:^|[\\s/])${escaped}(?:\\s|$)`);
      const ownPid = String(process.pid);
      const output = execFileSync('ps', ['aux'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return output.split('\n').some(line => {
        if (!pattern.test(line)) return false;
        if (line.includes('grep') || line.includes('macc')) return false;
        // ps aux: USER PID %CPU %MEM ... COMMAND — PID is column index 1
        const pid = line.trimStart().split(/\s+/)[1];
        if (pid === ownPid) return false;
        return true;
      });
    } catch {
      return false;
    }
  }

  private parseSession(sessionFile: string): { messages: Array<{ role: 'user' | 'assistant'; content: string }>; inputTokens: number; isEstimated: boolean } {
    if (this.config.sessionFormat === 'gemini-compatible') {
      const { messages, totalTokens, isEstimated } = parseGeminiSession(sessionFile);
      return { messages, inputTokens: totalTokens, isEstimated };
    }
    return parseClaudeCompatible(sessionFile);
  }

  async getUsageSnapshot(): Promise<UsageSnapshot> {
    const empty: UsageSnapshot = {
      agentId: this.id, isRunning: false, contextUsedPercent: 0,
      inputTokensUsed: 0, contextWindowTokens: this.config.contextWindow,
    };

    if (this.config.sessionFormat === 'none' || !this.config.sessionDir) {
      return { ...empty, isRunning: await this.isRunning() };
    }

    const sessionFile = findLatestSessionFile(this.config.sessionDir);
    if (!sessionFile) return { ...empty, isRunning: await this.isRunning() };

    const { inputTokens, isEstimated } = this.parseSession(sessionFile);
    const isRunning = await this.isRunning();
    return {
      agentId: this.id,
      isRunning,
      contextUsedPercent: (inputTokens / this.config.contextWindow) * 100,
      inputTokensUsed: inputTokens,
      contextWindowTokens: this.config.contextWindow,
      isEstimated,
    };
  }

  async extractSessionContext(): Promise<SessionContext | null> {
    if (this.config.sessionFormat === 'none' || !this.config.sessionDir) return null;

    const sessionFile = findLatestSessionFile(this.config.sessionDir);
    if (!sessionFile) return null;

    const { messages, inputTokens } = this.parseSession(sessionFile);
    return { messages, cwd: this.cwd, inputTokensUsed: inputTokens, contextWindowTokens: this.config.contextWindow };
  }

  buildNonInteractiveArgs(prompt: string): string[] {
    return ['--print', prompt];
  }

  buildLaunchArgs(packet: HandoffPacket): LaunchArgs {
    return { args: [packet.handoffPrompt] };
  }
}
