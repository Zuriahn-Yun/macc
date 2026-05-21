/**
 * Comprehensive MACC test suite.
 *
 * Covers every major feature in a single file:
 *   1.  Session parsing   — Claude / Gemini / Qodo JSONL formats
 *   2.  Custom agents     — add / remove / list / GenericAgentAdapter
 *   3.  Agent identity    — IDs, commandNames, context window sizes
 *   4.  Resume support    — buildResumeArgs, getActiveSessionId
 *   5.  Compression       — AI-assisted, rate-limit raw fallback, provider ordering
 *   6.  Backend registry  — detectAvailableBackend / detectAllAvailableBackends
 *   7.  Orchestrator      — spawn lifecycle, session map, resume vs. handoff, exit
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IModelBackend, StreamChunk } from './backends/base.js';
import type { SessionContext, UsageSnapshot } from './adapters/base.js';

// ---------------------------------------------------------------------------
// Top-level mocks (hoisted before imports)
// ---------------------------------------------------------------------------

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  execFileSync: vi.fn().mockReturnValue(''), // no running processes by default
}));

// Capture the mock reference at module scope so tests can configure it.
const mockCreateInterface = vi.fn();
vi.mock('node:readline', () => ({
  default: { createInterface: mockCreateInterface },
}));

// Mock credentials so backend availability is driven purely by env vars in tests.
vi.mock('./auth/credentials.js', () => ({
  readClaudeCredentials: vi.fn().mockReturnValue(null),
  readGcloudAccessToken: vi.fn().mockReturnValue(null),
  hasCliTool: vi.fn().mockReturnValue(false),
}));

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let homeSpy: ReturnType<typeof vi.spyOn>;

function setupTmpHome() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'macc-suite-'));
  homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmpDir);
}

function teardownTmpHome() {
  homeSpy.mockRestore();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function writeJsonl(filePath: string, lines: object[]) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.map(l => JSON.stringify(l)).join('\n'));
}

/** A model backend that streams a pre-built JSON response. */
function mockBackend(jsonResponse: string, provider: IModelBackend['provider'] = 'anthropic'): IModelBackend {
  return {
    modelId: 'claude-sonnet-4-6',
    displayName: 'Claude Sonnet',
    contextWindowTokens: 200_000,
    provider,
    isAvailable: vi.fn().mockResolvedValue(true),
    stream: vi.fn().mockImplementation(async (_m: unknown, _s: unknown, onChunk: (c: StreamChunk) => void) => {
      onChunk({ text: jsonResponse, done: false });
      onChunk({ text: '', done: true, usage: { inputTokens: 100, outputTokens: 50 } });
      return { inputTokens: 100, outputTokens: 50 };
    }),
  };
}

/** A backend that always rejects with a rate-limit error. */
function rateLimitedBackend(provider: IModelBackend['provider'] = 'anthropic'): IModelBackend {
  return {
    modelId: 'rate-limited-model',
    displayName: 'Rate Limited',
    contextWindowTokens: 200_000,
    provider,
    isAvailable: vi.fn().mockResolvedValue(true),
    stream: vi.fn().mockRejectedValue(new Error('429 rate_limit_error')),
  };
}

const VALID_PACKET_JSON = JSON.stringify({
  version: '1',
  createdAt: new Date().toISOString(),
  fromModel: 'claude-sonnet-4-6',
  toModel: 'gemini-cli',
  cwd: '/project',
  summary: {
    ultimateGoal: 'Fix the auth middleware',
    completedWork: 'Reviewed the code',
    nextStep: 'Write the tests',
    keyDecisions: ['Use JWT'],
    blockers: [],
    filesModified: ['src/auth.ts'],
  },
  handoffPrompt: 'Continue fixing the auth middleware. Next: write tests.',
});

// ---------------------------------------------------------------------------
// 1. SESSION PARSING — Claude JSONL
// ---------------------------------------------------------------------------

