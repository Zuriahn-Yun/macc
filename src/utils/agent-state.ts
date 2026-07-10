import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MACC_DIR = path.join(os.homedir(), '.macc');
const PAUSES_FILE = path.join(MACC_DIR, 'pauses.json');

interface PauseRecord {
  agentId: string;
  since: string;       // ISO — when the limit was hit
  resetAt: string | null; // ISO — when the agent will be available again, null = unknown
  reason: 'usage-limit' | 'credits-exhausted';
}

function readPauses(): PauseRecord[] {
  try {
    if (!fs.existsSync(PAUSES_FILE)) return [];
    return JSON.parse(fs.readFileSync(PAUSES_FILE, 'utf8')) as PauseRecord[];
  } catch {
    return [];
  }
}

function writePauses(records: PauseRecord[]): void {
  try {
    fs.mkdirSync(MACC_DIR, { recursive: true });
    fs.writeFileSync(PAUSES_FILE, JSON.stringify(records, null, 2));
  } catch { /* non-fatal */ }
}

export function recordAgentPaused(
  agentId: string,
  reason: PauseRecord['reason'],
  resetAt: Date | null,
): void {
  const others = readPauses().filter(r => r.agentId !== agentId);
  writePauses([...others, {
    agentId,
    since: new Date().toISOString(),
    resetAt: resetAt ? resetAt.toISOString() : null,
    reason,
  }]);
}

export function clearAgentPause(agentId: string): void {
  writePauses(readPauses().filter(r => r.agentId !== agentId));
}

/** Returns agents from the given list that were paused but whose reset time has now passed. */
export function getJustRecoveredAgents(agentIds: string[]): Array<{ agentId: string; reason: PauseRecord['reason'] }> {
  const now = new Date();
  const pauses = readPauses();
  const recovered: Array<{ agentId: string; reason: PauseRecord['reason'] }> = [];

  for (const id of agentIds) {
    const record = pauses.find(r => r.agentId === id);
    if (!record) continue;
    if (record.resetAt === null) continue; // unknown reset time — can't auto-detect recovery
    if (new Date(record.resetAt) <= now) {
      recovered.push({ agentId: id, reason: record.reason });
    }
  }
  return recovered;
}

/** Returns the pause record for an agent, or null if not paused. */
export function getAgentPause(agentId: string): PauseRecord | null {
  return readPauses().find(r => r.agentId === agentId) ?? null;
}

/** Format the reset time for display, e.g. "in 23 min" or "at 8:00 AM". */
export function formatResetTime(resetAt: Date): string {
  const diffMs = resetAt.getTime() - Date.now();
  if (diffMs <= 0) return 'now';
  const mins = Math.ceil(diffMs / 60_000);
  if (mins < 60) return `in ${mins} min`;
  const hrs = Math.ceil(diffMs / 3_600_000);
  if (hrs < 24) return `in ${hrs}h`;
  return `at ${resetAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}
