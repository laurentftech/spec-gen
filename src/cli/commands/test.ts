/**
 * spec-gen test command
 *
 * Generates spec-driven test files from OpenSpec scenarios, or reports
 * spec test coverage across the project.
 *
 * Two modes:
 *   Default:    Generate test files (with THEN pattern engine ± LLM)
 *   --coverage: Report which scenarios have corresponding tests
 *
 * Key features:
 *   - Supports vitest, playwright, pytest, gtest, catch2 (auto-detect)
 *   - THEN clause pattern engine generates real assertions without LLM
 *   - --use-llm enriches unmatched clauses with mapped function context
 *   - --coverage scans for spec-gen: metadata tags (tag-based)
 *   - --discover extends coverage via semantic test title matching
 *   - --min-coverage exits 1 if coverage is below threshold (CI gate)
 */

import { Command } from 'commander';
import { join } from 'node:path';
import { logger } from '../../utils/logger.js';
import { parseList, formatDuration } from '../../utils/command-helpers.js';
import { readSpecGenConfig } from '../../core/services/config-manager.js';
import { createLLMService } from '../../core/services/llm-service.js';
import type { LLMService } from '../../core/services/llm-service.js';
import {
  parseScenarios,
  generateTests,
  writeTestFiles,
  analyzeTestCoverage,
  detectFramework,
} from '../../core/test-generator/index.js';
import type { TestFramework, TestCoverageReport } from '../../types/test-generator.js';
import {
  SPEC_GEN_DIR,
  SPEC_GEN_LOGS_SUBDIR,
  SPEC_GEN_CONFIG_REL_PATH,
  OPENSPEC_DIR,
  OPENSPEC_SPECS_SUBDIR,
} from '../../constants.js';
import { fileExists } from '../../utils/command-helpers.js';

// ============================================================================
// DISPLAY HELPERS
// ============================================================================

function displayCoverageReport(report: TestCoverageReport, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log('');
  console.log('   Spec Test Coverage Report');
  console.log('   ─────────────────────────────────────────');
  console.log('');
  console.log(`   Total scenarios:    ${report.totalScenarios}`);
  console.log(`   Covered (tagged):   ${report.taggedScenarios}`);
  if (report.discoveredScenarios > 0) {
    console.log(`   Discovered:         ${report.discoveredScenarios}   (via semantic match)`);
  }
  console.log(`   Uncovered:          ${report.totalScenarios - report.coveredScenarios}`);

  const thresholdSuffix = report.minCoverage !== undefined
    ? `  (target: ${report.minCoverage}%) ${report.belowThreshold ? '✗ below threshold' : '✓'}`
    : '';
  console.log(`   Effective coverage: ${report.coveragePercent}%${thresholdSuffix}`);
  console.log('');
  console.log('   By domain:');

  for (const [domain, info] of Object.entries(report.byDomain).sort()) {
    const bar = `${info.covered}/${info.total}`;
    const pct = `(${info.percent}%)`;
    const drift = info.hasDrift ? ' ⚠ drift detected' : '';
    const status = info.percent >= 80 ? ' ✓' : '';
    console.log(`     ${domain.padEnd(20)} ${bar.padStart(6)}  ${pct.padEnd(8)}${status}${drift}`);
  }

  if (report.uncovered.length > 0) {
    console.log('');
    console.log('   Uncovered scenarios:');
    for (const s of report.uncovered.slice(0, 20)) {
      console.log(`     ${s.domain}/${s.requirement}/${s.scenarioName}`);
    }
    if (report.uncovered.length > 20) {
      console.log(`     ... and ${report.uncovered.length - 20} more`);
    }
  }

  console.log('');
}

function displayGenerationSummary(
  files: Array<{ outputPath: string; scenarios: { length: number }[]; isNew: boolean }>,
  written: number,
  skipped: number,
  merged: number,
  dryRun: boolean
): void {
  console.log('');
  if (dryRun) {
    console.log('   Dry run — no files written. Would generate:');
  } else {
    const actions: string[] = [];
    if (written > 0) actions.push(`${written} written`);
    if (merged > 0) actions.push(`${merged} merged`);
    if (skipped > 0) actions.push(`${skipped} skipped`);
    console.log(`   Files: ${actions.join(', ')}`);
  }

  for (const file of files) {
    const scenCount = file.scenarios.length;
    const icon = file.isNew ? '+ ' : '~ ';
    console.log(`     ${icon}${file.outputPath}  (${scenCount} scenario${scenCount !== 1 ? 's' : ''})`);
  }

  console.log('');
}

// ============================================================================
// COMMAND
// ============================================================================

