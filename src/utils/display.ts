import chalk from 'chalk';

export function printWelcome(modelId: string): void {
  console.log('');
  console.log(chalk.bold('  MACC') + chalk.dim(' — Multi-Agent Coding Client'));
  console.log(chalk.dim(`  Model: ${modelId}  |  Type /help for commands, Ctrl+C to exit`));
  console.log('');
}

export function printUsageBar(usagePercent: number, inputTokens: number, contextWindow: number): void {
  const filled = Math.round(usagePercent / 5);
  const empty = 20 - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);

  const pct = usagePercent.toFixed(1);
  const used = inputTokens.toLocaleString();
  const total = contextWindow.toLocaleString();

  let line: string;
  if (usagePercent >= 98) {
    line = chalk.red(`  Context: ${pct}%  ${bar}  ${used} / ${total} tokens`);
  } else if (usagePercent >= 90) {
    line = chalk.yellow(`  Context: ${pct}%  ${bar}  ${used} / ${total} tokens`);
  } else {
    line = chalk.dim(`  Context: ${pct}%  ${bar}  ${used} / ${total} tokens`);
  }

  console.log(line);
}

export function printWarning(usagePercent: number, inputTokens: number, contextWindow: number): void {
  console.log('');
  console.log(chalk.yellow.bold(`  ⚠  Context at ${usagePercent.toFixed(0)}% — ${inputTokens.toLocaleString()} / ${contextWindow.toLocaleString()} tokens used.`));
}

export function printHandoffMenu(models: string[], forced = false): void {
  console.log('');
  console.log(chalk.bold(forced ? '  Switch to which agent?' : '  Compress and continue with:'));
  console.log(chalk.dim('  [0] Exit MACC'));
  models.forEach((m, i) => {
    const label = i === 0 ? chalk.green(`  [${i + 1}] ${m}`) + chalk.dim(' — recommended') : `  [${i + 1}] ${m}`;
    console.log(label);
  });
  console.log('');
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function startHandoffProgress(): {
  onProgress: (chars: number) => void;
  finish: (elapsedMs: number) => void;
} {
  let frame = 0;
  let chars = 0;
  const interval = setInterval(() => {
    const spinner = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
    frame++;
    const tokens = Math.round(chars / 4);
    const tokenStr = tokens > 0 ? ` ${tokens} tokens` : '';
    process.stdout.write(chalk.dim(`\r  Compressing session... ${spinner}${tokenStr}   `));
  }, 100);

  return {
    onProgress(c: number) { chars = c; },
    finish(elapsedMs: number) {
      clearInterval(interval);
      process.stdout.write(
        chalk.dim('\r  Compressing session... ') +
        chalk.green(`done (${(elapsedMs / 1000).toFixed(1)}s)`) +
        '          \n'
      );
    },
  };
}

export function printHandoffSummary(summary: {
  ultimateGoal: string;
  completedWork: string;
  nextStep: string;
  filesModified: string[];
  blockers: string[];
}): void {
  const W = 54;
  const line = (label: string, value: string) => {
    const maxVal = W - label.length - 2;
    const truncated = value.length > maxVal ? value.slice(0, maxVal - 1) + '…' : value;
    console.log(`  │ ${chalk.dim(label)} ${truncated}`);
  };

  console.log('');
  console.log(chalk.bold('  ┌─ Handoff summary ') + chalk.dim('─'.repeat(W - 18) + '┐'));
  line('Goal:     ', summary.ultimateGoal);
  line('Done:     ', summary.completedWork);
  line('Next:     ', summary.nextStep);
  if (summary.filesModified.length > 0) {
    line('Files:    ', summary.filesModified.join(', '));
  }
  if (summary.blockers.length > 0) {
    line('Blockers: ', summary.blockers.join('; '));
  }
  console.log(chalk.dim('  └' + '─'.repeat(W + 2) + '┘'));
  console.log('');
}

export function printSwitchBanner(modelId: string, goal: string): void {
  console.log(chalk.bold(`  MACC — ${modelId}`) + chalk.dim('  |  Context: 0%'));
  console.log(chalk.dim(`  Continuing: "${goal.slice(0, 60)}${goal.length > 60 ? '…' : ''}"`));
  console.log('');
}

export function printDashboardHeader(): void {
  console.log('');
  console.log(chalk.bold('  MACC') + chalk.dim(' — Agent Context Monitor'));
  console.log(chalk.dim('  Watching for context limits. Press Ctrl+C to exit.\n'));
  console.log(chalk.dim('  Agent            Status       Context'));
  console.log(chalk.dim('  ' + '─'.repeat(50)));
}

export function printStatusHeader(): void {
  console.log('');
  console.log(chalk.bold('  MACC') + chalk.dim(' — Agent Status'));
  console.log('');
  console.log(chalk.dim('  Agent            Status       Context'));
  console.log(chalk.dim('  ' + '─'.repeat(50)));
}

export function printAgentRow(
  name: string,
  installed: boolean,
  running: boolean,
  usagePercent: number,
  inputTokens: number,
  contextWindow: number,
  isEstimated = false,
): void {
  const nameCol = name.padEnd(16);

  if (!installed) {
    console.log(chalk.dim(`  ${nameCol} not installed`));
    return;
  }

  const statusCol = running ? chalk.green('running    ') : chalk.dim('idle       ');
  const filled = Math.round(Math.min(usagePercent, 100) / 5);
  const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
  const pct = `${usagePercent.toFixed(0)}%`.padStart(4);

  let contextCol: string;
  if (usagePercent >= 98) {
    contextCol = chalk.red(`${bar} ${pct}`);
  } else if (usagePercent >= 90) {
    contextCol = chalk.yellow(`${bar} ${pct}`);
  } else {
    contextCol = chalk.dim(`${bar} ${pct}`);
  }

  const estTag = isEstimated ? chalk.dim(' ~est') : '';
  const detail = running && inputTokens > 0
    ? chalk.dim(` (${inputTokens.toLocaleString()} / ${contextWindow.toLocaleString()})`) + estTag
    : '';

  console.log(`  ${nameCol} ${statusCol} ${contextCol}${detail}`);
}

export function printHelp(): void {
  const row = (cmd: string, desc: string, wip = false) => {
    const tag = wip ? chalk.yellow(' [wip]') : '';
    console.log(`  ${chalk.bold(cmd.padEnd(12))} ${chalk.dim(desc)}${tag}`);
  };
  console.log('');
  console.log(chalk.bold('  In-session commands') + chalk.dim(' (type with or without /)'));
  console.log('');
  row('status',   'Show context usage % and current model');
  row('model',    'Show which AI model is currently active');
  row('switch',   'Switch to a different AI model and carry over context');
  row('compress', 'Shrink context window to keep chatting without switching', true);
  row('history',  'Show past model switches and handoffs this session', true);
  row('help',     'Show this message');
  console.log('');
  console.log(chalk.bold('  Terminal commands') + chalk.dim(' (run in a new terminal window)'));
  console.log('');
  row('start',    'Launch an agent CLI; auto-switches when context fills up');
  row('watch',    'Live dashboard — monitors all agent context in real time');
  row('switch',   'Signal a running session to switch agents');
  row('handoff',  'Compress session and continue in a different agent');
  row('agent',    'Manage custom agents (add / list / remove)');
  console.log('');
}
