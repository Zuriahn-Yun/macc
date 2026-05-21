#!/usr/bin/env node
import { Command } from 'commander';
import readline from 'node:readline';
import chalk from 'chalk';
import { startSession } from './repl/session.js';
import { listModels, detectAvailableBackend } from './backends/registry.js';
import { discoverAdapters, allAdapters } from './adapters/registry.js';
import { runWithRotation, watchAll, triggerHandoff } from './core/orchestrator.js';
import { fanOut } from './core/fanout.js';
import {
  addCustomAgent, removeCustomAgent, loadCustomAgents,
  type CustomAgentConfig, type SessionFormat,
} from './adapters/generic.js';

const program = new Command();

program
  .name('macc')
  .description('Run any AI coding agent and rotate to the next one when context fills up')
  .version('0.3.1');

// Default: interactive agent launcher with auto-rotation
program
  .command('start', { isDefault: true })
  .description('Start an agent and rotate to another when context is full')
  .option('-a, --agent <id>', 'agent to start: claude-code, gemini-cli, codex, qodo')
  .action(async (opts) => {
    const cwd = process.cwd();
    const all = allAdapters(cwd);
    const installed = all.filter(a => a.installed).map(a => a.adapter);

    // Always show the agent status table on start
    console.log(chalk.bold('\n  MACC — Multi-Agent Coding Client\n'));
    for (const { adapter, installed: isInstalled, installCmd } of all) {
      const ctx = (adapter.getContextWindowSize() / 1000).toFixed(0);
      if (isInstalled) {
        console.log(`  ${chalk.green('✓')} ${adapter.id.padEnd(14)} ${chalk.dim(`${ctx}k ctx`)}`);
      } else {
        console.log(`  ${chalk.dim('✗')} ${chalk.dim(adapter.id.padEnd(14))} ${chalk.dim('not installed')}`);
        console.log(`    ${chalk.dim(`→ ${installCmd}`)}`);
      }
    }
    console.log('');

    if (installed.length === 0) {
      console.error(chalk.red('  No supported agents found on PATH. Install at least one above.\n'));
      process.exit(1);
    }

    const backend = await detectAvailableBackend();
    if (!backend) {
      console.error(chalk.red('  No AI credentials found for compression.'));
      console.error(chalk.dim('  Log in: claude auth login  OR  set ANTHROPIC_API_KEY / GOOGLE_API_KEY\n'));
      process.exit(1);
    }

    let chosen = opts.agent
      ? installed.find(a => a.id === opts.agent)
      : null;

    if (!chosen && installed.length === 1) {
      chosen = installed[0];
      console.log(chalk.dim(`  Only one agent available — starting ${chosen.id}.\n`));
    }

    if (!chosen) {
      console.log(chalk.dim('  Pick an agent to start:\n'));
      installed.forEach((a, i) => {
        const ctx = (a.getContextWindowSize() / 1000).toFixed(0);
        console.log(`  [${i + 1}] ${a.id.padEnd(14)} ${chalk.dim(`${ctx}k ctx`)}`);
      });
      console.log('');

      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>(r => rl.question(chalk.bold.green('> '), r));
      rl.close();

      const n = parseInt(answer.trim(), 10);
      if (isNaN(n) || n < 1 || n > installed.length) {
        console.log(chalk.dim('\n  Cancelled.\n'));
        process.exit(0);
      }
      chosen = installed[n - 1];
    }

    const targets = installed.filter(a => a.id !== chosen!.id);
    await runWithRotation(chosen!, targets, backend);
  });

// Passive monitor (dashboard only, does not launch agents)
program
  .command('watch')
  .description('Dashboard — monitor running agents without launching them')
  .action(async () => {
    const cwd = process.cwd();
    const backend = await detectAvailableBackend();
    if (!backend) {
      console.error(chalk.red('\n  No AI credentials found for compression.\n'));
      process.exit(1);
    }
    const agents = allAdapters(cwd);
    await watchAll(agents, backend);
  });

// Manual one-shot handoff
program
  .command('handoff')
  .description('Compress the active session and hand it off to another agent')
  .option('-s, --source <agent>', 'agent to read from (first installed if omitted)')
  .action(async (opts) => {
    const cwd = process.cwd();
    const adapters = discoverAdapters(cwd);
    if (adapters.length < 2) {
      console.error(chalk.red('\n  Need at least two agents installed to hand off.\n'));
      process.exit(1);
    }
    const source = opts.source ? adapters.find(a => a.id === opts.source) : adapters[0];
    if (!source) { console.error(chalk.red(`\n  Agent "${opts.source}" not found.\n`)); process.exit(1); }
    const targets = adapters.filter(a => a.id !== source.id);
    const backend = await detectAvailableBackend();
    if (!backend) { console.error(chalk.red('\n  No AI credentials found.\n')); process.exit(1); }
    await triggerHandoff(source, targets, backend);
  });

// Trigger a manual agent switch mid-session
program
  .command('switch')
  .description('Switch agents now — sends a switch signal to the running MACC session')
  .action(async () => {
    const { default: fs } = await import('node:fs');
    const { default: os } = await import('node:os');
    const { default: path } = await import('node:path');

    const pidFile = path.join(os.homedir(), '.macc', 'running.pid');
    if (!fs.existsSync(pidFile)) {
      console.error(chalk.red('\n  No running MACC session found. Start one with "macc start".\n'));
      process.exit(1);
    }

    const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    if (isNaN(pid)) {
      console.error(chalk.red('\n  Invalid PID in ~/.macc/running.pid. Try restarting MACC.\n'));
      process.exit(1);
    }

    try {
      process.kill(pid, 'SIGUSR1');
      console.log(chalk.green(`\n  Switch signal sent to MACC (pid ${pid}).\n`));
      console.log(chalk.dim('  The agent will exit and MACC will prompt you to pick a new one.\n'));
    } catch {
      console.error(chalk.red(`\n  Could not signal pid ${pid} — is MACC still running?\n`));
      process.exit(1);
    }
  });

