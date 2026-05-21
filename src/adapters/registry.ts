import { hasCliTool } from '../auth/credentials.js';
import { ClaudeCodeAdapter } from './claude.js';
import { GeminiAdapter } from './gemini.js';
import { QodoAdapter } from './qodo.js';
import type { IAgentAdapter } from './base.js';

export const ALL_AGENT_IDS = ['claude-code', 'gemini-cli', 'qodo'] as const;

export interface AgentInfo {
  adapter: IAgentAdapter;
  installed: boolean;
  installCmd: string;
}

export function discoverAdapters(cwd = process.cwd()): IAgentAdapter[] {
  const adapters: IAgentAdapter[] = [];
  if (hasCliTool('claude')) adapters.push(new ClaudeCodeAdapter(cwd));
  if (hasCliTool('gemini')) adapters.push(new GeminiAdapter());
  if (hasCliTool('qoder')) adapters.push(new QodoAdapter());
  return adapters;
}

// Returns all supported agents with install status and install instructions.
// Used by the start command and dashboard.
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
      adapter: new QodoAdapter(),
      installed: hasCliTool('qoder'),
      installCmd: 'npm install -g qodo-ai',
    },
  ];
}
