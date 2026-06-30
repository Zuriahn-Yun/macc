import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'macc-generic-test-'));
}

function writeJsonl(dir: string, filename: string, lines: unknown[]): string {
  const fp = path.join(dir, filename);
  fs.writeFileSync(fp, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return fp;
}

function makeConfig(overrides: Partial<import('./generic.js').CustomAgentConfig> = {}): import('./generic.js').CustomAgentConfig {
  return {
    id: 'my-agent',
    displayName: 'My Agent',
    commandName: 'myagent',
    contextWindow: 128_000,
    sessionFormat: 'claude-compatible',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// loadCustomAgents / saveCustomAgents / addCustomAgent / removeCustomAgent
// ---------------------------------------------------------------------------

describe('custom agent persistence', () => {
  let tmpDir: string;
  let homeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmpDir);
    vi.clearAllMocks();
  });

  it('loadCustomAgents returns [] when agents.json does not exist', async () => {
    const { loadCustomAgents } = await import('./generic.js');
    expect(loadCustomAgents()).toEqual([]);
  });

  it('saveCustomAgents and loadCustomAgents round-trip correctly', async () => {
    const { saveCustomAgents, loadCustomAgents } = await import('./generic.js');
    const agent = makeConfig();
    saveCustomAgents([agent]);
    expect(loadCustomAgents()).toEqual([agent]);
  });

  it('addCustomAgent creates file and appends agent', async () => {
    const { addCustomAgent, loadCustomAgents } = await import('./generic.js');
    addCustomAgent(makeConfig({ id: 'agent-a' }));
    addCustomAgent(makeConfig({ id: 'agent-b' }));
    const loaded = loadCustomAgents();
    expect(loaded.map(a => a.id)).toContain('agent-a');
    expect(loaded.map(a => a.id)).toContain('agent-b');
  });

  it('addCustomAgent replaces existing agent with same id', async () => {
    const { addCustomAgent, loadCustomAgents } = await import('./generic.js');
    addCustomAgent(makeConfig({ id: 'agent-a', displayName: 'Old Name' }));
    addCustomAgent(makeConfig({ id: 'agent-a', displayName: 'New Name' }));
    const loaded = loadCustomAgents();
    expect(loaded.filter(a => a.id === 'agent-a')).toHaveLength(1);
    expect(loaded.find(a => a.id === 'agent-a')?.displayName).toBe('New Name');
  });

  it('removeCustomAgent returns true and removes the agent', async () => {
    const { addCustomAgent, removeCustomAgent, loadCustomAgents } = await import('./generic.js');
    addCustomAgent(makeConfig({ id: 'agent-a' }));
    const removed = removeCustomAgent('agent-a');
    expect(removed).toBe(true);
    expect(loadCustomAgents().find(a => a.id === 'agent-a')).toBeUndefined();
  });

  it('removeCustomAgent returns false for unknown id', async () => {
    const { removeCustomAgent } = await import('./generic.js');
    expect(removeCustomAgent('does-not-exist')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GenericAgentAdapter — sessionFormat: 'none'
// ---------------------------------------------------------------------------

describe("GenericAgentAdapter sessionFormat: 'none'", () => {
  let tmpDir: string;
  let homeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmpDir);
    vi.clearAllMocks();
  });

  it('extractSessionContext returns null for none format', async () => {
    const { GenericAgentAdapter } = await import('./generic.js');
    const adapter = new GenericAgentAdapter(makeConfig({ sessionFormat: 'none' }));
    expect(await adapter.extractSessionContext()).toBeNull();
  });

  it('getUsageSnapshot returns 0% for none format', async () => {
    const cp = await import('node:child_process');
    vi.mocked(cp.execFileSync).mockReturnValue('no matching line\n' as never);

    const { GenericAgentAdapter } = await import('./generic.js');
    const adapter = new GenericAgentAdapter(makeConfig({ sessionFormat: 'none' }));
    const snap = await adapter.getUsageSnapshot();
    expect(snap.contextUsedPercent).toBe(0);
    expect(snap.inputTokensUsed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// GenericAgentAdapter — sessionFormat: 'claude-compatible'
// ---------------------------------------------------------------------------

describe("GenericAgentAdapter sessionFormat: 'claude-compatible'", () => {
  let tmpDir: string;
  let sessionDir: string;
  let homeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    sessionDir = path.join(tmpDir, 'sessions');
    fs.mkdirSync(sessionDir, { recursive: true });
    homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmpDir);
    vi.clearAllMocks();
  });

  const claudeLines = [
    { type: 'user', message: { content: [{ type: 'text', text: 'Fix auth' }] } },
    {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'Looking at auth.ts now.' }],
        usage: { input_tokens: 5000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    },
  ];

  it('extractSessionContext reads claude-compatible JSONL', async () => {
    writeJsonl(sessionDir, 'session.jsonl', claudeLines);

    const { GenericAgentAdapter } = await import('./generic.js');
    const adapter = new GenericAgentAdapter(
      makeConfig({ sessionFormat: 'claude-compatible', sessionDir }),
    );
    const ctx = await adapter.extractSessionContext();
    expect(ctx).not.toBeNull();
    expect(ctx!.messages.length).toBeGreaterThanOrEqual(1);
    expect(ctx!.messages.some(m => m.content.includes('Fix auth') || m.content.includes('auth.ts'))).toBe(true);
  });

  it('getUsageSnapshot reads token count from JSONL', async () => {
    const cp = await import('node:child_process');
    vi.mocked(cp.execFileSync).mockReturnValue('no-match\n' as never);
    writeJsonl(sessionDir, 'session.jsonl', claudeLines);

    const { GenericAgentAdapter } = await import('./generic.js');
    const adapter = new GenericAgentAdapter(
      makeConfig({ sessionFormat: 'claude-compatible', sessionDir }),
    );
    const snap = await adapter.getUsageSnapshot();
    expect(snap.inputTokensUsed).toBe(5000);
    expect(snap.contextUsedPercent).toBeCloseTo((5000 / 128_000) * 100, 1);
  });

  it('falls back to char estimation when no token usage in JSONL', async () => {
    const cp = await import('node:child_process');
    vi.mocked(cp.execFileSync).mockReturnValue('' as never);

    const linesNoUsage = [
      { type: 'user', message: { content: [{ type: 'text', text: 'A'.repeat(400) }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'B'.repeat(400) }] } },
    ];
    writeJsonl(sessionDir, 'session.jsonl', linesNoUsage);

    const { GenericAgentAdapter } = await import('./generic.js');
    const adapter = new GenericAgentAdapter(
      makeConfig({ sessionFormat: 'claude-compatible', sessionDir }),
    );
    const snap = await adapter.getUsageSnapshot();
    // 800 chars ÷ 4 = 200 estimated tokens
    expect(snap.inputTokensUsed).toBeGreaterThan(0);
    expect(snap.isEstimated).toBe(true);
  });

  it('skips malformed JSONL lines without throwing', async () => {
    const fp = path.join(sessionDir, 'session.jsonl');
    fs.writeFileSync(fp, 'not json\n{"type":"user","message":{"content":[{"type":"text","text":"hello"}]}}\n{ broken\n');

    const { GenericAgentAdapter } = await import('./generic.js');
    const adapter = new GenericAgentAdapter(
      makeConfig({ sessionFormat: 'claude-compatible', sessionDir }),
    );
    await expect(adapter.extractSessionContext()).resolves.not.toThrow();
  });

  it('returns null when sessionDir does not exist', async () => {
    const { GenericAgentAdapter } = await import('./generic.js');
    const adapter = new GenericAgentAdapter(
      makeConfig({ sessionFormat: 'claude-compatible', sessionDir: path.join(tmpDir, 'nonexistent') }),
    );
    expect(await adapter.extractSessionContext()).toBeNull();
  });

  it('picks most recently modified session file across subdirectories', async () => {
    const sub1 = path.join(sessionDir, 'project-a');
    const sub2 = path.join(sessionDir, 'project-b');
    fs.mkdirSync(sub1, { recursive: true });
    fs.mkdirSync(sub2, { recursive: true });

    writeJsonl(sub1, 'old.jsonl', [
      { type: 'user', message: { content: [{ type: 'text', text: 'Old session' }] } },
    ]);
    // small delay to ensure different mtime
    await new Promise(r => setTimeout(r, 10));
    writeJsonl(sub2, 'new.jsonl', [
      {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'New session content' }],
          usage: { input_tokens: 9999, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      },
    ]);

    const cp = await import('node:child_process');
    vi.mocked(cp.execFileSync).mockReturnValue('' as never);

    const { GenericAgentAdapter } = await import('./generic.js');
    const adapter = new GenericAgentAdapter(
      makeConfig({ sessionFormat: 'claude-compatible', sessionDir }),
    );
    const snap = await adapter.getUsageSnapshot();
    // Should read the newer file (9999 tokens)
    expect(snap.inputTokensUsed).toBe(9999);
  });
});

// ---------------------------------------------------------------------------
// GenericAgentAdapter — sessionFormat: 'gemini-compatible'
// ---------------------------------------------------------------------------

describe("GenericAgentAdapter sessionFormat: 'gemini-compatible'", () => {
  let tmpDir: string;
  let sessionDir: string;
  let homeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    sessionDir = path.join(tmpDir, 'gemini-sessions');
    fs.mkdirSync(sessionDir, { recursive: true });
    homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmpDir);
    vi.clearAllMocks();
  });

  it('extractSessionContext reads gemini-compatible JSONL', async () => {
    // Gemini CLI format uses type:'user' / type:'gemini', content is array of parts
    const geminiLines = [
      { type: 'user', content: [{ text: 'Help me refactor auth.ts' }] },
      { type: 'gemini', content: [{ text: 'Sure, here is a refactor plan.' }], tokens: { total: 1200 } },
    ];
    writeJsonl(sessionDir, 'session.jsonl', geminiLines);

    const { GenericAgentAdapter } = await import('./generic.js');
    const adapter = new GenericAgentAdapter(
      makeConfig({ sessionFormat: 'gemini-compatible', sessionDir }),
    );
    const ctx = await adapter.extractSessionContext();
    expect(ctx).not.toBeNull();
    expect(ctx!.messages.some(m => m.content.includes('refactor') || m.content.includes('auth'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GenericAgentAdapter — isRunning
// ---------------------------------------------------------------------------

describe('GenericAgentAdapter.isRunning()', () => {
  it('returns true when commandName appears in ps output', async () => {
    const cp = await import('node:child_process');
    vi.mocked(cp.execFileSync).mockReturnValue(
      'user  1234  0.0  myagent --flag\nuser  5678  0.0  node\n' as never
    );

    const { GenericAgentAdapter } = await import('./generic.js');
    const adapter = new GenericAgentAdapter(makeConfig({ commandName: 'myagent' }));
    expect(await adapter.isRunning()).toBe(true);
  });

  it('returns false when commandName does not appear in ps output', async () => {
    const cp = await import('node:child_process');
    vi.mocked(cp.execFileSync).mockReturnValue('user  1234  0.0  node\nuser  5678  0.0  bash\n' as never);

    const { GenericAgentAdapter } = await import('./generic.js');
    const adapter = new GenericAgentAdapter(makeConfig({ commandName: 'myagent' }));
    expect(await adapter.isRunning()).toBe(false);
  });

  it('returns false when ps command throws', async () => {
    const cp = await import('node:child_process');
    vi.mocked(cp.execFileSync).mockImplementation(() => { throw new Error('ps not found'); });

    const { GenericAgentAdapter } = await import('./generic.js');
    const adapter = new GenericAgentAdapter(makeConfig({ commandName: 'myagent' }));
    expect(await adapter.isRunning()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GenericAgentAdapter — buildNonInteractiveArgs
// ---------------------------------------------------------------------------

describe('GenericAgentAdapter.buildNonInteractiveArgs()', () => {
  it('defaults to --print <prompt>', async () => {
    const { GenericAgentAdapter } = await import('./generic.js');
    const adapter = new GenericAgentAdapter(makeConfig());
    expect(adapter.buildNonInteractiveArgs('do something')).toEqual(['--print', 'do something']);
  });
});