// Fan out current session to N parallel subagents then synthesize
program
  .command('fanout')
  .description('Fan out session to N parallel subagents and synthesize results')
  .option('-n, --count <n>', 'number of parallel subagents', '3')
  .option('-a, --agent <id>', 'agent CLI to use for subagents (default: first available)')
  .action(async (opts) => {
    const count = Math.max(1, parseInt(opts.count, 10) || 3);
    const adapters = discoverAdapters(process.cwd());

    if (adapters.length === 0) {
      console.error(chalk.red('\n  No supported agents found on PATH.'));
      console.error(chalk.dim('  Install one of: claude, gemini, codex, qoder\n'));
      process.exit(1);
    }

    const backend = await detectAvailableBackend();
    if (!backend) {
      console.error(chalk.red('\n  No AI credentials found for decomposition/synthesis.'));
      console.error(chalk.dim('  Log in: claude auth login  OR  set ANTHROPIC_API_KEY / GOOGLE_API_KEY\n'));
      process.exit(1);
    }

    const source = opts.agent
      ? adapters.find(a => a.id === opts.agent)
      : adapters[0];

    if (!source) {
      console.error(chalk.red(`\n  Agent "${opts.agent}" not found on PATH.\n`));
      process.exit(1);
    }

    await fanOut(source, backend, {
      count,
      commandName: source.commandName,
      printFlag: '--print',
    });
  });

// ---------------------------------------------------------------------------
// macc agent — manage user-defined agents
// ---------------------------------------------------------------------------

const agentCmd = program.command('agent').description('Manage custom agents');

agentCmd
  .command('add')
  .description('Add a custom agent via interactive wizard')
  .action(async () => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q: string) => new Promise<string>(r => rl.question(chalk.bold.green(q), r));

    console.log(chalk.bold('\n  MACC — Add Custom Agent\n'));

    const displayName = (await ask('  Display name (e.g. "Aider"): ')).trim();
    if (!displayName) { console.log(chalk.dim('\n  Cancelled.\n')); rl.close(); return; }

    const commandName = (await ask('  CLI binary name (e.g. "aider"): ')).trim();
    if (!commandName) { console.log(chalk.dim('\n  Cancelled.\n')); rl.close(); return; }

    const id = commandName.toLowerCase().replace(/[^a-z0-9-]/g, '-');

    const ctxRaw = (await ask('  Context window size in tokens (e.g. 128000): ')).trim();
    const contextWindow = parseInt(ctxRaw, 10) || 128_000;

    console.log(chalk.dim('\n  Session format options:'));
    console.log('  [1] claude-compatible  (same JSONL as Claude Code — works for many agents)');
    console.log('  [2] none               (no session reading — handoff-to only)\n');
    const fmtChoice = (await ask('  Pick session format [1/2]: ')).trim();
    const sessionFormat: SessionFormat = fmtChoice === '2' ? 'none' : 'claude-compatible';

    let sessionDir: string | undefined;
    if (sessionFormat === 'claude-compatible') {
      const raw = (await ask('  Session directory (e.g. "~/.aider/sessions", Enter to skip): ')).trim();
      sessionDir = raw || undefined;
    }

    const installCmd = (await ask('  Install command (Enter to skip): ')).trim() || undefined;

    rl.close();

    const config: CustomAgentConfig = { id, displayName, commandName, contextWindow, sessionFormat, sessionDir, installCmd };
    addCustomAgent(config);

    console.log(chalk.green(`\n  ✓ "${displayName}" added. Run "macc start" to use it.\n`));
  });

agentCmd
  .command('list')
  .description('List all custom agents')
  .action(() => {
    const agents = loadCustomAgents();
    if (agents.length === 0) {
      console.log(chalk.dim('\n  No custom agents configured. Run "macc agent add" to add one.\n'));
      return;
    }
    console.log(chalk.bold('\n  Custom agents:\n'));
    for (const a of agents) {
      const installed = (() => { try { require('node:child_process').execFileSync('which', [a.commandName], { stdio: 'ignore' }); return true; } catch { return false; } })();
      const status = installed ? chalk.green('✓') : chalk.dim('✗');
      console.log(`  ${status} ${a.displayName.padEnd(18)} ${chalk.dim(a.commandName.padEnd(14))} ${chalk.dim(a.sessionFormat)}`);
    }
    console.log('');
  });

agentCmd
  .command('remove <id>')
  .description('Remove a custom agent by id')
  .action((id: string) => {
    const removed = removeCustomAgent(id);
    if (removed) {
      console.log(chalk.green(`\n  ✓ Agent "${id}" removed.\n`));
    } else {
      console.log(chalk.red(`\n  Agent "${id}" not found. Run "macc agent list" to see configured agents.\n`));
    }
  });

// Direct AI chat (for testing / no agent CLIs installed)
program
  .command('chat')
  .description('Direct AI chat (switches AI models, not agent CLIs)')
  .option('-m, --model <model>', 'model to use (default: claude-sonnet-4-6)')
  .option('--debug', 'verbose API debug output')
  .action(async (opts) => {
    await startSession(opts.model, opts.debug ?? false);
  });

program
  .command('models')
  .description('List models available for macc chat')
  .action(() => {
    console.log('');
    console.log(chalk.bold('  Models for macc chat:'));
    listModels().forEach(m => console.log(`    ${m}`));
    console.log('');
  });

program.parse();
