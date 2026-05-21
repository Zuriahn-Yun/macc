#!/usr/bin/env node
import { Command } from 'commander';
import readline from 'node:readline';
import chalk from 'chalk';
import { createRequire } from 'node:module';
const { version } = createRequire(import.meta.url)('../package.json') as { version: string };
import { detectAllAvailableBackends } from './backends/registry.js';
import { discoverAdapters, allAdapters } from './adapters/registry.js';
import { runWithRotation, watchAll, triggerHandoff, printStatusOnce } from './core/orchestrator.js';
import {
  addCustomAgent, removeCustomAgent, loadCustomAgents,
  type CustomAgentConfig, type SessionFormat,
} from './adapters/generic.js';

const program = new Command();

program
  .name('macc')
  .description('Run any AI coding agent and rotate to the next one when context fills up')
  .version(version);

const commandRows: [string, string][] = [
  ['macc start',          'Launch an agent; auto-switches when context fills up'],
  ['macc status',         'Snapshot of context usage across all agents'],
  ['macc watch',          'Live dashboard; monitors agents in real time'],
  ['macc switch [agent]', 'Switch to a different agent mid-session'],
  ['macc handoff',        'Compress current session and continue in another agent'],
  ['macc agent add',      'Add a custom agent via setup wizard'],
  ['macc agent list',     'List all configured custom agents'],
  ['macc agent remove',   'Remove a custom agent by id'],
  ['macc help',           'Full command reference'],
];

function printCommandReference(): void {
  console.log('');
  console.log(chalk.bold('  Commands:'));
  const maxLen = Math.max(...commandRows.map(([cmd]) => cmd.length));
  for (const [cmd, desc] of commandRows) {
    console.log(`  ${chalk.bold(cmd.padEnd(maxLen + 2))} ${chalk.dim(desc)}`);
  }
  console.log('');
}

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

    const backends = await detectAllAvailableBackends();
    if (backends.length === 0) {
      console.error(chalk.red('  No AI credentials found for compression.'));
      console.error(chalk.dim('  Log in: claude auth login  OR  set ANTHROPIC_API_KEY / GOOGLE_API_KEY\n'));
      process.exit(1);
    }

    if (opts.agent && !installed.find(a => a.id === opts.agent)) {
      const known = all.map(a => a.adapter.id);
      const isKnown = known.includes(opts.agent);
      if (isKnown) {
        console.error(chalk.red(`\n  Agent "${opts.agent}" is not installed.\n`));
      } else {
        console.error(chalk.red(`\n  Unknown agent "${opts.agent}". Available: ${known.join(', ')}\n`));
      }
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
      const printAgentMenu = () => {
        console.log(chalk.dim('  Pick an agent to start:\n'));
        installed.forEach((a, i) => {
          const ctx = (a.getContextWindowSize() / 1000).toFixed(0);
          console.log(`  [${i + 1}] ${a.id.padEnd(14)} ${chalk.dim(`${ctx}k ctx`)}`);
        });
        console.log(chalk.dim('\n  Type a number or agent id to start, "watch"/"status" to inspect, "help" for commands, or "q" to quit.\n'));
      };

      printAgentMenu();

      let chosen_n = -1;
      while (true) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>(r => rl.question(chalk.bold.green('> '), r));
        rl.close();
        const trimmed = answer.trim().toLowerCase();

        if (trimmed === 'q' || trimmed === 'quit' || trimmed === 'exit') {
          console.log(chalk.dim('\n  Exiting.\n'));
          process.exit(0);
        }

        if (trimmed === 'help' || trimmed === '/help' || trimmed === 'macc help') {
          printCommandReference();
          printAgentMenu();
          continue;
        }

        if (trimmed === 'start' || trimmed === 'macc start') {
          printAgentMenu();
          continue;
        }

        if (trimmed === 'watch' || trimmed === 'macc watch') {
          await watchAll(all, backends);
          printAgentMenu();
          continue;
        }

        if (trimmed === 'status' || trimmed === 'macc status') {
          await printStatusOnce(all);
          printAgentMenu();
          continue;
        }

        const command = (() => {
          if (trimmed === 'switch' || trimmed.startsWith('macc switch')) return 'macc switch';
          if (trimmed === 'handoff' || trimmed === 'macc handoff') return 'macc handoff';
          if (trimmed === 'agent add' || trimmed === 'macc agent add') return 'macc agent add';
          if (trimmed === 'agent list' || trimmed === 'macc agent list') return 'macc agent list';
          if (trimmed.startsWith('agent remove') || trimmed.startsWith('macc agent remove')) return 'macc agent remove';
          return null;
        })();
        if (command) {
          console.log(chalk.dim(`\n  Run "${command}" in another terminal while MACC is running.\n`));
          printAgentMenu();
          continue;
        }

        const byId = installed.find(a => a.id.toLowerCase() === trimmed);
        if (byId) {
          chosen = byId;
          break;
        }

        const n = parseInt(trimmed, 10);
        if (!isNaN(n) && n >= 1 && n <= installed.length) {
          chosen_n = n;
          break;
        }

        const shown = answer.trim() || '<empty>';
        console.log(chalk.dim(`\n  "${shown}" is not a command.`));
        console.log(chalk.dim(`  Enter a number 1-${installed.length}, an agent id, "watch", "status", "help", "start", or "q" to quit.\n`));
      }
      chosen ??= installed[chosen_n - 1];
    }

    const targets = installed.filter(a => a.id !== chosen!.id);
    await runWithRotation(chosen!, targets, backends);
  });

