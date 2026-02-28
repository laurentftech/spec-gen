/**
 * spec-gen verify — programmatic API
 *
 * Tests generated spec accuracy against actual source code.
 * No side effects (no process.exit, no console.log).
 */

import { join } from 'node:path';
import { access, readFile } from 'node:fs/promises';
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

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
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
  const threshold = options.threshold ?? 0.7;
  const { onProgress } = options;

  // Load config
  const specGenConfig = await readSpecGenConfig(rootPath);
  if (!specGenConfig) {
    throw new Error('No spec-gen configuration found. Run specGenInit() first.');
  }

  // Check specs exist
  const openspecPath = join(rootPath, specGenConfig.openspecPath ?? 'openspec');
  const specsPath = join(openspecPath, 'specs');
  if (!(await fileExists(specsPath))) {
    throw new Error('No specs found. Run specGenGenerate() first.');
  }

  // Load dependency graph
  progress(onProgress, 'Loading analysis', 'start');
  const analysisPath = join(rootPath, '.spec-gen', 'analysis');
  const depGraphPath = join(analysisPath, 'dependency-graph.json');
  if (!(await fileExists(depGraphPath))) {
    throw new Error('No analysis found. Run specGenAnalyze() first.');
  }
  const depGraphContent = await readFile(depGraphPath, 'utf-8');
  const depGraph = JSON.parse(depGraphContent) as DependencyGraphResult;

  // Load generation report
  let generationContext: string[] = [];
  const reportPath = join(rootPath, '.spec-gen', 'outputs', 'generation-report.json');
  if (await fileExists(reportPath)) {
    const reportContent = await readFile(reportPath, 'utf-8');
    const genReport = JSON.parse(reportContent) as GenerationReport;
    generationContext = genReport.filesWritten ?? [];
  }
  progress(onProgress, 'Loading analysis', 'complete');

  // Create LLM service
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!anthropicKey && !openaiKey) {
    throw new Error('No LLM API key found. Set ANTHROPIC_API_KEY or OPENAI_API_KEY.');
  }

  const provider = options.provider ?? (anthropicKey ? 'anthropic' : 'openai');
  let llm: LLMService;
  try {
    llm = createLLMService({
      provider,
      model: options.model,
      apiBase: options.apiBase ?? specGenConfig.llm?.apiBase,
      sslVerify: options.sslVerify ?? specGenConfig.llm?.sslVerify ?? true,
      enableLogging: true,
      logDir: join(rootPath, '.spec-gen', 'logs'),
    });
  } catch (error) {
    throw new Error(`Failed to create LLM service: ${(error as Error).message}`);
  }

  // Run verification
  progress(onProgress, 'Selecting verification files', 'start');
  const verificationDir = join(rootPath, '.spec-gen', 'verification');
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
