/**
 * MCP tool handlers for codebase analysis:
 * analyze_codebase, get_architecture_overview, get_refactor_report,
 * get_duplicate_report, get_signatures, get_mapping, check_spec_drift,
 * get_function_skeleton, get_god_functions.
 */

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { runAnalysis } from '../../../cli/commands/analyze.js';
import { analyzeForRefactoring } from '../../analyzer/refactor-analyzer.js';
import { formatSignatureMaps } from '../../analyzer/signature-extractor.js';
import { getSkeletonContent, detectLanguage, isSkeletonWorthIncluding } from '../../analyzer/code-shaper.js';
import { buildArchitectureOverview } from '../../analyzer/architecture-writer.js';
import {
  isGitRepository,
  getChangedFiles,
  buildSpecMap,
  buildADRMap,
  detectDrift,
} from '../../drift/index.js';
import { readSpecGenConfig } from '../config-manager.js';
import { validateDirectory, readCachedContext, isCacheFresh } from './utils.js';
import type { SerializedCallGraph } from '../../analyzer/call-graph.js';
import type { MappingArtifact } from '../../generator/mapping-generator.js';
import type { DriftResult } from '../../../types/index.js';

// ============================================================================
// HANDLERS
// ============================================================================

/**
 * Run a full static analysis pass on `directory` and return a compact summary.
 */
export async function handleAnalyzeCodebase(
  directory: string,
  force: boolean
): Promise<Record<string, unknown>> {
  const absDir = await validateDirectory(directory);
  const outputPath = join(absDir, '.spec-gen', 'analysis');

  if (!force && await isCacheFresh(absDir)) {
    const ctx = await readCachedContext(absDir);
    if (ctx) {
      const cg = ctx.callGraph;
      const topRefactorIssues = cg
        ? analyzeForRefactoring(cg as SerializedCallGraph).priorities.slice(0, 10).map(e => ({
            function: e.function, file: e.file, issues: e.issues, priorityScore: e.priorityScore,
          }))
        : [];
      return {
        cached: true,
        callGraph: cg
          ? { totalNodes: cg.stats.totalNodes, totalEdges: cg.stats.totalEdges,
              hubs: cg.hubFunctions.length, entryPoints: cg.entryPoints.length,
              layerViolations: cg.layerViolations.length }
          : null,
        topRefactorIssues,
        analysisPath: join('.spec-gen', 'analysis'),
      };
    }
  }

  const result = await runAnalysis(absDir, outputPath, {
    maxFiles: 500,
    include: [],
    exclude: [],
  });

  const { artifacts, repoMap, depGraph } = result;
  const rs = artifacts.repoStructure;
  const cg = artifacts.llmContext.callGraph;

  let topRefactorIssues: unknown[] = [];
  if (cg) {
    const report = analyzeForRefactoring(cg as SerializedCallGraph);
    topRefactorIssues = report.priorities.slice(0, 10).map(e => ({
      function: e.function,
      file: e.file,
      issues: e.issues,
      priorityScore: e.priorityScore,
    }));
  }

  return {
    projectName: rs.projectName,
    projectType: rs.projectType,
    frameworks: rs.frameworks,
    architecture: rs.architecture.pattern,
    stats: {
      files: repoMap.summary.totalFiles,
      analyzedFiles: repoMap.summary.analyzedFiles,
      depNodes: depGraph.statistics.nodeCount,
      depEdges: depGraph.statistics.edgeCount,
      cycles: depGraph.statistics.cycleCount,
    },
    callGraph: cg
      ? {
          totalNodes: cg.stats.totalNodes,
          totalEdges: cg.stats.totalEdges,
          hubs: cg.hubFunctions.length,
          entryPoints: cg.entryPoints.length,
          layerViolations: cg.layerViolations.length,
        }
      : null,
    domains: rs.domains.map((d: { name: string }) => d.name),
    topRefactorIssues,
    analysisPath: join('.spec-gen', 'analysis'),
  };
}

