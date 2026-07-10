import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// ---------------------------------------------------------------------------
// Mock all external dependencies before importing the module under test
// ---------------------------------------------------------------------------

vi.mock('node:readline', () => ({
  default: {
    createInterface: vi.fn(),
  },
}));

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}));

vi.mock('../auth/credentials.js', () => ({
  readClaudeCredentials: vi.fn(),
  readGcloudAccessToken: vi.fn(),
  hasCliTool: vi.fn(),
}));

vi.mock('../backends/registry.js', () => ({
  getBackend: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRl(answers: string[]) {
  let idx = 0;
  return {
    question: vi.fn((_prompt: string, cb: (answer: string) => void) => {
      cb(answers[idx++ % answers.length] ?? '');
    }),
    close: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runSetupWizard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fast-path: already logged in to Claude skips login and returns backend', async () => {
    const readline = await import('node:readline');
    const { readClaudeCredentials } = await import('../auth/credentials.js');
    const { getBackend } = await import('../backends/registry.js');

    vi.mocked(readline.default.createInterface).mockReturnValue(makeRl(['1']) as never);
    vi.mocked(readClaudeCredentials).mockReturnValue({
      accessToken: 'tok',
      refreshToken: 'ref',
      expiresAt: Date.now() + 3_600_000,
    });
    const fakeBackend = { modelId: 'claude-sonnet-4-6' } as never;
    vi.mocked(getBackend).mockReturnValue(fakeBackend);

    const { runSetupWizard } = await import('./setup.js');
    const result = await runSetupWizard();

    expect(result).toBe(fakeBackend);
    // Login function should NOT have been called — already authenticated
    const cp = await import('node:child_process');
    expect(cp.spawnSync).not.toHaveBeenCalled();
  });

  it('successful Claude login flow returns backend', async () => {
    const readline = await import('node:readline');
    const { readClaudeCredentials, hasCliTool } = await import('../auth/credentials.js');
    const { getBackend } = await import('../backends/registry.js');
    const cp = await import('node:child_process');

    // Not logged in initially, but login succeeds.
    // readClaudeCredentials is called 3 times:
    //   1. PROVIDERS display loop (checkAvailable for Claude)
    //   2. provider.checkAvailable() guard before login
    //   3. Inside loginClaude() to verify credentials were saved
    vi.mocked(readline.default.createInterface).mockReturnValue(makeRl(['1']) as never);
    vi.mocked(readClaudeCredentials)
      .mockReturnValueOnce(null)   // display loop check
      .mockReturnValueOnce(null)   // pre-login guard
      .mockReturnValueOnce({       // post-login verification in loginClaude()
        accessToken: 'tok',
        refreshToken: 'ref',
        expiresAt: Date.now() + 3_600_000,
      });
    vi.mocked(hasCliTool).mockReturnValue(true);
    vi.mocked(cp.spawnSync).mockReturnValue({ status: 0 } as never);
    const fakeBackend = { modelId: 'claude-sonnet-4-6' } as never;
    vi.mocked(getBackend).mockReturnValue(fakeBackend);

    const { runSetupWizard } = await import('./setup.js');
    const result = await runSetupWizard();

    expect(result).toBe(fakeBackend);
    expect(cp.spawnSync).toHaveBeenCalledWith('claude', ['auth', 'login'], expect.any(Object));
  });

  it('missing claude CLI prints install instructions and returns false', async () => {
    const readline = await import('node:readline');
    const { readClaudeCredentials, hasCliTool } = await import('../auth/credentials.js');

    vi.mocked(readline.default.createInterface).mockReturnValue(makeRl(['1']) as never);
    vi.mocked(readClaudeCredentials).mockReturnValue(null); // not logged in
    vi.mocked(hasCliTool).mockReturnValue(false);           // claude not on PATH

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit called'); });

    const { runSetupWizard } = await import('./setup.js');
    await expect(runSetupWizard()).rejects.toThrow('process.exit called');

    const output = consoleSpy.mock.calls.map(c => c.join('')).join('\n');
    expect(output).toContain('Claude CLI not found');

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('invalid menu choice prompts again until valid', async () => {
    const readline = await import('node:readline');
    const { readClaudeCredentials, hasCliTool } = await import('../auth/credentials.js');
    const { getBackend } = await import('../backends/registry.js');
    const cp = await import('node:child_process');

    // First answer is invalid, second is valid
    const rl = makeRl(['99', '1']);
    vi.mocked(readline.default.createInterface).mockReturnValue(rl as never);
    vi.mocked(readClaudeCredentials)
      .mockReturnValueOnce(null)
      .mockReturnValue({ accessToken: 'tok', refreshToken: 'ref', expiresAt: Date.now() + 3_600_000 });
    vi.mocked(hasCliTool).mockReturnValue(true);
    vi.mocked(cp.spawnSync).mockReturnValue({ status: 0 } as never);
    vi.mocked(getBackend).mockReturnValue({ modelId: 'claude-sonnet-4-6' } as never);

    const { runSetupWizard } = await import('./setup.js');
    const result = await runSetupWizard();
    expect(result).toBeDefined();
    // question should have been called at least twice (invalid + valid)
    expect(rl.question).toHaveBeenCalledTimes(2);
  });

  it('Google login success returns Gemini backend', async () => {
    const readline = await import('node:readline');
    const { readClaudeCredentials, readGcloudAccessToken, hasCliTool } = await import('../auth/credentials.js');
    const { getBackend } = await import('../backends/registry.js');
    const cp = await import('node:child_process');

    vi.mocked(readline.default.createInterface).mockReturnValue(makeRl(['2']) as never);
    vi.mocked(readClaudeCredentials).mockReturnValue(null); // Claude not available
    // readGcloudAccessToken called 3 times:
    //   1. PROVIDERS display loop (Gemini checkAvailable)
    //   2. provider.checkAvailable() guard before login
    //   3. Inside loginGoogle() to verify token was saved
    vi.mocked(readGcloudAccessToken)
      .mockReturnValueOnce(null)        // display loop check
      .mockReturnValueOnce(null)        // pre-login guard
      .mockReturnValueOnce('ya29.tok'); // post-login verification
    vi.mocked(hasCliTool).mockReturnValue(true);
    vi.mocked(cp.spawnSync).mockReturnValue({ status: 0 } as never);
    const fakeBackend = { modelId: 'gemini-2.5-pro' } as never;
    vi.mocked(getBackend).mockReturnValue(fakeBackend);

    const { runSetupWizard } = await import('./setup.js');
    const result = await runSetupWizard();

    expect(result).toBe(fakeBackend);
    expect(cp.spawnSync).toHaveBeenCalledWith(
      'gcloud',
      ['auth', 'application-default', 'login'],
      expect.any(Object)
    );
  });

  it('failed login calls process.exit(1)', async () => {
    const readline = await import('node:readline');
    const { readClaudeCredentials, hasCliTool } = await import('../auth/credentials.js');
    const cp = await import('node:child_process');

    vi.mocked(readline.default.createInterface).mockReturnValue(makeRl(['1']) as never);
    vi.mocked(readClaudeCredentials).mockReturnValue(null);
    vi.mocked(hasCliTool).mockReturnValue(true);
    vi.mocked(cp.spawnSync).mockReturnValue({ status: 1 } as never); // login failed

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit called'); });
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { runSetupWizard } = await import('./setup.js');
    await expect(runSetupWizard()).rejects.toThrow('process.exit called');

    exitSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it('Qodo selection prints coming-soon and shows menu again', async () => {
    const readline = await import('node:readline');
    const { readClaudeCredentials, hasCliTool } = await import('../auth/credentials.js');
    const { getBackend } = await import('../backends/registry.js');
    const cp = await import('node:child_process');

    // Choose Qodo first, then Claude
    vi.mocked(readline.default.createInterface)
      .mockReturnValueOnce(makeRl(['3']) as never) // first wizard: Qodo
      .mockReturnValueOnce(makeRl(['1']) as never); // recursive call: Claude

    vi.mocked(readClaudeCredentials)
      .mockReturnValueOnce(null) // first check (Qodo wizard display)
      .mockReturnValueOnce(null) // second wizard: not logged in
      .mockReturnValue({ accessToken: 'tok', refreshToken: 'ref', expiresAt: Date.now() + 3_600_000 });
    vi.mocked(hasCliTool).mockReturnValue(true);
    vi.mocked(cp.spawnSync).mockReturnValue({ status: 0 } as never);
    vi.mocked(getBackend).mockReturnValue({ modelId: 'claude-sonnet-4-6' } as never);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { runSetupWizard } = await import('./setup.js');
    const result = await runSetupWizard();

    const output = consoleSpy.mock.calls.map(c => c.join('')).join('\n');
    expect(output).toContain('coming soon');
    expect(result).toBeDefined();

    consoleSpy.mockRestore();
  });
});
