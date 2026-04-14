/**
 * spec-gen verify command
 *
 * Tests generated spec accuracy against actual source code.
 * Samples files and validates that specs accurately describe behavior.
 */

import { Command } from 'commander';
import { join } from 'node:path';
import { logger } from '../../utils/logger.js';
import { fileExists, formatDuration, parseList, readJsonFile, resolveLLMProvider } from '../../utils/command-helpers.js';
import {
  SPEC_GEN_DIR,
  SPEC_GEN_ANALYSIS_SUBDIR,
  SPEC_GEN_LOGS_SUBDIR,
  SPEC_GEN_VERIFICATION_SUBDIR,
  SPEC_GEN_OUTPUTS_SUBDIR,
  SPEC_GEN_CONFIG_REL_PATH,
  OPENSPEC_DIR,
  OPENSPEC_SPECS_SUBDIR,
  ARTIFACT_DEPENDENCY_GRAPH,
  ARTIFACT_GENERATION_REPORT,
} from '../../constants.js';
import type { VerifyOptions } from '../../types/index.js';
import { readSpecGenConfig } from '../../core/services/config-manager.js';
import { createLLMService, type LLMService } from '../../core/services/llm-service.js';
import {
  SpecVerificationEngine,
  type VerificationReport,
  type VerificationResult,
} from '../../core/verifier/verification-engine.js';
import type { DependencyGraphResult } from '../../core/analyzer/dependency-graph.js';
import type { GenerationReport } from '../../core/generator/openspec-writer.js';

// ============================================================================
// TYPES
// ============================================================================