describe('Session parsing — Claude JSONL', () => {
  beforeEach(setupTmpHome);
  afterEach(teardownTmpHome);

  function writeClaudeSession(lines: object[]) {
    const sessionDir = path.join(tmpDir, '.claude', 'projects', '-test-project');
    writeJsonl(path.join(sessionDir, 'abc123.jsonl'), lines);
  }

  it('extracts text messages from assistant turns', async () => {
    writeClaudeSession([
      { type: 'user', message: { content: 'Fix the login bug' } },
      {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Sure, looking at it now.' }],
          usage: { input_tokens: 5000, output_tokens: 20 },
        },
      },
    ]);
    const { ClaudeCodeAdapter } = await import('./adapters/claude.js');
    const ctx = await new ClaudeCodeAdapter('/test-project').extractSessionContext();
    expect(ctx).not.toBeNull();
    expect(ctx!.messages.some(m => m.content.includes('Fix the login bug'))).toBe(true);
    expect(ctx!.messages.some(m => m.content.includes('Sure, looking at it now.'))).toBe(true);
  });

  it('captures tool_use and tool_result in context', async () => {
    writeClaudeSession([
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Reading the file.' },
            { type: 'tool_use', id: 'toolu_01', name: 'Read', input: { file_path: '/src/auth.ts' } },
          ],
          usage: { input_tokens: 10000, output_tokens: 50 },
        },
      },
      {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_01', content: 'export function login() {}', is_error: false },
          ],
        },
      },
    ]);
    const { ClaudeCodeAdapter } = await import('./adapters/claude.js');
    const ctx = await new ClaudeCodeAdapter('/test-project').extractSessionContext();
    expect(ctx).not.toBeNull();
    const allContent = ctx!.messages.map(m => m.content).join('\n');
    expect(allContent).toContain('[Tool: Read(');
    expect(allContent).toContain('[Result: export function login()');
  });

  it('reads input token count from usage field', async () => {
    writeClaudeSession([
      { type: 'user', message: { content: 'hi' } },
      {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'hello' }],
          usage: { input_tokens: 50_000, output_tokens: 10 },
        },
      },
    ]);
    const { ClaudeCodeAdapter } = await import('./adapters/claude.js');
    const ctx = await new ClaudeCodeAdapter('/test-project').extractSessionContext();
    expect(ctx!.inputTokensUsed).toBe(50_000);
  });

  it('returns null when no session files exist', async () => {
    const { ClaudeCodeAdapter } = await import('./adapters/claude.js');
    const ctx = await new ClaudeCodeAdapter('/no-project-here').extractSessionContext();
    expect(ctx).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. SESSION PARSING — Gemini JSONL
// ---------------------------------------------------------------------------

describe('Session parsing — Gemini JSONL', () => {
  beforeEach(setupTmpHome);
  afterEach(teardownTmpHome);

  function writeGeminiSession(lines: object[]) {
    const chatsDir = path.join(tmpDir, '.gemini', 'tmp', 'hash123', 'chats');
    writeJsonl(path.join(chatsDir, 'session-001.jsonl'), lines);
  }

  it('parses user and gemini-type messages', async () => {
    writeGeminiSession([
      { type: 'user', content: [{ text: 'Can you help me fix auth?' }] },
      {
        type: 'gemini',
        content: [{ text: 'Sure, I will look at the auth module.' }],
        tokens: { input: 1000, output: 50, cached: 0, total: 1050 },
      },
    ]);
    const { GeminiAdapter } = await import('./adapters/gemini.js');
    const ctx = await new GeminiAdapter().extractSessionContext();
    expect(ctx).not.toBeNull();
    expect(ctx!.messages[0]).toEqual({ role: 'user', content: 'Can you help me fix auth?' });
    expect(ctx!.messages[1]).toEqual({ role: 'assistant', content: 'Sure, I will look at the auth module.' });
  });

  it('extracts functionCall and functionResponse parts', async () => {
    writeGeminiSession([
      {
        type: 'gemini',
        content: [
          { text: 'Reading the file.' },
          { functionCall: { name: 'read_file', args: { path: '/src/auth.ts' } } },
        ],
        tokens: { total: 2000 },
      },
      {
        type: 'user',
        content: [
          { functionResponse: { name: 'read_file', response: { content: 'export const login = () => {}' } } },
        ],
      },
    ]);
    const { GeminiAdapter } = await import('./adapters/gemini.js');
    const ctx = await new GeminiAdapter().extractSessionContext();
    const allContent = ctx!.messages.map(m => m.content).join('\n');
    expect(allContent).toContain('[Tool: read_file(');
    expect(allContent).toContain('[Result:');
  });

  it('uses tokens.total for usage when available', async () => {
    writeGeminiSession([
      { type: 'user', content: [{ text: 'hello' }] },
      { type: 'gemini', content: [{ text: 'hi' }], tokens: { total: 42_000 } },
    ]);
    const { GeminiAdapter } = await import('./adapters/gemini.js');
    const ctx = await new GeminiAdapter().extractSessionContext();
    expect(ctx!.inputTokensUsed).toBe(42_000);
  });

  it('falls back to char estimation when no token counts', async () => {
    const longText = 'a'.repeat(1000);
    writeGeminiSession([
      { type: 'user', content: [{ text: longText }] },
      { type: 'gemini', content: [{ text: 'ok' }] }, // no tokens field
    ]);
    const { GeminiAdapter } = await import('./adapters/gemini.js');
    const ctx = await new GeminiAdapter().extractSessionContext();
    // 1002 chars / 4 ≈ 250
    expect(ctx!.inputTokensUsed).toBeGreaterThan(100);
  });

  it('skips $set and $rewindTo metadata records', async () => {
    writeGeminiSession([
      { $set: { theme: 'dark' } },
      { $rewindTo: 'msg-002' },
      { type: 'user', content: [{ text: 'real message' }] },
    ]);
    const { GeminiAdapter } = await import('./adapters/gemini.js');
    const ctx = await new GeminiAdapter().extractSessionContext();
    expect(ctx!.messages).toHaveLength(1);
    expect(ctx!.messages[0].content).toBe('real message');
  });

  it('returns null when no Gemini session directory exists', async () => {
    const { GeminiAdapter } = await import('./adapters/gemini.js');
    const ctx = await new GeminiAdapter().extractSessionContext();
    expect(ctx).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. SESSION PARSING — Qodo JSONL
// ---------------------------------------------------------------------------

describe('Session parsing — Qodo JSONL', () => {
  beforeEach(setupTmpHome);
  afterEach(teardownTmpHome);

  function writeQoderSession(lines: object[]) {
    const sessionDir = path.join(tmpDir, '.qoder', 'projects', '-test-project');
    writeJsonl(path.join(sessionDir, 'session.jsonl'), lines);
  }

  it('parses Qodo JSONL using Claude-compatible format', async () => {
    writeQoderSession([
      { type: 'user', message: { content: 'Refactor the DB layer' } },
      {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'I will refactor the DB layer.' }],
        },
      },
    ]);
    const { QodoAdapter } = await import('./adapters/qodo.js');
    const ctx = await new QodoAdapter('/test-project').extractSessionContext();
    expect(ctx).not.toBeNull();
    expect(ctx!.messages.some(m => m.content.includes('Refactor the DB layer'))).toBe(true);
    expect(ctx!.messages.some(m => m.content.includes('I will refactor'))).toBe(true);
  });

  it('skips isMeta entries', async () => {
    writeQoderSession([
      { type: 'user', isMeta: true, message: { content: 'session-start metadata' } },
      { type: 'user', message: { content: 'real user message' } },
    ]);
    const { QodoAdapter } = await import('./adapters/qodo.js');
    const ctx = await new QodoAdapter('/test-project').extractSessionContext();
    expect(ctx!.messages).toHaveLength(1);
    expect(ctx!.messages[0].content).toBe('real user message');
  });

  it('uses char-based token estimation (no real token counts)', async () => {
    const text = 'x'.repeat(2000);
    writeQoderSession([
      { type: 'assistant', message: { content: [{ type: 'text', text }] } },
    ]);
    const { QodoAdapter } = await import('./adapters/qodo.js');
    const ctx = await new QodoAdapter('/test-project').extractSessionContext();
    // 2000 chars / 4 = 500
    expect(ctx!.inputTokensUsed).toBeGreaterThan(400);
  });
});

// ---------------------------------------------------------------------------
// 4. CUSTOM AGENT MANAGEMENT
// ---------------------------------------------------------------------------

describe('Custom agent management', () => {
  beforeEach(setupTmpHome);
  afterEach(teardownTmpHome);

  const AGENT_A = {
    id: 'aider',
    displayName: 'Aider',
    commandName: 'aider',
    contextWindow: 128_000,
    sessionFormat: 'none' as const,
  };

  const AGENT_B = {
    id: 'continue',
    displayName: 'Continue',
    commandName: 'continue',
    contextWindow: 64_000,
    sessionFormat: 'claude-compatible' as const,
    sessionDir: '~/.continue/sessions',
  };

  it('addCustomAgent persists an agent to disk', async () => {
    const { addCustomAgent, loadCustomAgents } = await import('./adapters/generic.js');
    addCustomAgent(AGENT_A);
    const agents = loadCustomAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0].id).toBe('aider');
    expect(agents[0].commandName).toBe('aider');
  });

  it('loadCustomAgents returns empty array when no config file exists', async () => {
    const { loadCustomAgents } = await import('./adapters/generic.js');
    expect(loadCustomAgents()).toEqual([]);
  });

  it('addCustomAgent replaces an existing agent with the same id', async () => {
    const { addCustomAgent, loadCustomAgents } = await import('./adapters/generic.js');
    addCustomAgent(AGENT_A);
    addCustomAgent({ ...AGENT_A, displayName: 'Aider v2', contextWindow: 256_000 });
    const agents = loadCustomAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0].displayName).toBe('Aider v2');
    expect(agents[0].contextWindow).toBe(256_000);
  });

  it('addCustomAgent and loadCustomAgents preserve multiple agents', async () => {
    const { addCustomAgent, loadCustomAgents } = await import('./adapters/generic.js');
    addCustomAgent(AGENT_A);
    addCustomAgent(AGENT_B);
    const agents = loadCustomAgents();
    expect(agents).toHaveLength(2);
    expect(agents.map(a => a.id)).toContain('aider');
    expect(agents.map(a => a.id)).toContain('continue');
  });

  it('removeCustomAgent removes by id and returns true', async () => {
    const { addCustomAgent, removeCustomAgent, loadCustomAgents } = await import('./adapters/generic.js');
    addCustomAgent(AGENT_A);
    addCustomAgent(AGENT_B);
    const removed = removeCustomAgent('aider');
    expect(removed).toBe(true);
    const remaining = loadCustomAgents();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe('continue');
  });

  it('removeCustomAgent returns false for unknown id', async () => {
    const { removeCustomAgent } = await import('./adapters/generic.js');
    expect(removeCustomAgent('nonexistent')).toBe(false);
  });

  it('GenericAgentAdapter returns null session for format=none', async () => {
    const { GenericAgentAdapter } = await import('./adapters/generic.js');
    const adapter = new GenericAgentAdapter(AGENT_A);
    const ctx = await adapter.extractSessionContext();
    expect(ctx).toBeNull();
  });

  it('GenericAgentAdapter reads claude-compatible JSONL from sessionDir', async () => {
    const sessionDir = path.join(tmpDir, 'sessions');
    fs.mkdirSync(sessionDir, { recursive: true });
    writeJsonl(path.join(sessionDir, 'session.jsonl'), [
      { type: 'user', message: { content: 'test message' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'test reply' }] } },
    ]);

    const { GenericAgentAdapter } = await import('./adapters/generic.js');
    const adapter = new GenericAgentAdapter({
      ...AGENT_B,
      sessionDir,
    });
    const ctx = await adapter.extractSessionContext();
    expect(ctx).not.toBeNull();
    expect(ctx!.messages.some(m => m.content.includes('test message'))).toBe(true);
    expect(ctx!.contextWindowTokens).toBe(64_000);
  });

  it('GenericAgentAdapter.buildLaunchArgs passes handoff prompt as positional arg', async () => {
    const { GenericAgentAdapter } = await import('./adapters/generic.js');
    const adapter = new GenericAgentAdapter(AGENT_A);
    const packet = JSON.parse(VALID_PACKET_JSON);
    const { args } = adapter.buildLaunchArgs(packet);
    expect(args[0]).toContain('auth middleware');
  });
});

