import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { IAgentAdapter, SessionContext, UsageSnapshot, LaunchArgs } from './base.js';
import type { HandoffPacket } from '../models/handoff-packet.js';

// Qodo's session format is not yet publicly documented.
// This adapter uses file injection as a fallback: it writes the handoff prompt
// to ~/.macc/handoff-<hash>.md and passes it to `qoder` as an argument.
// When Qodo's session file format is reverse-engineered, update extractSessionContext().
const CONTEXT_WINDOW = 128_000; // conservative default

export class QodoAdapter implements IAgentAdapter {
  readonly id = 'qodo';
  readonly commandName = 'qoder';

  getContextWindowSize(): number {
    return CONTEXT_WINDOW;
  }

  async isRunning(): Promise<boolean> {
    try {
      const output = execFileSync('ps', ['aux'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return output.split('\n').some(line => /\bqoder\b/.test(line) && !line.includes('grep'));
    } catch {
      return false;
    }
  }

  async getUsageSnapshot(): Promise<UsageSnapshot> {
    // Qodo session file format is unknown — return a stub snapshot.
    const isRunning = await this.isRunning();
    return { agentId: this.id, isRunning, contextUsedPercent: 0, inputTokensUsed: 0, contextWindowTokens: CONTEXT_WINDOW };
  }

  async extractSessionContext(): Promise<SessionContext | null> {
    // Cannot read Qodo session files yet.
    return null;
  }

  buildLaunchArgs(packet: HandoffPacket): LaunchArgs {
    const maccDir = path.join(os.homedir(), '.macc');
    fs.mkdirSync(maccDir, { recursive: true });

    const hash = crypto.createHash('sha256')
      .update(packet.cwd + packet.createdAt)
      .digest('hex')
      .slice(0, 12);
    const filePath = path.join(maccDir, `handoff-${hash}.md`);

    fs.writeFileSync(filePath, packet.handoffPrompt, { mode: 0o600 });

    // Pass file path as argument; if qoder doesn't support it, the user will
    // see a message explaining where to find the handoff file.
    return { args: [filePath] };
  }
}
