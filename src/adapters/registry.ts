import { hasCliTool } from '../auth/credentials.js';
import { ClaudeCodeAdapter } from './claude.js';
import { GeminiAdapter } from './gemini.js';
import { QodoAdapter } from './qodo.js';
import type { IAgentAdapter } from './base.js';

export function discoverAdapters(cwd = process.cwd()): IAgentAdapter[] {
  const adapters: IAgentAdapter[] = [];
  if (hasCliTool('claude')) adapters.push(new ClaudeCodeAdapter(cwd));
  if (hasCliTool('gemini')) adapters.push(new GeminiAdapter());
  if (hasCliTool('qoder')) adapters.push(new QodoAdapter());
  return adapters;
}
