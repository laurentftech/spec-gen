/**
 * spec-gen drift — programmatic API
 *
 * Detects spec drift: finds code changes not reflected in specs.
 * No side effects (no process.exit, no console.log).
 */

import { join } from 'node:path';
import { access } from 'node:fs/promises';
import { readSpecGenConfig } from '../core/services/config-manager.js';
import {
  getChangedFiles,
  isGitRepository,
  buildSpecMap,
  buildADRMap,
  detectDrift,
} from '../core/drift/index.js';
import { createLLMService } from '../core/services/llm-service.js';
import type { LLMService } from '../core/services/llm-service.js';
import type { DriftResult } from '../types/index.js';
import type { DriftApiOptions, ProgressCallback } from './types.js';

function progress(onProgress: ProgressCallback | undefined, step: string, status: 'start' | 'progress' | 'complete' | 'skip', detail?: string): void {
  onProgress?.({ phase: 'drift', step, status, detail });
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
 * Detect spec drift in a project.
 *
 * Compares code changes against existing OpenSpec specifications
 * and reports gaps, stale specs, uncovered files, and orphaned specs.
 *
 * @throws Error if not a git repository
 * @throws Error if no spec-gen configuration found
 * @throws Error if no specs found
 * @throws Error if LLM enhanced mode requested but no API key
 */
export async function specGenDrift(options: DriftApiOptions = {}): Promise<DriftResult> {
  const startTime = Date.now();
  const rootPath = options.rootPath ?? process.cwd();
  const baseRef = options.baseRef ?? 'auto';
  const files = options.files ?? [];
  const domains = options.domains ?? [];
  const llmEnhanced = options.llmEnhanced ?? false;
  const failOn = options.failOn ?? 'warning';
  const maxFiles = options.maxFiles ?? 100;
  const { onProgress } = options;

  // Validate git repo
  if (!(await isGitRepository(rootPath))) {
    throw new Error('Not a git repository. Drift detection requires git.');
  }

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

  // Create LLM service if needed
  let llm: LLMService | undefined;
  if (llmEnhanced) {
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!anthropicKey && !openaiKey) {
      throw new Error('No LLM API key found. LLM-enhanced drift requires ANTHROPIC_API_KEY or OPENAI_API_KEY.');
    }
    const provider = options.provider ?? (anthropicKey ? 'anthropic' : 'openai');
    llm = createLLMService({
      provider,
      apiBase: options.apiBase ?? specGenConfig.llm?.apiBase,
      sslVerify: options.sslVerify ?? specGenConfig.llm?.sslVerify ?? true,
      enableLogging: true,
      logDir: join(rootPath, '.spec-gen', 'logs'),
    });
  }

  // Get changed files
  progress(onProgress, 'Analyzing git changes', 'start');
  const gitResult = await getChangedFiles({
    rootPath,
    baseRef,
    pathFilter: files.length > 0 ? files : undefined,
    includeUnstaged: true,
  });
  progress(onProgress, 'Analyzing git changes', 'complete', `${gitResult.files.length} changed files`);

  if (gitResult.files.length === 0) {
    return {
      timestamp: new Date().toISOString(),
      baseRef: gitResult.resolvedBase,
      totalChangedFiles: 0,
      specRelevantFiles: 0,
      issues: [],
      summary: { gaps: 0, stale: 0, uncovered: 0, orphanedSpecs: 0, adrGaps: 0, adrOrphaned: 0, total: 0 },
      hasDrift: false,
      duration: Date.now() - startTime,
      mode: 'static',
    };
  }

  // Apply max-files limit
  const actualChangedFiles = gitResult.files.length;
  if (gitResult.files.length > maxFiles) {
    gitResult.files = gitResult.files.slice(0, maxFiles);
  }

  // Build spec map
  progress(onProgress, 'Loading spec mappings', 'start');
  const repoStructurePath = join(rootPath, '.spec-gen', 'analysis', 'repo-structure.json');
  const hasRepoStructure = await fileExists(repoStructurePath);

  const specMap = await buildSpecMap({
    rootPath,
    openspecPath,
    repoStructurePath: hasRepoStructure ? repoStructurePath : undefined,
  });

  // Build ADR map
  const adrMap = await buildADRMap({
    rootPath,
    openspecPath,
    repoStructurePath: hasRepoStructure ? repoStructurePath : undefined,
  });
  progress(onProgress, 'Loading spec mappings', 'complete', `${specMap.domainCount} domains`);

  // Detect drift
  progress(onProgress, 'Detecting drift', 'start');
  const result = await detectDrift({
    rootPath,
    specMap,
    changedFiles: gitResult.files,
    failOn,
    domainFilter: domains.length > 0 ? domains : undefined,
    openspecRelPath: specGenConfig.openspecPath ?? 'openspec',
    llm,
    baseRef: gitResult.resolvedBase,
    adrMap: adrMap ?? undefined,
  });

  result.baseRef = gitResult.resolvedBase;
  result.totalChangedFiles = actualChangedFiles;
  progress(onProgress, 'Detecting drift', 'complete', `${result.summary.total} issues`);

  // Save LLM logs if applicable
  if (llm) {
    try { await llm.saveLogs(); } catch { /* best-effort */ }
  }

  return result;
}