// ---------------------------------------------------------------------------
// 4b. SESSION PARSING — Codex JSONL (rollout format)
// ---------------------------------------------------------------------------

describe('Session parsing — Codex rollout JSONL', () => {
  beforeEach(setupTmpHome);
  afterEach(teardownTmpHome);

  function writeCodexSession(lines: object[]) {
    const dir = path.join(tmpDir, '.codex', 'sessions', '2026', '05', '21');
    fs.mkdirSync(dir, { recursive: true });
    writeJsonl(path.join(dir, 'rollout-2026-05-21T10-00-00-abc123.jsonl'), lines);
  }

  it('parses user and assistant messages from rollout format', async () => {
    writeCodexSession([
      { type: 'event_msg', payload: { type: 'user_message', message: 'Fix the login bug', images: [], local_images: [], text_elements: [] } },
      { type: 'response_item', payload: { role: 'assistant', content: [{ type: 'output_text', text: 'Sure, looking at the bug now.' }] } },
    ]);
    const { CodexAdapter } = await import('./adapters/codex.js');
    const ctx = await new CodexAdapter().extractSessionContext();
    expect(ctx).not.toBeNull();
    expect(ctx!.messages[0]).toEqual({ role: 'user', content: 'Fix the login bug' });
    expect(ctx!.messages[1].content).toContain('looking at the bug');
  });

  it('reads context window size from model_context_window event', async () => {
    writeCodexSession([
      { type: 'event_msg', payload: { type: 'turn_start', turn_id: 'abc', model_context_window: 200_000 } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'hello', images: [], local_images: [], text_elements: [] } },
      { type: 'response_item', payload: { role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] } },
    ]);
    const { CodexAdapter } = await import('./adapters/codex.js');
    const ctx = await new CodexAdapter().extractSessionContext();
    expect(ctx!.contextWindowTokens).toBe(200_000);
  });

  it('reads usage percent from rate_limits payload', async () => {
    writeCodexSession([
      { type: 'event_msg', payload: { type: 'user_message', message: 'hello', images: [], local_images: [], text_elements: [] } },
      { type: 'event_msg', payload: { rate_limits: { primary: { used_percent: 42, window_minutes: 10080 } } } },
      { type: 'response_item', payload: { role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] } },
    ]);
    const { CodexAdapter } = await import('./adapters/codex.js');
    const snap = await new CodexAdapter().getUsageSnapshot();
    expect(snap.contextUsedPercent).toBe(42);
  });

  it('returns null when no session files exist', async () => {
    const { CodexAdapter } = await import('./adapters/codex.js');
    const ctx = await new CodexAdapter().extractSessionContext();
    expect(ctx).toBeNull();
  });

  it('skips non-message event types (session_meta, turn_context, etc.)', async () => {
    writeCodexSession([
      { type: 'session_meta', payload: { id: 'abc', cwd: '/project' } },
      { type: 'turn_context', payload: { turn_id: 'abc', cwd: '/project' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'real message', images: [], local_images: [], text_elements: [] } },
    ]);
    const { CodexAdapter } = await import('./adapters/codex.js');
    const ctx = await new CodexAdapter().extractSessionContext();
    expect(ctx!.messages).toHaveLength(1);
    expect(ctx!.messages[0].content).toBe('real message');
  });
});