/**
 * High-level architecture map: clusters, cross-cluster deps, entry points, hubs.
 */
export async function handleGetArchitectureOverview(directory: string): Promise<unknown> {
  const absDir = await validateDirectory(directory);

  let depGraph: import('../../analyzer/dependency-graph.js').DependencyGraphResult | null = null;
  try {
    const raw = await readFile(join(absDir, '.spec-gen', 'analysis', 'dependency-graph.json'), 'utf-8');
    depGraph = JSON.parse(raw) as import('../../analyzer/dependency-graph.js').DependencyGraphResult;
  } catch { /* ignore */ }

  const ctx = await readCachedContext(absDir);

  if (!depGraph && !ctx) {
    return { error: 'No analysis found. Run analyze_codebase first.' };
  }

  const overview = buildArchitectureOverview(depGraph, ctx, absDir);
  return {
    summary: overview.summary,
    clusters: overview.clusters,
    globalEntryPoints: overview.globalEntryPoints,
    criticalHubs: overview.criticalHubs,
  };
}

/**
 * Return a prioritized refactor report from cached analysis.
 */
export async function handleGetRefactorReport(directory: string): Promise<unknown> {
  const absDir = await validateDirectory(directory);
  const ctx = await readCachedContext(absDir);

  if (!ctx) return { error: 'No analysis found. Run analyze_codebase first.' };
  if (!ctx.callGraph) return { error: 'Call graph not available in cached analysis. Re-run analyze_codebase.' };

  return analyzeForRefactoring(ctx.callGraph as SerializedCallGraph);
}

/**
 * Read the cached duplicate detection result.
 */
export async function handleGetDuplicateReport(directory: string): Promise<unknown> {
  const absDir = await validateDirectory(directory);
  const cachePath = join(absDir, '.spec-gen', 'analysis', 'duplicates.json');

  let raw: string;
  try {
    raw = await readFile(cachePath, 'utf-8');
  } catch {
    return {
      error:
        'No duplicate report found. Run analyze_codebase first ' +
        '(duplicates.json is generated during analysis).',
    };
  }

  try {
    return JSON.parse(raw);
  } catch {
    return { error: 'Duplicate report cache is corrupted. Re-run analyze_codebase.' };
  }
}

/**
 * Return compact function and class signatures for files in the project.
 */
export async function handleGetSignatures(directory: string, filePattern?: string): Promise<string> {
  const absDir = await validateDirectory(directory);
  const ctx = await readCachedContext(absDir);

  if (!ctx) return 'No analysis found. Run analyze_codebase first.';
  if (!ctx.signatures || ctx.signatures.length === 0) {
    return 'No signatures available in cached analysis. Re-run analyze_codebase.';
  }

  const filtered = filePattern
    ? ctx.signatures.filter((s: { path: string }) => s.path.includes(filePattern))
    : ctx.signatures;

  if (filtered.length === 0) {
    return `No files matching pattern "${filePattern}" found in analysis.`;
  }

  const chunks = formatSignatureMaps(filtered);
  return chunks.join('\n\n---\n\n');
}

/**
 * Return the requirement→function mapping from mapping.json.
 */
export async function handleGetMapping(
  directory: string,
  domain?: string,
  orphansOnly?: boolean
): Promise<unknown> {
  const absDir = await validateDirectory(directory);
  let raw: string;
  try {
    raw = await readFile(join(absDir, '.spec-gen', 'analysis', 'mapping.json'), 'utf-8');
  } catch {
    return { error: 'No mapping found. Run spec-gen generate first.' };
  }

  const mapping = JSON.parse(raw) as MappingArtifact;

  if (orphansOnly) {
    const filtered = domain
      ? mapping.orphanFunctions.filter((f: { file: string }) => f.file.includes(domain))
      : mapping.orphanFunctions;
    return { generatedAt: mapping.generatedAt, stats: mapping.stats, orphanFunctions: filtered };
  }

  const filteredMappings = domain
    ? mapping.mappings.filter((m: { domain: string }) => m.domain === domain)
    : mapping.mappings;

  return {
    generatedAt: mapping.generatedAt,
    stats: mapping.stats,
    mappings: filteredMappings,
    orphanFunctions: domain ? [] : mapping.orphanFunctions,
  };
}

