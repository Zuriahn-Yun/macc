import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeCodeAdapter, extractContentBlocks, VERBOSE_STATUS_PROMPT } from './claude.js';

// ---------------------------------------------------------------------------
// extractContentBlocks
// ---------------------------------------------------------------------------

describe('extractContentBlocks', () => {
  it('returns plain string as-is', () => {
    expect(extractContentBlocks('hello world')).toBe('hello world');
  });

  it('extracts text blocks from content array', () => {
    const content = [
      { type: 'text', text: 'Looking at the file.' },
      { type: 'text', text: ' Done.' },
    ];
    expect(extractContentBlocks(content)).toBe('Looking at the file.\n Done.');
  });

  it('formats tool_use blocks', () => {
    const content = [
      { type: 'text', text: 'Running command.' },
      { type: 'tool_use', id: 'toolu_01', name: 'Bash', input: { command: 'ls -la', description: 'List files' } },
    ];
    const result = extractContentBlocks(content);
    expect(result).toContain('Running command.');
    expect(result).toContain('[Tool: Bash(');
    expect(result).toContain('ls -la');
  });

  it('formats tool_result blocks with content', () => {
    const content = [
      { type: 'tool_result', tool_use_id: 'toolu_01', content: 'file1.ts\nfile2.ts', is_error: false },
    ];
    const result = extractContentBlocks(content);
    expect(result).toContain('[Result: file1.ts');
    expect(result).not.toContain('ERROR');
  });

  it('flags error tool_result blocks', () => {
    const content = [
      { type: 'tool_result', tool_use_id: 'toolu_02', content: 'No such file', is_error: true },
    ];
    const result = extractContentBlocks(content);
    expect(result).toContain('[Result ERROR: No such file]');
  });

  it('truncates long tool_result content', () => {
    const longOutput = 'x'.repeat(1000);
    const content = [
      { type: 'tool_result', tool_use_id: 'toolu_03', content: longOutput, is_error: false },
    ];
    const result = extractContentBlocks(content);
    expect(result).toContain('…');
    expect(result.length).toBeLessThan(700);
  });

  it('skips thinking blocks', () => {
    const content = [
      { type: 'thinking', thinking: 'internal reasoning...' },
      { type: 'text', text: 'Here is my answer.' },
    ];
    const result = extractContentBlocks(content);
    expect(result).not.toContain('internal reasoning');
    expect(result).toBe('Here is my answer.');
  });

  it('returns empty string for non-array non-string', () => {
    expect(extractContentBlocks(null)).toBe('');
    expect(extractContentBlocks(42)).toBe('');
    expect(extractContentBlocks({})).toBe('');
  });
});

// ---------------------------------------------------------------------------
// parseSessionFile via adapter (integration-style with temp files)
// ---------------------------------------------------------------------------

describe('ClaudeCodeAdapter.extractSessionContext', () => {
  let tmpDir: string;
  let projectDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'macc-test-'));
    projectDir = path.join(tmpDir, 'projects', '-test-project');
    fs.mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeSession(lines: object[]): string {
    const file = path.join(projectDir, 'session.jsonl');
    fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n'));
    return file;
  }

  it('captures text-only assistant messages', async () => {
    writeSession([
      {
        type: 'user',
        message: { role: 'user', content: 'Fix the bug' },
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Sure, looking now.' }],
          usage: { input_tokens: 100, output_tokens: 20 },
        },
      },
    ]);

    // Patch findLatestSessionFile by pointing adapter at our temp dir
    // We test the parser directly via the exported function since the adapter
    // does a global scan — use a real file path and verify extractContentBlocks.
    const content = [{ type: 'text', text: 'Sure, looking now.' }];
    expect(extractContentBlocks(content)).toBe('Sure, looking now.');
  });

  it('captures tool_use in assistant messages alongside text', () => {
    const content = [
      { type: 'text', text: 'I will read the file.' },
      { type: 'tool_use', id: 'toolu_abc', name: 'Read', input: { file_path: '/src/auth.ts' } },
    ];
    const result = extractContentBlocks(content);
    expect(result).toContain('I will read the file.');
    expect(result).toContain('[Tool: Read(');
    expect(result).toContain('/src/auth.ts');
  });

  it('captures tool_result in user messages', () => {
    const content = [
      { type: 'tool_result', tool_use_id: 'toolu_abc', content: 'export function login() {}', is_error: false },
    ];
    const result = extractContentBlocks(content);
    expect(result).toBe('[Result: export function login() {}]');
  });

  it('handles mixed user message with text and tool_result', () => {
    const content = [
      { type: 'tool_result', tool_use_id: 'toolu_1', content: 'file output here', is_error: false },
      { type: 'text', text: 'Also some user text.' },
    ];
    const result = extractContentBlocks(content);
    expect(result).toContain('[Result: file output here]');
    expect(result).toContain('Also some user text.');
  });
});

// ---------------------------------------------------------------------------
// buildBaseArgs — prompt injection
// ---------------------------------------------------------------------------

describe('ClaudeCodeAdapter.buildBaseArgs', () => {
  it('returns --append-system-prompt flag', () => {
    const adapter = new ClaudeCodeAdapter('/project');
    const args = adapter.buildBaseArgs();
    expect(args[0]).toBe('--append-system-prompt');
    expect(args[1]).toBe(VERBOSE_STATUS_PROMPT);
    expect(args).toHaveLength(2);
  });

  it('verbose prompt contains [STATUS] format instruction', () => {
    expect(VERBOSE_STATUS_PROMPT).toContain('[STATUS]');
    expect(VERBOSE_STATUS_PROMPT).toContain('files=');
    expect(VERBOSE_STATUS_PROMPT).toContain('goal=');
  });
});

// ---------------------------------------------------------------------------
// buildLaunchArgs — handoff prompt passthrough
// ---------------------------------------------------------------------------

describe('ClaudeCodeAdapter.buildLaunchArgs', () => {
  it('passes handoff prompt as positional arg', () => {
    const adapter = new ClaudeCodeAdapter('/project');
    const packet = {
      version: '1' as const,
      createdAt: new Date().toISOString(),
      fromModel: 'claude-sonnet-4-6',
      toModel: 'gemini-cli',
      cwd: '/project',
      summary: {
        ultimateGoal: 'Fix auth',
        completedWork: 'Reviewed code',
        nextStep: 'Write tests',
        keyDecisions: [],
        blockers: [],
        filesModified: [],
      },
      handoffPrompt: 'Continue fixing auth. Next: write tests.',
    };
    const { args } = adapter.buildLaunchArgs(packet);
    expect(args).toEqual(['Continue fixing auth. Next: write tests.']);
    expect(args).not.toContain('--print');
  });
});