// ---------------------------------------------------------------------------
// 5. AGENT IDENTITY AND LAUNCH ARGS
// ---------------------------------------------------------------------------

describe('Agent identity and launch args', () => {
  const EXPECTED = [
    { module: './adapters/claude.js', cls: 'ClaudeCodeAdapter', id: 'claude-code', cmd: 'claude', ctx: 200_000, args: ['/project'] },
    { module: './adapters/gemini.js', cls: 'GeminiAdapter',     id: 'gemini-cli',  cmd: 'gemini', ctx: 1_048_576, args: [] },
    { module: './adapters/qodo.js',   cls: 'QodoAdapter',       id: 'qodercli',   cmd: 'qodercli', ctx: 200_000, args: ['/project'] },
    { module: './adapters/codex.js',  cls: 'CodexAdapter',      id: 'codex',      cmd: 'codex', ctx: 128_000, args: [] },
  ] as const;

  for (const { module, cls, id, cmd, ctx, args } of EXPECTED) {
    it(`${id}: correct id, commandName, contextWindowSize`, async () => {
      const mod = await import(module) as Record<string, new (...a: string[]) => { id: string; commandName: string; getContextWindowSize(): number }>;
      const adapter = new mod[cls](...args);
      expect(adapter.id).toBe(id);
      expect(adapter.commandName).toBe(cmd);
      expect(adapter.getContextWindowSize()).toBe(ctx);
    });

    it(`${id}: buildLaunchArgs passes handoffPrompt as positional arg`, async () => {
      const mod = await import(module) as Record<string, new (...a: string[]) => { buildLaunchArgs(p: unknown): { args: string[] } }>;
      const adapter = new mod[cls](...args);
      const packet = JSON.parse(VALID_PACKET_JSON);
      const { args: launchArgs } = adapter.buildLaunchArgs(packet);
      expect(launchArgs[0]).toContain('auth middleware');
      expect(launchArgs).not.toContain('--print');
    });
  }
});

// ---------------------------------------------------------------------------
// 6. RESUME SUPPORT
// ---------------------------------------------------------------------------

