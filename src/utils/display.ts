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

export function printHandoffMenu(models: string[]): void {
  console.log('');
  console.log(chalk.bold('  Compress and continue with:'));
  models.forEach((m, i) => {
    const label = i === 0 ? chalk.green(`  [${i + 1}] ${m}`) + chalk.dim(' — recommended') : `  [${i + 1}] ${m}`;
    console.log(label);
  });
  console.log(chalk.dim(`  [${models.length + 1}] Stay here (limited space remaining)`));
  console.log('');
}

export function printHandoffStart(toModel: string): void {
  process.stdout.write(chalk.dim(`\n  Compressing session...`));
}

export function printHandoffDone(toModel: string, elapsedMs: number): void {
  console.log(chalk.green(` done (${(elapsedMs / 1000).toFixed(1)}s)`));
  console.log(chalk.dim(`  Switching to ${toModel}...\n`));
}

export function printSwitchBanner(modelId: string, goal: string): void {
  console.log(chalk.bold(`  MACC — ${modelId}`) + chalk.dim('  |  Context: 0%'));
  console.log(chalk.dim(`  Continuing: "${goal.slice(0, 60)}${goal.length > 60 ? '…' : ''}"`));
  console.log('');
}

export function printHelp(): void {
  console.log('');
  console.log(chalk.bold('  Commands:'));
  console.log('  /status    — show token usage breakdown');
  console.log('  /switch    — manually trigger model switch');
  console.log('  /compress  — compress context without switching');
  console.log('  /model     — show current model');
  console.log('  /history   — show past handoffs');
  console.log('  /help      — this message');
  console.log('');
}