interface ExtendedVerifyOptions extends VerifyOptions {
  files?: string[];
  domains?: string[];
  json?: boolean;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Format score as bar
 */
function formatScoreBar(score: number, width: number = 10): string {
  const filled = Math.round(score * width);
  const empty = width - filled;
  return '■'.repeat(filled) + '□'.repeat(empty);
}

/**
 * Get status emoji based on score
 */
function getStatusEmoji(score: number, threshold: number): string {
  if (score >= threshold) return '✓';
  if (score >= threshold * 0.8) return '⚠';
  return '✗';
}

/**
 * Load dependency graph from analysis
 */
async function loadDependencyGraph(analysisPath: string): Promise<DependencyGraphResult | null> {
  try {
    return await readJsonFile<DependencyGraphResult>(
      join(analysisPath, ARTIFACT_DEPENDENCY_GRAPH),
      ARTIFACT_DEPENDENCY_GRAPH,
    );
  } catch {
    return null;
  }
}

/**
 * Load generation report
 */
async function loadGenerationReport(rootPath: string): Promise<GenerationReport | null> {
  try {
    return await readJsonFile<GenerationReport>(
      join(rootPath, SPEC_GEN_DIR, SPEC_GEN_OUTPUTS_SUBDIR, ARTIFACT_GENERATION_REPORT),
      ARTIFACT_GENERATION_REPORT,
    );
  } catch {
    return null;
  }
}

/**
 * Display individual verification result
 */
function displayResult(
  result: VerificationResult,
  index: number,
  total: number,
  threshold: number,
  verbose: boolean
): void {
  const status = getStatusEmoji(result.overallScore, threshold);
  console.log('');
  console.log(`   [${index}/${total}] ${result.filePath}`);

  // Purpose match
  const purposeStatus = result.purposeMatch.similarity >= 0.5 ? '✓' : '⚠';
  console.log(`         Purpose: ${purposeStatus} ${result.purposeMatch.similarity >= 0.5 ? 'Correctly identified' : 'Partially matched'}`);

  // Import match
  const importPercent = (result.importMatch.f1Score * 100).toFixed(0);
  console.log(`         Imports: ${result.importMatch.predicted.length}/${result.importMatch.actual.length} predicted (${importPercent}%)`);

  // Export match
  const exportPercent = (result.exportMatch.f1Score * 100).toFixed(0);
  console.log(`         Exports: ${result.exportMatch.predicted.length}/${result.exportMatch.actual.length} predicted (${exportPercent}%)`);

  // Requirement coverage
  if (result.requirementCoverage.relatedRequirements.length > 0) {
    const reqMatches = result.requirementCoverage.actuallyImplements.join(', ') || 'None';
    console.log(`         Requirements: ${reqMatches}`);
  } else {
    console.log(`         Requirements: Not in specs`);
  }

  // Overall score
  console.log(`         Score: ${(result.overallScore).toFixed(2)} ${status}`);

  // Verbose output
  if (verbose && result.feedback.length > 0) {
    console.log('         Feedback:');
    for (const fb of result.feedback) {
      console.log(`           - ${fb}`);
    }
  }
}

/**
 * Display verification summary
 */
function displaySummary(report: VerificationReport, _threshold: number): void {
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
  console.log('📊 Verification Results');
  console.log('');

  const confidencePercent = (report.overallConfidence * 100).toFixed(0);
  const passedPercent = report.sampledFiles > 0
    ? ((report.passedFiles / report.sampledFiles) * 100).toFixed(0)
    : '0';

  console.log(`   Overall Confidence: ${confidencePercent}%`);
  console.log(`   Passed: ${report.passedFiles}/${report.sampledFiles} files (${passedPercent}%)`);
  console.log('');

  // Domain accuracy
  if (report.domainBreakdown.length > 0) {
    console.log('   Domain Accuracy:');
    for (let i = 0; i < report.domainBreakdown.length; i++) {
      const domain = report.domainBreakdown[i];
      const scorePercent = (domain.averageScore * 100).toFixed(0);
      const bar = formatScoreBar(domain.averageScore);
      const prefix = i === report.domainBreakdown.length - 1 ? '└─' : '├─';
      const paddedName = `${domain.domain}/spec.md:`.padEnd(20);
      console.log(`   ${prefix} ${paddedName} ${scorePercent}% ${bar}`);
    }
    console.log('');
  }

  // Identified gaps
  if (report.commonGaps.length > 0) {
    console.log('⚠️ Identified Gaps:');
    for (let i = 0; i < report.commonGaps.length; i++) {
      console.log(`   ${i + 1}. ${report.commonGaps[i]}`);
    }
    console.log('');
  }

  // Suggested improvements
  if (report.suggestedImprovements.length > 0) {
    for (const improvement of report.suggestedImprovements) {
      console.log(`   ${improvement.domain}: ${improvement.issue}`);
      console.log(`      → ${improvement.suggestion}`);
    }
    console.log('');
  }

  // Recommendation
  let recommendationIcon = '✅';
  let recommendationText = 'READY';
  let recommendationDetail = 'Specifications accurately describe the codebase.';

  if (report.recommendation === 'needs-review') {
    recommendationIcon = '⚠️';
    recommendationText = 'NEEDS REVIEW';
    recommendationDetail = 'The specs cover core functionality but may miss some areas.';
  } else if (report.recommendation === 'regenerate') {
    recommendationIcon = '❌';
    recommendationText = 'REGENERATE';
    recommendationDetail = 'Specs have significant gaps. Consider regenerating with improved context.';
  }

  console.log(`📝 Recommendation: ${recommendationIcon} ${recommendationText}`);
  console.log(`   ${recommendationDetail}`);
  console.log('');
  console.log(`   Full report: ${SPEC_GEN_DIR}/${SPEC_GEN_VERIFICATION_SUBDIR}/REPORT.md`);
  console.log('');
}

// ============================================================================
// COMMAND
// ============================================================================

export const verifyCommand = new Command('verify')
  .description('Verify generated specs against actual source code')
  .option(
    '--samples <n>',
    'Number of files to sample for verification',
    '5'
  )
  .option(
    '--threshold <0-1>',
    'Minimum confidence score to pass verification',
    '0.7'
  )
  .option(
    '--files <paths>',
    'Specific files to verify (comma-separated)',
    parseList
  )
  .option(
    '--domains <list>',
    'Only verify specific domains',
    parseList
  )
  .option(
    '--verbose',
    'Show detailed prediction vs actual comparison',
    false
  )
  .option(
    '--json',
    'Output results as JSON only',
    false
  )
  .addHelpText(
    'after',
    `
Examples:
  $ spec-gen verify                  Verify with defaults (5 samples, 0.7 threshold)
  $ spec-gen verify --samples 10     Sample more files for higher confidence
  $ spec-gen verify --threshold 0.8  Require higher accuracy
  $ spec-gen verify --verbose        Show detailed comparisons
  $ spec-gen verify --domains user,order
                                     Only verify specific domains
  $ spec-gen verify --json           Output JSON for automation

Verification process:
  1. Loads generated specs from openspec/specs/
  2. Selects verification files NOT used in generation
  3. For each file, asks LLM to predict behavior from specs
  4. Compares predictions against actual code
  5. Reports accuracy score and identifies gaps

Output:
  - Overall confidence score (0.0 - 1.0)
  - Per-domain accuracy breakdown
  - List of files with prediction mismatches
  - Suggestions for spec improvements

A score >= threshold indicates specs are production-ready.
`
  )
  .action(async function (this: Command, options: Partial<ExtendedVerifyOptions>) {
    const startTime = Date.now();
    const rootPath = process.cwd();

    // Inherit global options (--api-base, --insecure, etc.)
    const globalOpts = this.optsWithGlobals?.() ?? {};

    const opts: ExtendedVerifyOptions = {
      samples: typeof options.samples === 'string'
        ? parseInt(options.samples, 10)
        : options.samples ?? 5,
      threshold: typeof options.threshold === 'string'
        ? parseFloat(options.threshold)
        : options.threshold ?? 0.7,
      files: options.files ?? [],
      domains: options.domains ?? [],
      verbose: options.verbose ?? false,
      json: options.json ?? false,
      quiet: false,
      noColor: false,
      config: SPEC_GEN_CONFIG_REL_PATH,
    };

    if (isNaN(opts.samples) || opts.samples < 1) {
      logger.error('--samples must be a positive integer');
      process.exitCode = 1;
      return;
    }

    // Validate threshold range
    if (isNaN(opts.threshold) || opts.threshold < 0 || opts.threshold > 1) {
      logger.error('Threshold must be a number between 0 and 1');
      process.exitCode = 1;
      return;
    }

    try {
      // ========================================================================
      // PHASE 1: VALIDATION
      // ========================================================================
      if (!opts.json) {
        logger.section('Verifying Specifications');
      }

      // Load spec-gen config
      const specGenConfig = await readSpecGenConfig(rootPath);
      if (!specGenConfig) {
        logger.error('No spec-gen configuration found. Run "spec-gen init" first.');
        process.exitCode = 1;
        return;
      }

      // Determine openspec path
      const openspecPath = join(rootPath, specGenConfig.openspecPath ?? OPENSPEC_DIR);
      const specsPath = join(openspecPath, OPENSPEC_SPECS_SUBDIR);

      // Check if specs exist
      if (!(await fileExists(specsPath))) {
        logger.error('No specs found. Run "spec-gen generate" first.');
        process.exitCode = 1;
        return;
      }

      if (!opts.json) {
        logger.discovery(`Loading generated specs from ${specGenConfig.openspecPath}/specs/`);
      }

      // Load generation report to get context files
      const generationReport = await loadGenerationReport(rootPath);
      const generationContext = generationReport?.filesWritten ?? [];

      // Load dependency graph
      const analysisPath = join(rootPath, SPEC_GEN_DIR, SPEC_GEN_ANALYSIS_SUBDIR);
      const depGraph = await loadDependencyGraph(analysisPath);

      if (!depGraph) {
        logger.error('No analysis found. Run "spec-gen analyze" first.');
        process.exitCode = 1;
        return;
      }

      if (!opts.json) {
        logger.info('Files in analysis', depGraph.nodes.length);
        logger.blank();
      }

      // ========================================================================
      // PHASE 2: CHECK LLM API
      // ========================================================================
      const resolved = resolveLLMProvider(specGenConfig);
      if (!resolved) {
        logger.error('No LLM API key found.');
        logger.discovery('Set ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, or OPENAI_COMPAT_API_KEY + OPENAI_COMPAT_BASE_URL.');
        process.exitCode = 1;
        return;
      }

      let llm: LLMService;
      try {
        llm = createLLMService({
          provider: resolved.provider,
          model: specGenConfig.generation?.model,
          openaiCompatBaseUrl: resolved.openaiCompatBaseUrl,
          apiBase: globalOpts.apiBase ?? specGenConfig.llm?.apiBase,
          sslVerify: globalOpts.insecure != null ? !globalOpts.insecure : specGenConfig.llm?.sslVerify ?? true,
          timeout: globalOpts.timeout ?? specGenConfig.generation?.timeout,
          enableLogging: true,
          logDir: join(rootPath, SPEC_GEN_DIR, SPEC_GEN_LOGS_SUBDIR),
        });
      } catch (error) {
        logger.error(`Failed to create LLM service: ${(error as Error).message}`);
        process.exitCode = 1;
        return;
      }

      // ========================================================================
      // PHASE 3: RUN VERIFICATION
      // ========================================================================
      const verificationDir = join(rootPath, SPEC_GEN_DIR, SPEC_GEN_VERIFICATION_SUBDIR);

      const engine = new SpecVerificationEngine(llm, {
        rootPath,
        openspecPath,
        outputDir: verificationDir,
        filesPerDomain: Math.ceil(opts.samples / 4), // Distribute across domains
        passThreshold: opts.threshold,
        generationContext,
      });

      if (!opts.json) {
        logger.analysis(`Selecting verification files (${opts.samples} samples)...`);
        logger.blank();
      }

      // Get candidates first to show selection
      const candidates = engine.selectCandidates(depGraph);

      if (candidates.length === 0) {
        logger.error('No suitable verification candidates found.');
        logger.discovery('Try running with a lower --samples value or check that analysis includes non-test files.');
        process.exitCode = 1;
        return;
      }

      // Limit to requested sample size
      const selectedCandidates = candidates.slice(0, opts.samples);

      if (!opts.json) {
        logger.discovery(`Files selected for verification:`);
        for (let i = 0; i < selectedCandidates.length; i++) {
          const c = selectedCandidates[i];
          logger.listItem(`${c.path} (${c.domain} domain)`);
        }
        logger.blank();

        logger.analysis('Verifying specs against codebase...');
      }

      // Run verification
      let report: VerificationReport;
      try {
        report = await engine.verify(depGraph, specGenConfig.version);
      } catch (error) {
        logger.error(`Verification failed: ${(error as Error).message}`);
        process.exitCode = 1;
        return;
      }

      // ========================================================================
      // PHASE 4: DISPLAY RESULTS
      // ========================================================================
      if (opts.json) {
        // JSON-only output
        console.log(JSON.stringify(report, null, 2));
      } else {
        // Display individual results
        for (let i = 0; i < report.results.length; i++) {
          displayResult(report.results[i], i + 1, report.results.length, opts.threshold, opts.verbose ?? false);
        }

        // Display summary
        displaySummary(report, opts.threshold);

        // Final status
        const duration = Date.now() - startTime;
        logger.info('Total time', formatDuration(duration));
        logger.blank();

        // Exit status based on recommendation
        if (report.recommendation === 'regenerate') {
          process.exitCode = 1;
        } else if (report.recommendation === 'needs-review') {
          process.exitCode = 0; // Warning but not failure
        } else {
          logger.success('Verification passed!');
        }
      }

      // Save LLM logs
      try {
        await llm.saveLogs();
      } catch {
        // Ignore log save errors
      }

    } catch (error) {
      logger.error(`Verify failed: ${(error as Error).message}`);
      if (process.env.DEBUG) {
        console.error(error);
      }
      process.exitCode = 1;
    }
  });