describe('Resume support', () => {
  beforeEach(setupTmpHome);
  afterEach(teardownTmpHome);

  it('buildResumeArgs returns [--resume, sessionId, --append-system-prompt, ...]', async () => {
    const { ClaudeCodeAdapter } = await import('./adapters/claude.js');
    const adapter = new ClaudeCodeAdapter('/project');
    const args = adapter.buildResumeArgs('abc123');
    expect(args[0]).toBe('--resume');
    expect(args[1]).toBe('abc123');
    expect(args).toContain('--append-system-prompt');
  });

  it('buildResumeArgs includes the verbose status prompt', async () => {
    const { ClaudeCodeAdapter, VERBOSE_STATUS_PROMPT } = await import('./adapters/claude.js');
    const adapter = new ClaudeCodeAdapter('/project');
    const args = adapter.buildResumeArgs('sess-xyz');
    expect(args).toContain(VERBOSE_STATUS_PROMPT);
  });

  it('getActiveSessionId returns the JSONL basename without extension', async () => {
    const sessionDir = path.join(tmpDir, '.claude', 'projects', '-test');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'mysession42.jsonl'), '');

    const { ClaudeCodeAdapter } = await import('./adapters/claude.js');
    const id = await new ClaudeCodeAdapter('/test').getActiveSessionId();
    expect(id).toBe('mysession42');
  });

  it('getActiveSessionId returns null when no session files exist', async () => {
    const { ClaudeCodeAdapter } = await import('./adapters/claude.js');
    const id = await new ClaudeCodeAdapter('/no-sessions').getActiveSessionId();
    expect(id).toBeNull();
  });

  it('getActiveSessionId picks the most recently modified session', async () => {
    const sessionDir = path.join(tmpDir, '.claude', 'projects', '-proj');
    fs.mkdirSync(sessionDir, { recursive: true });

    const older = path.join(sessionDir, 'older-session.jsonl');
    const newer = path.join(sessionDir, 'newer-session.jsonl');
    fs.writeFileSync(older, '');
    // Force newer mtime
    await new Promise(r => setTimeout(r, 10));
    fs.writeFileSync(newer, '');

    const { ClaudeCodeAdapter } = await import('./adapters/claude.js');
    const id = await new ClaudeCodeAdapter('/proj').getActiveSessionId();
    expect(id).toBe('newer-session');
  });
});

// ---------------------------------------------------------------------------
// 7. COMPRESSION PIPELINE
// ---------------------------------------------------------------------------

describe('Compression pipeline', () => {
  async function makeStore(messages: { role: 'user' | 'assistant'; content: string }[]) {
    const { ContextStore } = await import('./core/context-store.js');
    const store = new ContextStore('claude-sonnet-4-6', 200_000, 90, 98, 'system');
    for (const m of messages) {
      if (m.role === 'user') store.addUserMessage(m.content);
      else store.addAssistantMessage(m.content, { inputTokens: 1000, outputTokens: 50 });
    }
    return store;
  }

  it('AI-assisted compression produces a valid HandoffPacket', async () => {
    const { compressWithFallback } = await import('./core/compressor.js');
    const store = await makeStore([
      { role: 'user', content: 'Fix the auth middleware' },
      { role: 'assistant', content: 'Reviewing the code now.' },
    ]);
    const backend = mockBackend(VALID_PACKET_JSON);
    const packet = await compressWithFallback([backend], store, 'gemini-cli', '/project');

    expect(packet.version).toBe('1');
    expect(packet.summary.ultimateGoal).toBe('Fix the auth middleware');
    expect(packet.handoffPrompt).toContain('auth middleware');
    expect(packet.toModel).toBe('gemini-cli');
  });

  it('rate-limit on all backends produces a raw fallback packet', async () => {
    const { compressWithFallback } = await import('./core/compressor.js');
    const store = await makeStore([
      { role: 'user', content: 'Add a caching layer to the API' },
      { role: 'assistant', content: 'Sure, I will add Redis caching.' },
    ]);
    const b1 = rateLimitedBackend('anthropic');
    const b2 = rateLimitedBackend('google');

    const packet = await compressWithFallback([b1, b2], store, 'gemini-cli', '/project');
    expect(packet.version).toBe('1');
    // Raw fallback must include recent message content so receiving agent has context
    expect(packet.handoffPrompt).toContain('Add a caching layer');
    expect(packet.summary.blockers[0]).toMatch(/rate-limited/i);
  });

  it('raw fallback includes the most recent messages', async () => {
    const { compressWithFallback } = await import('./core/compressor.js');
    const messages: { role: 'user' | 'assistant'; content: string }[] = [];
    for (let i = 1; i <= 20; i++) {
      messages.push({ role: 'user', content: `user message ${i}` });
      messages.push({ role: 'assistant', content: `assistant reply ${i}` });
    }
    const store = await makeStore(messages);
    const packet = await compressWithFallback([rateLimitedBackend()], store, 'gemini-cli', '/project');
    // Should contain recent messages, not just the first ones
    expect(packet.handoffPrompt).toContain('user message 20');
  });

  it('non-rate-limit error falls back to next backend', async () => {
    const { compressWithFallback } = await import('./core/compressor.js');
    const store = await makeStore([{ role: 'user', content: 'hi' }]);

    const broken: IModelBackend = { ...mockBackend(''), stream: vi.fn().mockRejectedValue(new Error('Invalid API key')) };
    const backup = mockBackend(VALID_PACKET_JSON);

    const packet = await compressWithFallback([broken, backup], store, 'gemini-cli', '/project');
    expect(packet.summary.ultimateGoal).toBe('Fix the auth middleware');
    expect(backup.stream).toHaveBeenCalled();
  });

  it('source-provider backends are deprioritised', async () => {
    const { compressWithFallback } = await import('./core/compressor.js');
    const store = await makeStore([{ role: 'user', content: 'hello' }]);

    const callOrder: string[] = [];
    const anthropic = { ...mockBackend(VALID_PACKET_JSON, 'anthropic'), stream: vi.fn().mockImplementation(async (_m: unknown, _s: unknown, onChunk: (c: StreamChunk) => void) => { callOrder.push('anthropic'); onChunk({ text: VALID_PACKET_JSON, done: false }); onChunk({ text: '', done: true, usage: { inputTokens: 10, outputTokens: 5 } }); return { inputTokens: 10, outputTokens: 5 }; }) };
    const google   = { ...mockBackend(VALID_PACKET_JSON, 'google'),    stream: vi.fn().mockImplementation(async (_m: unknown, _s: unknown, onChunk: (c: StreamChunk) => void) => { callOrder.push('google');    onChunk({ text: VALID_PACKET_JSON, done: false }); onChunk({ text: '', done: true, usage: { inputTokens: 10, outputTokens: 5 } }); return { inputTokens: 10, outputTokens: 5 }; }) };

    // Pass anthropic first in array, but source is 'anthropic' → google should go first
    await compressWithFallback([anthropic, google], store, 'gemini-cli', '/project', 'anthropic');
    expect(callOrder[0]).toBe('google');
    expect(anthropic.stream).not.toHaveBeenCalled();
  });

  it('throws when no backends provided', async () => {
    const { compressWithFallback } = await import('./core/compressor.js');
    const store = await makeStore([{ role: 'user', content: 'hi' }]);
    await expect(compressWithFallback([], store, 'gemini-cli', '/project'))
      .rejects.toThrow('No AI backends available');
  });
});