/**
 * Run spec-drift detection in static mode (no LLM).
 */
export async function handleCheckSpecDrift(
  directory: string,
  base = 'auto',
  files: string[] = [],
  domains: string[] = [],
  failOn: 'error' | 'warning' | 'info' = 'warning',
  maxFiles = 100
): Promise<DriftResult | { error: string }> {
  const absDir = await validateDirectory(directory);

  if (!(await isGitRepository(absDir))) {
    return { error: 'Not a git repository. Drift detection requires git.' };
  }

  const specGenConfig = await readSpecGenConfig(absDir);
  if (!specGenConfig) {
    return { error: 'No spec-gen configuration found. Run "spec-gen init" first.' };
  }

  const openspecPath = join(absDir, specGenConfig.openspecPath ?? 'openspec');
  const specsPath = join(openspecPath, 'specs');
  try {
    await stat(specsPath);
  } catch {
    return { error: 'No specs found. Run "spec-gen generate" first.' };
  }

  const startTime = Date.now();

  const gitResult = await getChangedFiles({
    rootPath: absDir,
    baseRef: base,
    pathFilter: files.length > 0 ? files : undefined,
    includeUnstaged: true,
  });

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

  const actualChangedFiles = gitResult.files.length;
  if (gitResult.files.length > maxFiles) {
    gitResult.files = gitResult.files.slice(0, maxFiles);
  }

  const repoStructurePath = join(absDir, '.spec-gen', 'analysis', 'repo-structure.json');
  let hasRepoStructure = false;
  try {
    await stat(repoStructurePath);
    hasRepoStructure = true;
  } catch { /* no prior analysis */ }

  const specMap = await buildSpecMap({
    rootPath: absDir,
    openspecPath,
    repoStructurePath: hasRepoStructure ? repoStructurePath : undefined,
  });

  const adrMap = await buildADRMap({
    rootPath: absDir,
    openspecPath,
    repoStructurePath: hasRepoStructure ? repoStructurePath : undefined,
  });

  const result = await detectDrift({
    rootPath: absDir,
    specMap,
    changedFiles: gitResult.files,
    failOn,
    domainFilter: domains.length > 0 ? domains : undefined,
    openspecRelPath: specGenConfig.openspecPath ?? 'openspec',
    baseRef: gitResult.resolvedBase,
    adrMap: adrMap ?? undefined,
  });

  result.baseRef = gitResult.resolvedBase;
  result.totalChangedFiles = actualChangedFiles;

  return result;
}

/**
 * Return a noise-stripped skeleton of a source file.
 */
export async function handleGetFunctionSkeleton(
  directory: string,
  filePath: string
): Promise<unknown> {
  const absDir = await validateDirectory(directory);
  const absFile = join(absDir, filePath);

  let source: string;
  try {
    source = await readFile(absFile, 'utf-8');
  } catch {
    return { error: `File not found: ${filePath}` };
  }

  const language = detectLanguage(filePath);
  const skeleton = getSkeletonContent(source, language);
  const worthIncluding = isSkeletonWorthIncluding(source, skeleton);

  return {
    filePath,
    language,
    originalLines: source.split('\n').length,
    skeletonLines: skeleton.split('\n').length,
    reductionPct: Math.round((1 - skeleton.length / source.length) * 100),
    worthIncluding,
    skeleton,
  };
}

// Note: handleGetGodFunctions lives in graph.ts (alongside other call-graph tools)
