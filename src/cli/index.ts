#!/usr/bin/env node

/**
 * spec-gen CLI entry point
 *
 * Reverse-engineer OpenSpec specifications from existing codebases.
 * Philosophy: "Archaeology over Creativity" — Extract the truth of what code does.
 */

import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { analyzeCommand } from './commands/analyze.js';
import { generateCommand } from './commands/generate.js';
import { verifyCommand } from './commands/verify.js';
import { driftCommand } from './commands/drift.js';
import { runCommand } from './commands/run.js';
import { configureLogger } from '../utils/logger.js';

const program = new Command();

// Hook to configure logger before any command runs
program.hook('preAction', (thisCommand) => {
  const opts = thisCommand.opts();
  configureLogger({
    quiet: opts.quiet ?? false,
    verbose: opts.verbose ?? false,
    noColor: opts.color === false,
    timestamps: process.env.CI === 'true' || opts.color === false,
  });
});

program
  .name('spec-gen')
  .description(
    'Reverse-engineer OpenSpec specifications from existing codebases.\n\n' +
    'Philosophy: "Archaeology over Creativity" — We extract the truth of what\n' +
    'code does, grounded in static analysis, not LLM hallucinations.'
  )
  .version('1.0.0')
  .option('-q, --quiet', 'Minimal output (errors only)', false)
  .option('-v, --verbose', 'Show debug information', false)
  .option('--no-color', 'Disable colored output (also enables timestamps)')
  .option('--config <path>', 'Path to config file', '.spec-gen/config.json')
  .option('--api-base <url>', 'Custom LLM API base URL (for local/enterprise OpenAI-compatible servers)')
  .option('--insecure', 'Disable SSL certificate verification (for internal/self-signed certs)')
  .addHelpText(
    'after',
    `
Workflow:
  1. spec-gen init      Detect project type, create config
  2. spec-gen analyze   Scan codebase, build dependency graph
  3. spec-gen generate  Create OpenSpec files using LLM
  4. spec-gen verify    Validate specs against source code
  5. spec-gen drift     Detect when code outpaces specs

Quick start:
  $ cd your-project
  $ spec-gen init
  $ spec-gen analyze
  $ spec-gen generate

Or run the full pipeline at once:
  $ spec-gen run

Output integrates with OpenSpec ecosystem:
  openspec/
  ├── config.yaml
  ├── specs/
  │   ├── overview/spec.md
  │   ├── architecture/spec.md
  │   └── {domain}/spec.md
  └── decisions/              (with --adr flag)
      ├── index.md
      └── adr-NNNN-*.md

Learn more: https://github.com/Fission-AI/OpenSpec
`
  );

// Register subcommands
program.addCommand(initCommand);
program.addCommand(analyzeCommand);
program.addCommand(generateCommand);
program.addCommand(verifyCommand);
program.addCommand(driftCommand);
program.addCommand(runCommand);

program.parse();
