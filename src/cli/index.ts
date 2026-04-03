#!/usr/bin/env node

/**
 * spec-gen CLI entry point
 *
 * Reverse-engineer OpenSpec specifications from existing codebases.
 * Philosophy: "Archaeology over Creativity" — Extract the truth of what code does.
 */

import { Command } from 'commander';
import { createRequire } from 'node:module';
import { initCommand } from './commands/init.js';
import { analyzeCommand } from './commands/analyze.js';
import { generateCommand } from './commands/generate.js';
import { verifyCommand } from './commands/verify.js';
import { driftCommand } from './commands/drift.js';
import { runCommand } from './commands/run.js';
import { mcpCommand } from './commands/mcp.js';
import { viewCommand } from './commands/view.js';
import { doctorCommand } from './commands/doctor.js';
import { refreshStoriesCommand } from './commands/refresh-stories.js';
import { auditCommand } from './commands/audit.js';
import { configureLogger } from '../utils/logger.js';

// Read version from package.json at runtime so it never drifts from the published version
const require = createRequire(import.meta.url);
const { version } = require('../../package.json') as { version: string };

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

  // Warn when SSL verification is disabled — it's a security trade-off
  if (opts.insecure) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    // Only print if we're not in quiet mode
    if (!opts.quiet) {
      process.stderr.write(
        '\x1b[33m[warn]\x1b[0m --insecure: SSL certificate verification is disabled. ' +
        'Only use this on trusted networks.\n'
      );
    }
  }
});

program
  .name('spec-gen')
  .description(
    'Reverse-engineer OpenSpec specifications from existing codebases.\n\n' +
      'Philosophy: "Archaeology over Creativity" — We extract the truth of what\n' +
      'code does, grounded in static analysis, not LLM hallucinations.'
  )
  .version(version)
  .option('-q, --quiet', 'Minimal output (errors only)', false)
  .option('-v, --verbose', 'Show debug information', false)
  .option('--no-color', 'Disable colored output (also enables timestamps)')
  .option('--config <path>', 'Path to config file', '.spec-gen/config.json')
  .option(
    '--api-base <url>',
    'Custom LLM API base URL (for local/enterprise OpenAI-compatible servers)'
  )
  .option('--insecure', 'Disable SSL certificate verification (for internal/self-signed certs)')
  .addHelpText(
    'after',
    `
Workflow:
  1. spec-gen init      Detect project type, create config
  2. spec-gen analyze   Scan codebase, build dependency graph
  3. spec-gen view      Review visually the dependency graph
  4. spec-gen generate  Create OpenSpec files using LLM
  5. spec-gen verify    Validate specs against source code
  6. spec-gen drift     Detect when code outpaces specs

Quick start:
  $ cd your-project
  $ spec-gen init
  $ spec-gen analyze
  $ spec-gen view
  $ spec-gen generate

Or run the full pipeline at once:
  $ spec-gen run

Troubleshoot your setup:
  $ spec-gen doctor

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
program.addCommand(mcpCommand);
program.addCommand(viewCommand);
program.addCommand(doctorCommand);
program.addCommand(refreshStoriesCommand);
program.addCommand(auditCommand);

program.parse();