export const testCommand = new Command('test')
  .description('Generate spec-driven tests or report spec test coverage')
  // Generation options
  .option(
    '--framework <name>',
    'Test framework: vitest | playwright | pytest | gtest | catch2 | auto',
    'auto'
  )
  .option('--domains <list>', 'Only generate tests for specific domains (comma-separated)', parseList)
  .option('--exclude-domains <list>', 'Skip these domains (comma-separated)', parseList)
  .option('--tags <list>', 'Only include scenarios carrying ALL these tags (comma-separated)', parseList)
  .option('--output <path>', 'Output directory for generated tests', 'spec-tests')
  .option('--merge', 'Append new scenarios to existing test files', false)
  .option('--dry-run', 'Preview what would be generated without writing files', false)
  .option('--use-llm', 'Use LLM to fill in unmatched THEN clauses (requires API key)', false)
  .option('--limit <n>', 'Maximum number of scenarios to process')
  // Coverage options
  .option('--coverage', 'Show spec test coverage report instead of generating', false)
  .option('--discover', 'Semantically match existing tests to uncovered scenarios (requires --use-llm)', false)
  .option('--min-coverage <n>', 'Fail if effective coverage is below N% (for CI)')
  .option('--test-dirs <list>', 'Directories to scan for tests (default: spec-tests,src)', parseList)
  // Shared
  .option('--json', 'Output JSON (for CI / scripting)', false)
  .addHelpText(
    'after',
    `
Examples:
  $ spec-gen test                              Generate tests (auto-detect framework)
  $ spec-gen test --framework pytest           Generate pytest tests
  $ spec-gen test --framework gtest            Generate Google Test (C++) tests
  $ spec-gen test --framework catch2           Generate Catch2 (C++) tests
  $ spec-gen test --domains auth,tasks         Only for specific domains
  $ spec-gen test --exclude-domains database   Skip a domain
  $ spec-gen test --tags smoke,regression      Only scenarios tagged smoke AND regression
  $ spec-gen test --dry-run                    Preview without writing
  $ spec-gen test --use-llm                    Enrich assertions via LLM
  $ spec-gen test --merge                      Append new scenarios to existing files

  $ spec-gen test --coverage                   Show spec test coverage
  $ spec-gen test --coverage --discover --use-llm   Semantic discovery of existing tests
  $ spec-gen test --coverage --min-coverage 80      Fail CI if coverage < 80%
  $ spec-gen test --coverage --json            Machine-readable coverage output

Metadata tag format (in generated files):
  // spec-gen: {"domain":"auth","requirement":"UserLogin","scenario":"SuccessfulLogin",...}
  # spec-gen: ...                              (Python)

This tag enables coverage tracking even when tests are moved between files.
`
  )
  .action(async function (this: Command) {
    const startTime = Date.now();
    const rootPath = process.cwd();
    const opts = this.opts();
    const globalOpts = this.optsWithGlobals?.() ?? {};

    const quiet: boolean = globalOpts.quiet ?? false;
    const verbose: boolean = opts.verbose ?? globalOpts.verbose ?? false;
    const isCoverage: boolean = opts.coverage ?? false;
    const isDiscover: boolean = opts.discover ?? false;
    const isDryRun: boolean = opts.dryRun ?? false;
    const isMerge: boolean = opts.merge ?? false;
    const useLlm: boolean = opts.useLlm ?? false;
    const isJson: boolean = opts.json ?? false;
    const domains: string[] = opts.domains ?? [];
    const excludeDomains: string[] = opts.excludeDomains ?? [];
    const tags: string[] = opts.tags ?? [];
    const testDirs: string[] = opts.testDirs ?? ['spec-tests', 'src'];
    const outputDir: string = opts.output ?? 'spec-tests';
    const limit: number | undefined = opts.limit ? parseInt(opts.limit, 10) : undefined;
    const minCoverage: number | undefined = opts.minCoverage ? parseFloat(opts.minCoverage) : undefined;

    // ── Validate ──────────────────────────────────────────────────────────
    if (!isJson) logger.section('Spec-Driven Tests');

    const specsPath = join(rootPath, OPENSPEC_DIR, OPENSPEC_SPECS_SUBDIR);
    if (!(await fileExists(specsPath))) {
      logger.error('No specs found. Run "spec-gen generate" first.');
      process.exitCode = 1;
      return;
    }

    // ── LLM Setup ────────────────────────────────────────────────────────
    let llm: LLMService | undefined;
    if (useLlm || isDiscover) {
      const config = await readSpecGenConfig(rootPath);
      const anthropicKey = process.env.ANTHROPIC_API_KEY;
      const openaiKey = process.env.OPENAI_API_KEY;

      if (!anthropicKey && !openaiKey) {
        logger.error('--use-llm and --discover require an API key.');
        logger.discovery('Set ANTHROPIC_API_KEY or OPENAI_API_KEY.');
        process.exitCode = 1;
        return;
      }

      try {
        const provider = anthropicKey ? 'anthropic' : 'openai';
        llm = createLLMService({
          provider,
          apiBase: globalOpts.apiBase ?? config?.llm?.apiBase,
          sslVerify: globalOpts.insecure != null ? !globalOpts.insecure : config?.llm?.sslVerify ?? true,
          enableLogging: true,
          logDir: join(rootPath, SPEC_GEN_DIR, SPEC_GEN_LOGS_SUBDIR),
        });
        if (!isJson && verbose) {
          logger.discovery(`LLM enabled (${provider})`);
        }
      } catch (err) {
        logger.error(`LLM setup failed: ${(err as Error).message}`);
        process.exitCode = 1;
        return;
      }
    }

    try {
      // ── COVERAGE MODE ─────────────────────────────────────────────────
      if (isCoverage) {
        if (!isJson) logger.discovery('Scanning test files for spec coverage...');

        const report = await analyzeTestCoverage({
          rootPath,
          testDirs,
          domains: domains.length > 0 ? domains : undefined,
          discover: isDiscover && !!llm,
          llm,
          minCoverage,
        });

        displayCoverageReport(report, isJson);

        if (llm) {
          const usage = llm.getTokenUsage();
          if (!isJson && usage.requests > 0) {
            logger.info('LLM calls', usage.requests);
            logger.info('Tokens used', `${usage.totalTokens}`);
          }
          await llm.saveLogs().catch(() => {});
        }

        if (report.belowThreshold) {
          if (!isJson) {
            logger.error(`Coverage ${report.coveragePercent}% is below required ${minCoverage}%`);
          }
          process.exitCode = 1;
        }
        return;
      }

      // ── GENERATION MODE ───────────────────────────────────────────────
      if (!isJson) logger.discovery('Parsing spec scenarios...');

      const scenarios = await parseScenarios({
        rootPath,
        domains: domains.length > 0 ? domains : undefined,
        excludeDomains: excludeDomains.length > 0 ? excludeDomains : undefined,
        tags: tags.length > 0 ? tags : undefined,
        limit,
      });

      if (scenarios.length === 0) {
        logger.warning('No scenarios found. Check your spec files or --domains filter.');
        return;
      }

      if (!isJson) logger.info('Scenarios found', scenarios.length);

      // Resolve framework
      let framework: TestFramework;
      const frameworkOpt = opts.framework ?? 'auto';
      if (frameworkOpt === 'auto') {
        framework = await detectFramework(rootPath);
        if (!isJson) logger.info('Framework detected', framework);
      } else {
        const valid: TestFramework[] = ['vitest', 'playwright', 'pytest', 'gtest', 'catch2'];
        if (!valid.includes(frameworkOpt)) {
          logger.error(`Unknown framework "${frameworkOpt}". Valid: ${valid.join(', ')}`);
          process.exitCode = 1;
          return;
        }
        framework = frameworkOpt as TestFramework;
      }

      if (!isJson) logger.analysis('Generating test files...');

      const files = await generateTests({
        scenarios,
        framework,
        outputDir,
        rootPath,
        useLlm,
        llm,
      });

      const writeResult = await writeTestFiles({
        files,
        rootPath,
        dryRun: isDryRun,
        merge: isMerge,
      });

      if (isJson) {
        console.log(
          JSON.stringify(
            {
              framework,
              files: files.map((f) => ({
                path: f.outputPath,
                domain: f.domain,
                scenarios: f.scenarios.length,
                content: f.content,
              })),
              summary: writeResult,
            },
            null,
            2
          )
        );
      } else {
        displayGenerationSummary(
          files,
          writeResult.written,
          writeResult.skipped,
          writeResult.merged,
          isDryRun
        );

        if (isDryRun) {
          if (writeResult.dryRunPreview) {
            for (const line of writeResult.dryRunPreview) {
              console.log(line);
            }
          }
        }

        const duration = Date.now() - startTime;
        logger.info('Duration', formatDuration(duration));

        if (!isDryRun) {
          logger.success(
            `Generated ${files.length} test file${files.length !== 1 ? 's' : ''} ` +
            `in ${outputDir}/`
          );
          if (!quiet) {
            logger.discovery(`Run "spec-gen test --coverage" to check spec test coverage.`);
          }
        }
      }

      if (llm) {
        const usage = llm.getTokenUsage();
        if (!isJson && verbose && usage.requests > 0) {
          logger.info('LLM calls', usage.requests);
          logger.info('Tokens used', `${usage.totalTokens}`);
        }
        await llm.saveLogs().catch(() => {});
      }
    } catch (err) {
      logger.error(`Test generation failed: ${(err as Error).message}`);
      if (process.env.DEBUG) console.error(err);
      process.exitCode = 1;
    }
  });