// Passive monitor (dashboard only, does not launch agents)
program
  .command('watch')
  .description('Dashboard — monitor running agents without launching them')
  .action(async () => {
    const cwd = process.cwd();
    const backends = await detectAllAvailableBackends();
    if (backends.length === 0) {
      console.error(chalk.red('\n  No AI credentials found for compression.\n'));
      process.exit(1);
    }
    const agents = allAdapters(cwd);
    await watchAll(agents, backends);

    // After exiting the dashboard, offer to start an agent
    const installed = agents.filter(a => a.installed).map(a => a.adapter);
    if (installed.length > 0) {
      const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>(r =>
        rl2.question(chalk.dim('  Start an agent? [y/N] '), r)
      );
      rl2.close();
      if (answer.trim().toLowerCase() === 'y') {
        const targets = installed.slice(1);
        await runWithRotation(installed[0], targets, backends);
      }
    }
  });

// One-shot status snapshot
program
  .command('status')
  .description('Show current context usage for all agents (one-shot)')
  .action(async () => {
    const cwd = process.cwd();
    const agents = allAdapters(cwd);
    await printStatusOnce(agents);
  });

// Show all available commands
program
  .command('help')
  .description('Show all macc commands and what they do')
  .action(() => {
    console.log('');
    console.log(chalk.bold('  MACC — Multi-Agent Coding Client'));
    console.log(chalk.dim(`  v${version}\n`));
    printCommandReference();
    console.log(chalk.dim('  Flags:'));
    console.log(`  ${chalk.bold('macc start -a <id>')}    ${chalk.dim('Start a specific agent (claude-code, gemini-cli, codex…)')}`);
    console.log('');
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
    const backends = await detectAllAvailableBackends();
    if (backends.length === 0) { console.error(chalk.red('\n  No AI credentials found.\n')); process.exit(1); }
    await triggerHandoff(source, targets, backends);
  });

// Trigger a manual agent switch mid-session
program
  .command('switch [agent]')
  .description('Switch agents — optionally specify target agent id to skip the picker')
  .action(async (agent?: string) => {
    const { default: fs } = await import('node:fs');
    const { default: os } = await import('node:os');
    const { default: path } = await import('node:path');

    const maccDir = path.join(os.homedir(), '.macc');
    const pidFile = path.join(maccDir, 'running.pid');
    if (!fs.existsSync(pidFile)) {
      console.error(chalk.red('\n  No running MACC session found. Start one with "macc start".\n'));
      process.exit(1);
    }

    const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    if (isNaN(pid)) {
      console.error(chalk.red('\n  Invalid PID in ~/.macc/running.pid. Try restarting MACC.\n'));
      process.exit(1);
    }

    if (agent) {
      fs.mkdirSync(maccDir, { recursive: true });
      fs.writeFileSync(path.join(maccDir, 'switch-target'), agent, 'utf8');
    }

    try {
      process.kill(pid, 'SIGUSR1');
      if (agent) {
        console.log(chalk.green(`\n  Switching to ${agent} (pid ${pid}).\n`));
      } else {
        console.log(chalk.green(`\n  Switch signal sent to MACC (pid ${pid}).\n`));
        console.log(chalk.dim('  The agent will exit and MACC will prompt you to pick a new one.\n'));
      }
    } catch {
      if (agent) fs.rmSync(path.join(maccDir, 'switch-target'), { force: true });
      console.error(chalk.red(`\n  Could not signal pid ${pid} — is MACC still running?\n`));
      process.exit(1);
    }
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

program.parse();
