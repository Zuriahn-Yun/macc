import { cosmiconfig } from 'cosmiconfig';
import os from 'node:os';
import path from 'node:path';

export interface MaccConfig {
  defaultModel: string;
  warningThresholdPercent: number;
  autoPromptThresholdPercent: number;
  compressionModel: string;
  handoffOrder: string[];
}

const DEFAULTS: MaccConfig = {
  defaultModel: 'claude-sonnet-4-6',
  warningThresholdPercent: 90,
  autoPromptThresholdPercent: 98,
  compressionModel: 'claude-haiku-4-5-20251001',
  handoffOrder: ['gemini-2.5-pro', 'claude-sonnet-4-6', 'gpt-4o'],
};

export async function loadConfig(): Promise<MaccConfig> {
  const explorer = cosmiconfig('macc', {
    searchPlaces: [
      path.join(os.homedir(), '.macc', 'config.json'),
      'macc.config.json',
      '.maccrc',
    ],
  });

  const result = await explorer.search();
  if (!result) return DEFAULTS;

  return { ...DEFAULTS, ...result.config };
}
