#!/usr/bin/env node
// Only show this message on global installs, not during local dev `npm install`
if (!process.env.npm_config_global) process.exit(0);

const b = '\x1b[1m';
const d = '\x1b[2m';
const g = '\x1b[32m';
const r = '\x1b[0m';

console.log('');
console.log(`  ${g}${b}MACC installed.${r}`);
console.log(`  ${d}Multi-Agent Coding Client — rotate AI agents before context runs out.${r}`);
console.log('');
console.log(`  Get started: ${b}macc${r}`);
console.log(`  ${d}Run it in any project directory to launch an agent.${r}`);
console.log('');
