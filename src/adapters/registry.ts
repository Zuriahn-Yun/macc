import { hasCliTool } from '../auth/credentials.js';
import { ClaudeCodeAdapter } from './claude.js';
import { GeminiAdapter } from './gemini.js';
import { QodoAdapter } from './qodo.js';
import { CodexAdapter } from './codex.js';
import type { IAgentAdapter } from './base.js';

export const ALL_AGENT_IDS = ['claude-code', 'gemini-cli', 'codex', 'qodo'] as const;

export function discoverAdapters(cwd = process.cwd()): IAgentAdapter[] {
  const adapters: IAgentAdapter[] = [];
  if (hasCliTool('claude')) adapters.push(new ClaudeCodeAdapter(cwd));
  if (hasCliTool('gemini')) adapters.push(new GeminiAdapter());
  if (hasCliTool('codex')) adapters.push(new CodexAdapter());
  if (hasCliTool('qoder')) adapters.push(new QodoAdapter());
  return adapters;
}

// Returns all four agents regardless of whether they're installed —
// used by the dashboard to show install status.
export function allAdapters(cwd = process.cwd()): Array<{ adapter: IAgentAdapter; installed: boolean }> {
  return [
    { adapter: new ClaudeCodeAdapter(cwd), installed: hasCliTool('claude') },
    { adapter: new GeminiAdapter(),         installed: hasCliTool('gemini') },
    { adapter: new CodexAdapter(),          installed: hasCliTool('codex') },
    { adapter: new QodoAdapter(),           installed: hasCliTool('qoder') },
  ];
}
