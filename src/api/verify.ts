/**
 * spec-gen verify — programmatic API
 *
 * Tests generated spec accuracy against actual source code.
 * No side effects (no process.exit, no console.log).
 */

import { join } from 'node:path';
import { SPEC_GEN_DIR, SPEC_GEN_ANALYSIS_SUBDIR, SPEC_GEN_LOGS_SUBDIR, SPEC_GEN_OUTPUTS_SUBDIR, SPEC_GEN_VERIFICATION_SUBDIR, OPENSPEC_DIR, OPENSPEC_SPECS_SUBDIR, ARTIFACT_DEPENDENCY_GRAPH, ARTIFACT_GENERATION_REPORT, DEFAULT_ANTHROPIC_MODEL, DEFAULT_OPENAI_MODEL, DEFAULT_GEMINI_MODEL, DEFAULT_OPENAI_COMPAT_MODEL } from '../constants.js';
import { fileExists, readJsonFile } from '../utils/command-helpers.js';
import { readSpecGenConfig } from '../core/services/config-manager.js';
import { createLLMService } from '../core/services/llm-service.js';
import type { LLMService } from '../core/services/llm-service.js';
import { SpecVerificationEngine } from '../core/verifier/verification-engine.js';
import type { DependencyGraphResult } from '../core/analyzer/dependency-graph.js';
import type { GenerationReport } from '../core/generator/openspec-writer.js';
import type { VerifyApiOptions, VerifyResult, ProgressCallback } from './types.js';

function progress(onProgress: ProgressCallback | undefined, step: string, status: 'start' | 'progress' | 'complete' | 'skip', detail?: string): void {
  onProgress?.({ phase: 'verify', step, status, detail });
}

/**
 * Verify generated specs against actual source code.
 *
 * Samples files and validates that specs accurately describe behavior
 * using an LLM to predict behavior from specs and compare against code.
 *
 * @throws Error if no spec-gen configuration found
 * @throws Error if no specs or analysis found
 * @throws Error if no LLM API key found
 * @throws Error if no verification candidates found
 */
export async function specGenVerify(options: VerifyApiOptions = {}): Promise<VerifyResult> {
  const startTime = Date.now();
  const rootPath = options.rootPath ?? process.cwd();
  const samples = options.samples ?? 5;
  const threshold = options.threshold ?? 0.5;
  const { onProgress } = options;

  // Load config
  const specGenConfig = await readSpecGenConfig(rootPath);
  if (!specGenConfig) {
    throw new Error('No spec-gen configuration found. Run specGenInit() first.');
  }

  // Check specs exist
  const openspecPath = join(rootPath, specGenConfig.openspecPath ?? OPENSPEC_DIR);
  const specsPath = join(openspecPath, OPENSPEC_SPECS_SUBDIR);
  if (!(await fileExists(specsPath))) {
    throw new Error('No specs found. Run specGenGenerate() first.');
  }

  // Load dependency graph
  progress(onProgress, 'Loading analysis', 'start');
  const analysisPath = join(rootPath, SPEC_GEN_DIR, SPEC_GEN_ANALYSIS_SUBDIR);
  const depGraph = await readJsonFile<DependencyGraphResult>(
    join(analysisPath, ARTIFACT_DEPENDENCY_GRAPH),
    ARTIFACT_DEPENDENCY_GRAPH,
  );
  if (!depGraph) {
    throw new Error('No analysis found. Run specGenAnalyze() first.');
  }

  // Load generation report
  const genReport = await readJsonFile<GenerationReport>(
    join(rootPath, SPEC_GEN_DIR, SPEC_GEN_OUTPUTS_SUBDIR, ARTIFACT_GENERATION_REPORT),
    ARTIFACT_GENERATION_REPORT,
  );
  const generationContext: string[] = genReport?.filesWritten ?? [];
  progress(onProgress, 'Loading analysis', 'complete');

  // Create LLM service — support all four providers
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const openaiCompatKey = process.env.OPENAI_COMPAT_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!anthropicKey && !openaiKey && !openaiCompatKey && !geminiKey) {
    throw new Error('No LLM API key found. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, or OPENAI_COMPAT_API_KEY.');
  }

  const envDetectedProvider = anthropicKey ? 'anthropic'
    : geminiKey ? 'gemini'
    : openaiCompatKey ? 'openai-compat'
    : 'openai';
  const provider = options.provider ?? envDetectedProvider;
  const defaultModels: Record<string, string> = {
    anthropic: DEFAULT_ANTHROPIC_MODEL,
    gemini: DEFAULT_GEMINI_MODEL,
    'openai-compat': DEFAULT_OPENAI_COMPAT_MODEL,
    openai: DEFAULT_OPENAI_MODEL,
  };
  const effectiveModel = options.model ?? defaultModels[provider] ?? DEFAULT_ANTHROPIC_MODEL;
  let llm: LLMService;
  try {
    llm = createLLMService({
      provider,
      model: effectiveModel,
      apiBase: options.apiBase ?? specGenConfig.llm?.apiBase,
      sslVerify: options.sslVerify ?? specGenConfig.llm?.sslVerify ?? true,
      openaiCompatBaseUrl: options.openaiCompatBaseUrl,
      timeout: options.timeout ?? specGenConfig.generation?.timeout,
      enableLogging: true,
      logDir: join(rootPath, SPEC_GEN_DIR, SPEC_GEN_LOGS_SUBDIR),
    });
  } catch (error) {
    throw new Error(`Failed to create LLM service: ${(error as Error).message}`);
  }

  // Run verification
  progress(onProgress, 'Selecting verification files', 'start');
  const verificationDir = join(rootPath, SPEC_GEN_DIR, SPEC_GEN_VERIFICATION_SUBDIR);
  const engine = new SpecVerificationEngine(llm, {
    rootPath,
    openspecPath,
    outputDir: verificationDir,
    filesPerDomain: Math.ceil(samples / 4),
    passThreshold: threshold,
    generationContext,
  });

  const candidates = engine.selectCandidates(depGraph);
  if (candidates.length === 0) {
    throw new Error('No suitable verification candidates found.');
  }
  progress(onProgress, 'Selecting verification files', 'complete', `${Math.min(candidates.length, samples)} candidates`);

  progress(onProgress, 'Verifying specs against codebase', 'start');
  const report = await engine.verify(depGraph, specGenConfig.version);
  progress(onProgress, 'Verifying specs against codebase', 'complete', `${(report.overallConfidence * 100).toFixed(0)}% confidence`);

  // Save LLM logs
  await llm.saveLogs().catch(() => {});

  return {
    report,
    duration: Date.now() - startTime,
  };
}
