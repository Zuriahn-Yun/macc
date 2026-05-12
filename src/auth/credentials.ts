import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export interface ClaudeCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface GcloudCredentials {
  accessToken: string;
  expiresAt: number;
}

// Reads and validates the Claude CLI OAuth token from ~/.claude/.credentials.json.
// Returns null if the file is missing, malformed, or the token has expired.
export function readClaudeCredentials(): ClaudeCredentials | null {
  const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
  if (!fs.existsSync(credPath)) return null;

  try {
    const raw = fs.readFileSync(credPath, 'utf8');
    const data = JSON.parse(raw);
    const creds = data?.claudeAiOauth as ClaudeCredentials | undefined;

    if (!creds?.accessToken || !creds?.expiresAt) return null;
    if (Date.now() >= creds.expiresAt) return null; // expired

    return creds;
  } catch {
    return null;
  }
}

// Reads a fresh Google OAuth access token via `gcloud auth application-default print-access-token`.
// Returns null if gcloud is not installed or no credentials are configured.
export function readGcloudAccessToken(): string | null {
  try {
    const token = execFileSync('gcloud', ['auth', 'application-default', 'print-access-token'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return token || null;
  } catch {
    return null;
  }
}

// Returns true if a given CLI tool is findable on PATH.
export function hasCliTool(name: string): boolean {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], {
      stdio: 'ignore',
      timeout: 2000,
    });
    return true;
  } catch {
    return false;
  }
}
