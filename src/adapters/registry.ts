import { hasCliTool } from '../auth/credentials.js';
import { ClaudeCodeAdapter } from './claude.js';
import { GeminiAdapter } from './gemini.js';
import { QodoAdapter } from './qodo.js';
import { CodexAdapter } from './codex.js';
import type { IAgentAdapter } from './base.js';

export const ALL_AGENT_IDS = ['claude-code', 'gemini-cli', 'qodo', 'codex'] as const;

export interface AgentInfo {
  adapter: IAgentAdapter;
  installed: boolean;
  installCmd: string;
}

export function discoverAdapters(cwd = process.cwd()): IAgentAdapter[] {
  const adapters: IAgentAdapter[] = [];
  if (hasCliTool('claude')) adapters.push(new ClaudeCodeAdapter(cwd));
  if (hasCliTool('gemini')) adapters.push(new GeminiAdapter());
  if (hasCliTool('qodercli')) adapters.push(new QodoAdapter(cwd));
  if (hasCliTool('codex')) adapters.push(new CodexAdapter());
  return adapters;
}

// Returns all supported agents with install status and install instructions.
export function allAdapters(cwd = process.cwd()): AgentInfo[] {
  return [
    {
      adapter: new ClaudeCodeAdapter(cwd),
      installed: hasCliTool('claude'),
      installCmd: 'npm install -g @anthropic-ai/claude-code',
    },
    {
      adapter: new GeminiAdapter(),
      installed: hasCliTool('gemini'),
      installCmd: 'npm install -g @google/gemini-cli',
    },
    {
      adapter: new QodoAdapter(cwd),
      installed: hasCliTool('qodercli'),
      installCmd: 'npm install -g @qoder-ai/qodercli',
    },
    {
      adapter: new CodexAdapter(),
      installed: hasCliTool('codex'),
      installCmd: 'npm install -g @openai/codex',
    },
  ];
}