// ---------------------------------------------------------------------------
// 8. BACKEND REGISTRY
// ---------------------------------------------------------------------------

describe('Backend registry', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore env vars
    for (const key of ['ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'OPENAI_API_KEY']) {
      if (originalEnv[key] !== undefined) process.env[key] = originalEnv[key];
      else delete process.env[key];
    }
  });

  it('detectAvailableBackend returns null when no API keys are set', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.OPENAI_API_KEY;

    // Re-import to pick up cleared env
    const { detectAvailableBackend } = await import('./backends/registry.js');
    const backend = await detectAvailableBackend();
    expect(backend).toBeNull();
  });

  it('detectAvailableBackend returns a backend when ANTHROPIC_API_KEY is set', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-key';
    const { detectAvailableBackend } = await import('./backends/registry.js');
    const backend = await detectAvailableBackend();
    expect(backend).not.toBeNull();
    expect(backend!.provider).toBe('anthropic');
  });

  it('detectAllAvailableBackends returns all backends with credentials', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-key';
    process.env.GOOGLE_API_KEY = 'aig-test-key';
    const { detectAllAvailableBackends } = await import('./backends/registry.js');
    const backends = await detectAllAvailableBackends();
    expect(backends.length).toBeGreaterThanOrEqual(2);
    const providers = backends.map(b => b.provider);
    expect(providers).toContain('anthropic');
    expect(providers).toContain('google');
  });

  it('detectAllAvailableBackends returns empty array with no credentials', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const { detectAllAvailableBackends } = await import('./backends/registry.js');
    const backends = await detectAllAvailableBackends();
    expect(backends).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 9. ORCHESTRATOR — agent lifecycle
// ---------------------------------------------------------------------------

describe('Orchestrator — agent lifecycle', () => {
  function makeAdapter(id: string, pct = 50, sessionId?: string) {
    return {
      id,
      commandName: id,
      getContextWindowSize: () => 200_000,
      isRunning: vi.fn().mockResolvedValue(false),
      getUsageSnapshot: vi.fn().mockResolvedValue({
        agentId: id, isRunning: false,
        contextUsedPercent: pct,
        inputTokensUsed: Math.round(pct / 100 * 200_000),
        contextWindowTokens: 200_000,
      } satisfies UsageSnapshot),
      extractSessionContext: vi.fn().mockResolvedValue({
        messages: [{ role: 'user' as const, content: 'test task' }],
        cwd: '/project', inputTokensUsed: 100_000, contextWindowTokens: 200_000,
      } satisfies SessionContext),
      buildLaunchArgs: vi.fn().mockReturnValue({ args: ['handoff prompt'] }),
      buildBaseArgs: vi.fn().mockReturnValue([]),
      buildResumeArgs: sessionId
        ? vi.fn().mockReturnValue(['--resume', sessionId])
        : undefined,
      getActiveSessionId: vi.fn().mockResolvedValue(sessionId ?? null),
    };
  }

  function makeChild(exitCode = 0) {
    return {
      on: vi.fn((_: string, cb: (code: number) => void) => cb(exitCode)),
      kill: vi.fn(),
    };
  }

  function mockRl(answer: string) {
    mockCreateInterface.mockReturnValue({
      question: vi.fn((_: string, cb: (a: string) => void) => cb(answer)),
      close: vi.fn(),
    });
  }

  async function setupOrchestrator(answer: string) {
    const cp = await import('node:child_process');
    vi.mocked(cp.spawn).mockReturnValue(makeChild() as unknown as ReturnType<typeof cp.spawn>);
    mockRl(answer);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  }

  beforeEach(() => vi.clearAllMocks());

  afterEach(() => vi.restoreAllMocks());

  it('exits cleanly when user selects [0]', async () => {
    await setupOrchestrator('0');
    const { runWithRotation } = await import('./core/orchestrator.js');
    const agent = makeAdapter('claude-code', 50);
    const target = makeAdapter('gemini-cli', 0);
    const backend = mockBackend(VALID_PACKET_JSON);

    await expect(runWithRotation(agent as never, [target as never], [backend])).resolves.toBeUndefined();
    // No compression should have happened
    expect(backend.stream).not.toHaveBeenCalled();
  });

  it('compresses and starts target when user picks [1]', async () => {
    await setupOrchestrator('1');
    const cp = await import('node:child_process');

    const { runWithRotation } = await import('./core/orchestrator.js');
    const agent = makeAdapter('claude-code', 92);
    const target = makeAdapter('gemini-cli', 0);
    const backend = mockBackend(VALID_PACKET_JSON);

    // The second agent launch will also prompt — answer 0 to exit
    let rlCallCount = 0;
    mockCreateInterface.mockImplementation(() => {
      rlCallCount++;
      const answer = rlCallCount === 1 ? '1' : '0'; // first pick target, then exit
      return { question: vi.fn((_: string, cb: (a: string) => void) => cb(answer)), close: vi.fn() };
    });

    await runWithRotation(agent as never, [target as never], [backend]);

    expect(backend.stream).toHaveBeenCalledTimes(1); // compression happened once
    expect(cp.spawn).toHaveBeenCalledTimes(2); // source agent + target agent
  });

  it('uses resume args instead of compressing when returning to a previous agent', async () => {
    await setupOrchestrator('2'); // pick option 2 = the source agent (go back)

    const { runWithRotation } = await import('./core/orchestrator.js');

    const sessionMap = new Map([['claude-code', 'session-abc']]);
    const claudeAgent = makeAdapter('claude-code', 50, 'session-abc');
    const geminiAgent = makeAdapter('gemini-cli', 30);
    const backend = mockBackend(VALID_PACKET_JSON);

    // Answer 0 on the second prompt (after resuming claude-code)
    // Menu order: [0] Exit, [1] claude-code (resume), [2] gemini-cli
    // Pick [1] to resume claude-code, then [0] to exit after re-entering it.
    let rlCallCount2 = 0;
    mockCreateInterface.mockImplementation(() => {
      rlCallCount2++;
      const answer = rlCallCount2 === 1 ? '1' : '0';
      return { question: vi.fn((_: string, cb: (a: string) => void) => cb(answer)), close: vi.fn() };
    });

    await runWithRotation(geminiAgent as never, [claudeAgent as never], [backend], undefined, undefined, sessionMap);

    // When going back via resume, no compression should occur
    expect(backend.stream).not.toHaveBeenCalled();
    // Claude Code should have been launched with resume args
    const cp = await import('node:child_process');
    const spawnArgs = vi.mocked(cp.spawn).mock.calls;
    const claudeSpawnArgs = spawnArgs.find(call => call[0] === 'claude-code');
    expect(claudeSpawnArgs?.[1]).toContain('--resume');
    expect(claudeSpawnArgs?.[1]).toContain('session-abc');
  });

  it('raw rate-limit fallback is used when all backends are rate-limited', async () => {
    await setupOrchestrator('1');

    const { runWithRotation } = await import('./core/orchestrator.js');
    const agent = makeAdapter('claude-code', 95);
    const target = makeAdapter('gemini-cli', 0);
    const b1 = rateLimitedBackend('anthropic');
    const b2 = rateLimitedBackend('google');

    let rlCallCount3 = 0;
    mockCreateInterface.mockImplementation(() => {
      rlCallCount3++;
      const answer = rlCallCount3 === 1 ? '1' : '0';
      return { question: vi.fn((_: string, cb: (a: string) => void) => cb(answer)), close: vi.fn() };
    });

    // Should not throw — raw fallback keeps the flow going
    await expect(runWithRotation(agent as never, [target as never], [b1, b2])).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 8. collectGitState
// ---------------------------------------------------------------------------

describe('collectGitState', () => {
  it('returns null when git is not installed', async () => {
    const cp = await import('node:child_process');
    vi.mocked(cp.execFileSync).mockImplementation(() => { throw new Error('not found'); });

    const { collectGitState } = await import('./core/orchestrator.js');
    expect(collectGitState('/some/path')).toBeNull();
  });

  it('returns null when repo has no changes or commits', async () => {
    const cp = await import('node:child_process');
    vi.mocked(cp.execFileSync).mockReturnValue('');

    const { collectGitState } = await import('./core/orchestrator.js');
    expect(collectGitState('/some/path')).toBeNull();
  });

  it('returns formatted string with status, diff, and log sections', async () => {
    const cp = await import('node:child_process');
    vi.mocked(cp.execFileSync).mockImplementation((_cmd, args) => {
      const a = args as string[];
      if (a[0] === 'status') return ' M src/auth.ts\n?? src/new.ts';
      if (a[0] === 'diff') return ' src/auth.ts | 12 +++---\n 1 file changed';
      if (a[0] === 'log') return 'abc1234 Fix login bug\ndef5678 Add tests';
      return '';
    });

    const { collectGitState } = await import('./core/orchestrator.js');
    const result = collectGitState('/project');

    expect(result).toContain('[GIT STATE]');
    expect(result).toContain('src/auth.ts');
    expect(result).toContain('Fix login bug');
    expect(result).toContain('Diff vs HEAD');
  });

  it('includes only non-empty sections', async () => {
    const cp = await import('node:child_process');
    vi.mocked(cp.execFileSync).mockImplementation((_cmd, args) => {
      const a = args as string[];
      if (a[0] === 'log') return 'abc1234 Initial commit';
      return ''; // status and diff are empty
    });

    const { collectGitState } = await import('./core/orchestrator.js');
    const result = collectGitState('/project');

    expect(result).toContain('Recent commits');
    expect(result).not.toContain('Uncommitted changes');
    expect(result).not.toContain('Diff vs HEAD');
  });
});

// ---------------------------------------------------------------------------
// 9. printHandoffSummary
// ---------------------------------------------------------------------------

describe('printHandoffSummary', () => {
  it('renders all summary fields to stdout', async () => {
    const { printHandoffSummary } = await import('./utils/display.js');
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => lines.push(args.join(' ')));

    printHandoffSummary({
      ultimateGoal: 'Build the auth system',
      completedWork: 'Wrote login endpoint',
      nextStep: 'Add JWT signing',
      filesModified: ['src/auth.ts', 'src/jwt.ts'],
      blockers: ['Missing secret key config'],
    });

    spy.mockRestore();

    const out = lines.join('\n');
    expect(out).toContain('Build the auth system');
    expect(out).toContain('Wrote login endpoint');
    expect(out).toContain('Add JWT signing');
    expect(out).toContain('src/auth.ts');
    expect(out).toContain('Missing secret key config');
  });

  it('omits files and blockers rows when arrays are empty', async () => {
    const { printHandoffSummary } = await import('./utils/display.js');
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => lines.push(args.join(' ')));

    printHandoffSummary({
      ultimateGoal: 'Refactor the DB layer',
      completedWork: 'Extracted queries',
      nextStep: 'Run migrations',
      filesModified: [],
      blockers: [],
    });

    spy.mockRestore();

    const out = lines.join('\n');
    expect(out).toContain('Refactor the DB layer');
    expect(out).not.toContain('Files:');
    expect(out).not.toContain('Blockers:');
  });
});

// ---------------------------------------------------------------------------
// 10. GenericAgentAdapter — gemini-compatible session format
// ---------------------------------------------------------------------------

describe('GenericAgentAdapter — gemini-compatible session format', () => {
  beforeEach(setupTmpHome);
  afterEach(teardownTmpHome);

  it('parses Gemini-format JSONL when sessionFormat is gemini-compatible', async () => {
    const sessionDir = path.join(tmpDir, '.myagent', 'sessions');
    fs.mkdirSync(sessionDir, { recursive: true });
    const sessionFile = path.join(sessionDir, 'session-001.jsonl');

    writeJsonl(sessionFile, [
      { type: 'user', content: [{ text: 'Write a fibonacci function' }] },
      { type: 'gemini', content: [{ text: 'Here is the fibonacci function:' }], tokens: { total: 5000, input: 4000, output: 1000, cached: 0 } },
      { type: 'user', content: [{ text: 'Make it iterative' }] },
      { type: 'gemini', content: [{ text: 'Here is the iterative version:' }], tokens: { total: 8000, input: 6000, output: 2000, cached: 0 } },
    ]);

    const { GenericAgentAdapter } = await import('./adapters/generic.js');
    const adapter = new GenericAgentAdapter({
      id: 'my-agent',
      displayName: 'My Agent',
      commandName: 'myagent',
      contextWindow: 100_000,
      sessionFormat: 'gemini-compatible',
      sessionDir,
    });

    const ctx = await adapter.extractSessionContext();
    expect(ctx).not.toBeNull();
    expect(ctx!.messages).toHaveLength(4);
    expect(ctx!.messages[0]).toEqual({ role: 'user', content: 'Write a fibonacci function' });
    expect(ctx!.messages[1]).toEqual({ role: 'assistant', content: 'Here is the fibonacci function:' });
    expect(ctx!.inputTokensUsed).toBe(8000); // max total seen
  });

  it('getUsageSnapshot uses gemini token counts for gemini-compatible format', async () => {
    const sessionDir = path.join(tmpDir, '.myagent', 'sessions');
    fs.mkdirSync(sessionDir, { recursive: true });
    const sessionFile = path.join(sessionDir, 'session-001.jsonl');

    writeJsonl(sessionFile, [
      { type: 'user', content: [{ text: 'Hello' }] },
      { type: 'gemini', content: [{ text: 'Hi!' }], tokens: { total: 12_000, input: 10_000, output: 2_000, cached: 0 } },
    ]);

    const { GenericAgentAdapter } = await import('./adapters/generic.js');
    const adapter = new GenericAgentAdapter({
      id: 'my-agent',
      displayName: 'My Agent',
      commandName: 'myagent',
      contextWindow: 100_000,
      sessionFormat: 'gemini-compatible',
      sessionDir,
    });

    const snap = await adapter.getUsageSnapshot();
    expect(snap.inputTokensUsed).toBe(12_000);
    expect(snap.contextUsedPercent).toBeCloseTo(12);
  });
});

// ---------------------------------------------------------------------------
// 11. buildNonInteractiveArgs per adapter
// ---------------------------------------------------------------------------

describe('buildNonInteractiveArgs', () => {
  it('ClaudeCodeAdapter uses --print flag', async () => {
    const { ClaudeCodeAdapter } = await import('./adapters/claude.js');
    const adapter = new ClaudeCodeAdapter('/project');
    expect(adapter.buildNonInteractiveArgs!('do the thing')).toEqual(['--print', 'do the thing']);
  });

  it('GeminiAdapter uses -p flag', async () => {
    const { GeminiAdapter } = await import('./adapters/gemini.js');
    const adapter = new GeminiAdapter();
    expect(adapter.buildNonInteractiveArgs!('do the thing')).toEqual(['-p', 'do the thing']);
  });

  it('CodexAdapter uses --full-auto flag', async () => {
    const { CodexAdapter } = await import('./adapters/codex.js');
    const adapter = new CodexAdapter();
    expect(adapter.buildNonInteractiveArgs!('do the thing')).toEqual(['--full-auto', 'do the thing']);
  });

  it('GenericAgentAdapter defaults to --print', async () => {
    const { GenericAgentAdapter } = await import('./adapters/generic.js');
    const adapter = new GenericAgentAdapter({
      id: 'aider', displayName: 'Aider', commandName: 'aider',
      contextWindow: 128_000, sessionFormat: 'none',
    });
    expect(adapter.buildNonInteractiveArgs!('do the thing')).toEqual(['--print', 'do the thing']);
  });
});
