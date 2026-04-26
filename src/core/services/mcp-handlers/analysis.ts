/**
 * MCP tool handlers for codebase analysis:
 * analyze_codebase, get_architecture_overview, get_refactor_report,
 * get_duplicate_report, get_signatures, get_mapping, check_spec_drift,
 * get_function_skeleton, get_god_functions, get_route_inventory,
 * get_middleware_inventory, get_schema_inventory, get_ui_components.
 */

import { readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  DEFAULT_MAX_FILES,
  DEFAULT_DRIFT_MAX_FILES,
  TOP_REFACTOR_ISSUES_LIMIT,
  SPEC_GEN_DIR,
  SPEC_GEN_ANALYSIS_SUBDIR,
  SPEC_GEN_ANALYSIS_REL_PATH,
  OPENSPEC_DIR,
  ARTIFACT_DEPENDENCY_GRAPH,
  ARTIFACT_MAPPING,
  ARTIFACT_REPO_STRUCTURE,
  ARTIFACT_ROUTE_INVENTORY,
  ARTIFACT_MIDDLEWARE_INVENTORY,
  ARTIFACT_SCHEMA_INVENTORY,
  ARTIFACT_UI_INVENTORY,
  ARTIFACT_ENV_INVENTORY,
} from '../../../constants.js';
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
import { validateDirectory, readCachedContext, isCacheFresh, safeJoin } from './utils.js';
import type { SerializedCallGraph } from '../../analyzer/call-graph.js';
import type { MappingArtifact } from '../../generator/mapping-generator.js';
import { specGenAudit } from '../../../api/audit.js';
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
  const outputPath = join(absDir, SPEC_GEN_DIR, SPEC_GEN_ANALYSIS_SUBDIR);

  if (!force && await isCacheFresh(absDir)) {
    const ctx = await readCachedContext(absDir);
    if (ctx) {
      const cg = ctx.callGraph;
      const topRefactorIssues = cg
        ? analyzeForRefactoring(cg as SerializedCallGraph).priorities.slice(0, TOP_REFACTOR_ISSUES_LIMIT).map(e => ({
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
        analysisPath: SPEC_GEN_ANALYSIS_REL_PATH,
      };
    }
  }

  const result = await runAnalysis(absDir, outputPath, {
    maxFiles: DEFAULT_MAX_FILES,
    include: [],
    exclude: [],
  });

  const { artifacts, repoMap, depGraph } = result;
  const rs = artifacts.repoStructure;
  const cg = artifacts.llmContext.callGraph;

  let topRefactorIssues: unknown[] = [];
  if (cg) {
    const report = analyzeForRefactoring(cg as SerializedCallGraph);
    topRefactorIssues = report.priorities.slice(0, TOP_REFACTOR_ISSUES_LIMIT).map(e => ({
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
      importEdges: depGraph.statistics.importEdgeCount,
      httpCrossEdges: depGraph.statistics.httpEdgeCount,
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
    analysisPath: SPEC_GEN_ANALYSIS_REL_PATH,
  };
}

/**
 * High-level architecture map: clusters, cross-cluster deps, entry points, hubs.
 */
export async function handleGetArchitectureOverview(directory: string): Promise<unknown> {
  const absDir = await validateDirectory(directory);

  let depGraph: import('../../analyzer/dependency-graph.js').DependencyGraphResult | null = null;
  try {
    const raw = await readFile(join(absDir, SPEC_GEN_DIR, SPEC_GEN_ANALYSIS_SUBDIR, ARTIFACT_DEPENDENCY_GRAPH), 'utf-8');
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
  const cachePath = join(absDir, SPEC_GEN_DIR, SPEC_GEN_ANALYSIS_SUBDIR, 'duplicates.json');

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
    raw = await readFile(join(absDir, SPEC_GEN_DIR, SPEC_GEN_ANALYSIS_SUBDIR, ARTIFACT_MAPPING), 'utf-8');
  } catch {
    return { error: 'No mapping found. Run spec-gen generate first.' };
  }

  let mapping: MappingArtifact;
  try {
    mapping = JSON.parse(raw) as MappingArtifact;
  } catch {
    return { error: 'Mapping file is corrupted. Re-run spec-gen generate.' };
  }

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
  maxFiles = DEFAULT_DRIFT_MAX_FILES
): Promise<DriftResult | { error: string }> {
  const absDir = await validateDirectory(directory);

  if (!(await isGitRepository(absDir))) {
    return { error: 'Not a git repository. Drift detection requires git.' };
  }

  const specGenConfig = await readSpecGenConfig(absDir);
  if (!specGenConfig) {
    return { error: 'No spec-gen configuration found. Run "spec-gen init" first.' };
  }

  const openspecPath = join(absDir, specGenConfig.openspecPath ?? OPENSPEC_DIR);
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

  const repoStructurePath = join(absDir, SPEC_GEN_DIR, SPEC_GEN_ANALYSIS_SUBDIR, ARTIFACT_REPO_STRUCTURE);
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
    openspecRelPath: specGenConfig.openspecPath ?? OPENSPEC_DIR,
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
  const absFile = safeJoin(absDir, filePath);

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

/**
 * Extract the exact source text of a named function using the cached call graph.
 *
 * Uses the startIndex/endIndex byte offsets recorded in llm-context.json to
 * slice the source file — no extra tree-sitter parsing needed at query time.
 * Falls back to a line-number scan when the call graph is unavailable.
 */
export async function handleGetFunctionBody(
  directory: string,
  filePath: string,
  functionName: string,
): Promise<unknown> {
  const absDir = await validateDirectory(directory);
  const absFile = safeJoin(absDir, filePath);

  let source: string;
  try {
    source = await readFile(absFile, 'utf-8');
  } catch {
    return { error: `File not found: ${filePath}` };
  }

  // Try call graph first: exact byte-range slice, no ambiguity
  const contextPath = join(absDir, '.spec-gen', 'analysis', 'llm-context.json');
  try {
    const raw = await readFile(contextPath, 'utf-8');
    const ctx = JSON.parse(raw) as { callGraph?: { nodes: Array<{ name: string; filePath: string; startIndex: number; endIndex: number; language: string; className?: string }> } };
    if (ctx.callGraph?.nodes) {
      const node = ctx.callGraph.nodes.find(
        n => n.name === functionName && (n.filePath === filePath || n.filePath.endsWith('/' + filePath.replace(/^\//, '')))
      );
      if (node && node.startIndex < node.endIndex) {
        const body = source.slice(node.startIndex, node.endIndex);
        return {
          functionName,
          filePath,
          language: node.language,
          className: node.className ?? null,
          startIndex: node.startIndex,
          endIndex: node.endIndex,
          body,
          lineCount: body.split('\n').length,
        };
      }
    }
  } catch { /* no call graph — fall through to line-scan */ }

  // Fallback: find the function by scanning for its declaration line
  const lines = source.split('\n');
  const declPattern = new RegExp(`\\b${functionName}\\s*[(<]`);
  const startLine = lines.findIndex(l => declPattern.test(l));
  if (startLine === -1) {
    return { error: `Function "${functionName}" not found in ${filePath}. Run analyze_codebase first for exact byte-range extraction.` };
  }

  // Collect lines until matching brace depth returns to 0 (works for C-style languages)
  let depth = 0;
  let endLine = startLine;
  for (let i = startLine; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    if (depth > 0 || i === startLine) { endLine = i; continue; }
    endLine = i;
    break;
  }

  const body = lines.slice(startLine, endLine + 1).join('\n');
  return {
    functionName,
    filePath,
    language: detectLanguage(filePath),
    className: null,
    startLine: startLine + 1,
    endLine: endLine + 1,
    body,
    lineCount: endLine - startLine + 1,
    note: 'Extracted via line scan (no call graph available). Run analyze_codebase for exact extraction.',
  };
}

/**
 * List and optionally filter Architecture Decision Records from openspec/decisions/.
 */
export async function handleGetDecisions(
  directory: string,
  query?: string,
): Promise<unknown> {
  const { existsSync } = await import('node:fs');
  const { readdir } = await import('node:fs/promises');
  const { join: pjoin } = await import('node:path');
  const absDir = await validateDirectory(directory);

  // Resolve openspec path from config if present
  let openspecRelPath = 'openspec';
  try {
    const cfgRaw = await readFile(join(absDir, '.spec-gen', 'config.json'), 'utf-8');
    const cfg = JSON.parse(cfgRaw) as { openspecPath?: string };
    if (cfg.openspecPath) openspecRelPath = cfg.openspecPath;
  } catch { /* use default */ }

  const decisionsDir = pjoin(absDir, openspecRelPath, 'decisions');
  if (!existsSync(decisionsDir)) {
    return { decisions: [], note: `No decisions directory found at ${openspecRelPath}/decisions/. Run "spec-gen generate --adrs" first.` };
  }

  let entries: string[];
  try {
    entries = await readdir(decisionsDir);
  } catch {
    return { decisions: [] };
  }

  // Each ADR is a .md file directly in decisions/
  const adrFiles = entries.filter(e => e.endsWith('.md'));

  // Read all ADR files in parallel
  const adrs = await Promise.all(
    adrFiles.map(async filename => {
      const filePath = pjoin(decisionsDir, filename);
      const content = await readFile(filePath, 'utf-8');
      // Extract title from first H1 or H2
      const titleMatch = content.match(/^#{1,2}\s+(.+)$/m);
      const title = titleMatch?.[1]?.trim() ?? filename.replace(/\.md$/, '');
      // Extract status from "Status:" line (ADR convention)
      const statusMatch = content.match(/^\*\*?Status\*\*?:?\s*(.+)$/im);
      const status = statusMatch?.[1]?.trim() ?? 'unknown';
      return { filename, title, status, content };
    })
  );

  // Filter by query text if provided
  const lowerQuery = query?.toLowerCase();
  const filtered = lowerQuery
    ? adrs.filter(
        a =>
          a.title.toLowerCase().includes(lowerQuery) ||
          a.content.toLowerCase().includes(lowerQuery)
      )
    : adrs;

  return {
    count: filtered.length,
    query: query ?? null,
    decisions: filtered.map(a => ({
      filename: a.filename,
      title: a.title,
      status: a.status,
      content: a.content,
    })),
  };
}

// ============================================================================
// ROUTE INVENTORY HANDLER
// ============================================================================

/**
 * Return the pre-computed route inventory from the last analysis run.
 * Falls back to re-computing from source files if the artifact is missing.
 */
export async function handleGetRouteInventory(
  directory: string
): Promise<Record<string, unknown>> {
  const absDir = await validateDirectory(directory);
  const artifactPath = join(absDir, SPEC_GEN_DIR, SPEC_GEN_ANALYSIS_SUBDIR, ARTIFACT_ROUTE_INVENTORY);

  // Try reading cached artifact first
  try {
    const raw = await readFile(artifactPath, 'utf-8');
    const inventory = JSON.parse(raw) as Record<string, unknown>;
    return { cached: true, ...inventory };
  } catch {
    // Artifact not present — run live extraction
  }

  const { buildRouteInventory } = await import('../../analyzer/http-route-parser.js');
  const { RepositoryMapper } = await import('../../analyzer/repository-mapper.js');
  const { readSpecGenConfig } = await import('../config-manager.js');

  const specGenConfig = await readSpecGenConfig(absDir);
  const configExclude = specGenConfig?.analysis.excludePatterns ?? [];

  const mapper = new RepositoryMapper(absDir, {
    maxFiles: DEFAULT_MAX_FILES,
    excludePatterns: configExclude.length > 0 ? configExclude : undefined,
  });
  const repoMap = await mapper.map();
  const filePaths = repoMap.allFiles.map(f => f.path);

  const inventory = await buildRouteInventory(filePaths, absDir);
  return { cached: false, ...inventory };
}

// ============================================================================
// MIDDLEWARE INVENTORY HANDLER
// ============================================================================

/**
 * Return the pre-computed middleware inventory from the last analysis run.
 * Falls back to re-computing from source files if the artifact is missing.
 */
export async function handleGetMiddlewareInventory(
  directory: string
): Promise<Record<string, unknown>> {
  const absDir = await validateDirectory(directory);
  const artifactPath = join(absDir, SPEC_GEN_DIR, SPEC_GEN_ANALYSIS_SUBDIR, ARTIFACT_MIDDLEWARE_INVENTORY);

  // Try reading cached artifact first
  try {
    const raw = await readFile(artifactPath, 'utf-8');
    const inventory = JSON.parse(raw) as unknown[];
    return { cached: true, total: inventory.length, entries: inventory };
  } catch {
    // Artifact not present — run live extraction
  }

  const { extractMiddleware } = await import('../../analyzer/middleware-extractor.js');
  const { RepositoryMapper } = await import('../../analyzer/repository-mapper.js');
  const { readSpecGenConfig } = await import('../config-manager.js');

  const specGenConfig = await readSpecGenConfig(absDir);
  const configExclude = specGenConfig?.analysis.excludePatterns ?? [];

  const mapper = new RepositoryMapper(absDir, {
    maxFiles: DEFAULT_MAX_FILES,
    excludePatterns: configExclude.length > 0 ? configExclude : undefined,
  });
  const repoMap = await mapper.map();
  const filePaths = repoMap.allFiles.map(f => f.path);

  const entries = await extractMiddleware(filePaths, absDir);
  return { cached: false, total: entries.length, entries };
}

// ============================================================================
// SCHEMA INVENTORY HANDLER
// ============================================================================

/**
 * Return the pre-computed database schema inventory from the last analysis run.
 * Falls back to re-computing from source files if the artifact is missing.
 */
export async function handleGetSchemaInventory(
  directory: string
): Promise<Record<string, unknown>> {
  const absDir = await validateDirectory(directory);
  const artifactPath = join(absDir, SPEC_GEN_DIR, SPEC_GEN_ANALYSIS_SUBDIR, ARTIFACT_SCHEMA_INVENTORY);

  try {
    const raw = await readFile(artifactPath, 'utf-8');
    const schemas = JSON.parse(raw) as unknown[];
    return { cached: true, total: schemas.length, schemas };
  } catch {
    // Artifact not present — run live extraction
  }

  const { extractSchemas } = await import('../../analyzer/schema-extractor.js');
  const { RepositoryMapper } = await import('../../analyzer/repository-mapper.js');
  const { readSpecGenConfig } = await import('../config-manager.js');

  const specGenConfig = await readSpecGenConfig(absDir);
  const configExclude = specGenConfig?.analysis.excludePatterns ?? [];

  const mapper = new RepositoryMapper(absDir, {
    maxFiles: DEFAULT_MAX_FILES,
    excludePatterns: configExclude.length > 0 ? configExclude : undefined,
  });
  const repoMap = await mapper.map();
  const filePaths = repoMap.allFiles.map(f => f.path);

  const schemas = await extractSchemas(filePaths, absDir);
  return { cached: false, total: schemas.length, schemas };
}

// ============================================================================
// UI COMPONENTS HANDLER
// ============================================================================

/**
 * Return the pre-computed UI component inventory from the last analysis run.
 * Falls back to re-computing from source files if the artifact is missing.
 */
export async function handleGetUIComponents(
  directory: string
): Promise<Record<string, unknown>> {
  const absDir = await validateDirectory(directory);
  const artifactPath = join(absDir, SPEC_GEN_DIR, SPEC_GEN_ANALYSIS_SUBDIR, ARTIFACT_UI_INVENTORY);

  try {
    const raw = await readFile(artifactPath, 'utf-8');
    const components = JSON.parse(raw) as unknown[];
    return { cached: true, total: components.length, components };
  } catch {
    // Artifact not present — run live extraction
  }

  const { extractUIComponents } = await import('../../analyzer/ui-component-extractor.js');
  const { RepositoryMapper } = await import('../../analyzer/repository-mapper.js');
  const { readSpecGenConfig } = await import('../config-manager.js');

  const specGenConfig = await readSpecGenConfig(absDir);
  const configExclude = specGenConfig?.analysis.excludePatterns ?? [];

  const mapper = new RepositoryMapper(absDir, {
    maxFiles: DEFAULT_MAX_FILES,
    excludePatterns: configExclude.length > 0 ? configExclude : undefined,
  });
  const repoMap = await mapper.map();
  const filePaths = repoMap.allFiles.map(f => f.path);

  const components = await extractUIComponents(filePaths, absDir);
  return { cached: false, total: components.length, components };
}

// ============================================================================
// ENV VARS HANDLER
// ============================================================================

/**
 * Return the pre-computed environment variable inventory from the last analysis run.
 * Falls back to re-computing from source files if the artifact is missing.
 */
export async function handleGetEnvVars(
  directory: string
): Promise<Record<string, unknown>> {
  const absDir = await validateDirectory(directory);
  const artifactPath = join(absDir, SPEC_GEN_DIR, SPEC_GEN_ANALYSIS_SUBDIR, ARTIFACT_ENV_INVENTORY);

  try {
    const raw = await readFile(artifactPath, 'utf-8');
    const envVars = JSON.parse(raw) as unknown[];
    return { cached: true, total: envVars.length, envVars };
  } catch {
    // Artifact not present — run live extraction
  }

  const { extractEnvVars } = await import('../../analyzer/env-extractor.js');
  const { RepositoryMapper } = await import('../../analyzer/repository-mapper.js');
  const { readSpecGenConfig } = await import('../config-manager.js');

  const specGenConfig = await readSpecGenConfig(absDir);
  const configExclude = specGenConfig?.analysis.excludePatterns ?? [];

  const mapper = new RepositoryMapper(absDir, {
    maxFiles: DEFAULT_MAX_FILES,
    excludePatterns: configExclude.length > 0 ? configExclude : undefined,
  });
  const repoMap = await mapper.map();
  const filePaths = repoMap.allFiles.map(f => f.path);

  const envVars = await extractEnvVars(filePaths, absDir);
  return { cached: false, total: envVars.length, envVars };
}

/**
 * Parity audit: report spec coverage gaps without any LLM call.
 * Returns uncovered functions, hub gaps, orphan requirements, and stale domains.
 */
export async function handleAuditSpecCoverage(
  directory: string,
  maxUncovered = 50,
  hubThreshold = 5,
): Promise<unknown> {
  const absDir = await validateDirectory(directory);
  try {
    const report = await specGenAudit({
      rootPath: absDir,
      maxUncovered,
      hubThreshold,
      save: true,
    });
    return report;
  } catch (err) {
    return { error: `Audit failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ============================================================================
// TEST GENERATION HANDLERS
// ============================================================================

/**
 * Generate spec-driven test files from OpenSpec scenarios.
 */
export async function handleGenerateTests(args: {
  directory: string;
  domains?: string[];
  framework?: string;
  useLlm?: boolean;
  dryRun?: boolean;
}): Promise<Record<string, unknown>> {
  const absDir = await validateDirectory(args.directory);

  const { parseScenarios, generateTests, writeTestFiles, detectFramework } =
    await import('../../../core/test-generator/index.js');
  const { FRAMEWORK_EXTENSIONS } = await import('../../../types/test-generator.js');
  type TestFramework = keyof typeof FRAMEWORK_EXTENSIONS;

  const scenarios = await parseScenarios({
    rootPath: absDir,
    domains: args.domains,
  });

  if (scenarios.length === 0) {
    return { files: [], message: 'No scenarios found. Run "spec-gen generate" first.' };
  }

  // Resolve framework
  let framework: TestFramework;
  const valid = Object.keys(FRAMEWORK_EXTENSIONS) as TestFramework[];
  if (!args.framework || args.framework === 'auto') {
    framework = await detectFramework(absDir);
  } else if (valid.includes(args.framework as TestFramework)) {
    framework = args.framework as TestFramework;
  } else {
    return { error: `Unknown framework "${args.framework}". Valid: ${valid.join(', ')}` };
  }

  const files = await generateTests({
    scenarios,
    framework,
    outputDir: 'spec-tests',
    rootPath: absDir,
    useLlm: args.useLlm ?? false,
  });

  const dryRun = args.dryRun ?? true; // MCP defaults to dry-run for safety
  const writeResult = await writeTestFiles({
    files,
    rootPath: absDir,
    dryRun,
    merge: false,
  });

  return {
    framework,
    dryRun,
    files: files.map((f) => ({
      path: f.outputPath,
      domain: f.domain,
      scenarioCount: f.scenarios.length,
      content: f.content,
    })),
    summary: writeResult,
  };
}

/**
 * Report spec test coverage for a project.
 */
export async function handleGetTestCoverage(args: {
  directory: string;
  domains?: string[];
  discover?: boolean;
  minCoverage?: number;
}): Promise<Record<string, unknown>> {
  const absDir = await validateDirectory(args.directory);

  const { analyzeTestCoverage } = await import('../../../core/test-generator/index.js');

  const report = await analyzeTestCoverage({
    rootPath: absDir,
    testDirs: ['spec-tests', 'src'],
    domains: args.domains,
    minCoverage: args.minCoverage,
    // discover without LLM: tag-based only
    discover: false,
  });

  return report as unknown as Record<string, unknown>;
}

// ============================================================================
// get_minimal_context
// ============================================================================

/**
 * Return the bare minimum an agent needs to safely modify a function:
 * its signature + body, direct callers (signatures), direct callees (signatures),
 * and which test files cover it. Typically 200-600 tokens vs orient's 2000+.
 */
export async function handleGetMinimalContext(
  directory: string,
  functionName: string,
  filePath?: string,
): Promise<unknown> {
  const absDir = await validateDirectory(directory);
  const ctx = await readCachedContext(absDir);
  if (!ctx?.callGraph) return { error: 'No call graph. Run analyze_codebase first.' };

  const cg = ctx.callGraph as SerializedCallGraph;
  const nodeMap = new Map(cg.nodes.map(n => [n.id, n]));

  // Find target node(s)
  const candidates = cg.nodes.filter(n =>
    n.name === functionName &&
    !n.isExternal && !n.isTest &&
    (!filePath || n.filePath.endsWith(filePath)),
  );
  if (candidates.length === 0) return { error: `Function "${functionName}" not found. Run analyze_codebase first.` };
  const target = candidates[0];

  // Direct callers and callees from calls edges
  const callsEdges = cg.edges.filter(e => !e.kind || e.kind === 'calls');

  const sig = (n: (typeof cg.nodes)[0]) =>
    n.signature ?? n.name + (n.isExternal ? ' [external]' : '');

  // Build per-callee edge list to get callType
  const edgesForCallee = new Map<string, Array<{ callerId: string; callType?: string }>>();
  const edgesForCaller = new Map<string, Array<{ calleeId: string; callType?: string }>>();
  for (const e of callsEdges) {
    if (!edgesForCallee.has(e.calleeId)) edgesForCallee.set(e.calleeId, []);
    edgesForCallee.get(e.calleeId)!.push({ callerId: e.callerId, callType: e.callType });
    if (!edgesForCaller.has(e.callerId)) edgesForCaller.set(e.callerId, []);
    edgesForCaller.get(e.callerId)!.push({ calleeId: e.calleeId, callType: e.callType });
  }

  const callerEdges = edgesForCallee.get(target.id) ?? [];
  const calleeEdgeList = edgesForCaller.get(target.id) ?? [];

  const callerIds = callerEdges.map(e => e.callerId);
  const calleeIds = calleeEdgeList.map(e => e.calleeId);

  const callers = [...new Set(callerIds)]
    .map(id => {
      const n = nodeMap.get(id);
      if (!n || n.isExternal) return null;
      const edge = callerEdges.find(e => e.callerId === id);
      return { name: n.name, file: relative(absDir, n.filePath), sig: sig(n), callType: edge?.callType ?? 'direct', isExternal: false };
    })
    .filter((n): n is NonNullable<typeof n> => !!n)
    .slice(0, 12);

  const callees = [...new Set(calleeIds)]
    .map(id => {
      const n = nodeMap.get(id);
      if (!n) return null;
      const edge = calleeEdgeList.find(e => e.calleeId === id);
      return {
        name: n.isExternal ? `[external] ${n.name}` : n.name,
        file: n.isExternal ? 'external' : relative(absDir, n.filePath),
        sig: sig(n),
        callType: edge?.callType ?? 'direct',
        isExternal: n.isExternal ?? false,
        kind: n.externalKind,
      };
    })
    .filter((n): n is NonNullable<typeof n> => !!n)
    .slice(0, 12);

  // Test coverage — distinguish import-based vs call-based tracing
  const seenTestNames = new Set<string>();
  const testedBy = cg.edges
    .filter(e => e.kind === 'tested_by' && e.callerId === target.id)
    .flatMap(e => {
      if (seenTestNames.has(e.calleeName)) return [];
      seenTestNames.add(e.calleeName);
      const confidence: 'imported' | 'called' = e.confidence === 'import' ? 'imported' : 'called';
      return [{ name: e.calleeName, confidence }];
    });

  // Function body (byte-range slice from source)
  let body: string | null = null;
  try {
    const src = await readFile(target.filePath, 'utf-8');
    body = src.slice(target.startIndex, target.endIndex);
  } catch { /* source unavailable */ }

  return {
    function: {
      name: target.name,
      file: relative(absDir, target.filePath),
      signature: target.signature ?? target.name,
      language: target.language,
      className: target.className ?? null,
      startLine: target.startLine ?? null,
      fanIn: target.fanIn,
      fanOut: target.fanOut,
      community: target.communityLabel ?? null,
      body,
    },
    callers,
    callees,
    testedBy,
  };
}

// ============================================================================
// get_cluster
// ============================================================================

/**
 * Return all functions in the same community as the given function.
 * Communities are computed via label propagation on the call graph at analyze time.
 * Useful for understanding the "cluster" of related functions without traversing the graph.
 */
export async function handleGetCluster(
  directory: string,
  functionName: string,
): Promise<unknown> {
  const absDir = await validateDirectory(directory);
  const ctx = await readCachedContext(absDir);
  if (!ctx?.callGraph) return { error: 'No call graph. Run analyze_codebase first.' };

  const cg = ctx.callGraph as SerializedCallGraph;

  // Find the target node
  const target = cg.nodes.find(n => n.name === functionName && !n.isExternal && !n.isTest);
  if (!target) return { error: `Function "${functionName}" not found.` };
  if (!target.communityId) return { error: `No community data. Re-run analyze_codebase.` };

  // All nodes in same community
  const members = cg.nodes
    .filter(n => n.communityId === target.communityId && !n.isExternal && !n.isTest)
    .sort((a, b) => b.fanIn - a.fanIn);

  // Internal edges within community
  const memberIds = new Set(members.map(n => n.id));
  const nameById = new Map(members.map(n => [n.id, n.name]));
  const rawInternal = cg.edges
    .filter(e => (!e.kind || e.kind === 'calls') && memberIds.has(e.callerId) && memberIds.has(e.calleeId));

  // Deduplicate, count all unique internal edges for density, show top 15
  const seen = new Set<string>();
  const callEdges: string[] = [];
  let uniqueInternalCount = 0;
  for (const e of rawInternal) {
    const key = `${e.callerId}→${e.calleeId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueInternalCount++;
    if (callEdges.length < 15) {
      callEdges.push(`${nameById.get(e.callerId)} → ${nameById.get(e.calleeId)}`);
    }
  }

  const m = members.length;
  const clusterDensity = m > 1 ? Math.round((uniqueInternalCount / (m * (m - 1))) * 1000) / 1000 : 0;

  // Files the community spans
  const files = [...new Set(members.map(n => relative(absDir, n.filePath)))].sort();

  return {
    communityLabel: target.communityLabel,
    communityId: target.communityId,
    stats: {
      members: m,
      files: files.length,
      internalEdges: uniqueInternalCount,
      clusterDensity,
    },
    files,
    // Internal call edges show WHY these functions cluster together
    internalCallGraph: callEdges,
    functions: members.map(n => ({
      name: n.name,
      file: relative(absDir, n.filePath),
      signature: n.signature ?? n.name,
      fanIn: n.fanIn,
      fanOut: n.fanOut,
    })),
  };
}

// ============================================================================
// detect_changes
// ============================================================================

/** Run git with explicit stdio pipes — safe inside MCP server (which owns stdin/stdout). */
function runGit(args: string[], cwd: string): Promise<string> {
  // Use shell file-redirect to temp files instead of pipes — libuv pipe() calls
  // fail with EBADF inside the MCP server because its FD 0/1 are the JSON-RPC
  // protocol sockets; avoiding pipe creation altogether sidesteps the issue.
  return new Promise((resolve, reject) => {
    const PATH = (process.env.PATH ?? '') + ':/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin';
    const tmp = mkdtempSync(join(tmpdir(), 'sg-git-'));
    const outPath = join(tmp, 'o');
    const errPath = join(tmp, 'e');
    const escaped = args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
    const cmd = `/usr/bin/git ${escaped} >'${outPath}' 2>'${errPath}'`;
    const r = spawnSync('/bin/sh', ['-c', cmd], {
      cwd,
      stdio: 'ignore',
      env: { ...process.env, PATH },
    });
    let stdout = '';
    let stderr = '';
    try { stdout = readFileSync(outPath, 'utf8'); } catch { /* no output */ }
    try { stderr = readFileSync(errPath, 'utf8'); } catch { /* no output */ }
    rmSync(tmp, { recursive: true, force: true });
    if (r.error) { reject(r.error); return; }
    if ((r.status ?? 1) !== 0) { reject(new Error(stderr || `git exit ${r.status}`)); return; }
    resolve(stdout);
  });
}

/**
 * Detect recently changed functions and rank them by blast radius (fanIn of callers via BFS).
 * Runs git diff to find changed files/lines, maps to function nodes, scores by impact.
 */
export async function handleDetectChanges(
  directory: string,
  base?: string,
): Promise<unknown> {
  const absDir = await validateDirectory(directory);
  const ctx = await readCachedContext(absDir);
  if (!ctx?.callGraph) return { error: 'No call graph. Run analyze_codebase first.' };

  const ref = base ?? 'HEAD';
  let diffOutput: string;
  try {
    diffOutput = await runGit(['diff', '--unified=0', ref, '--', '.'], absDir);
    if (!diffOutput.trim()) {
      diffOutput = await runGit(['diff', '--unified=0', '--cached', '--', '.'], absDir);
    }
  } catch (err) {
    return { error: `git diff failed: ${(err as Error).message}` };
  }

  if (!diffOutput.trim()) return { changedFunctions: [], message: 'No changes detected.' };

  // Parse changed file→line ranges from unified diff
  const changedLines = new Map<string, Array<[number, number]>>(); // absFilePath → [[start,end],…]
  let curFile: string | null = null;
  for (const line of diffOutput.split('\n')) {
    const fileMatch = line.match(/^\+\+\+ b\/(.+)$/);
    if (fileMatch) { curFile = join(absDir, fileMatch[1]); continue; }
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch && curFile) {
      const start = parseInt(hunkMatch[1], 10);
      const count = hunkMatch[2] !== undefined ? parseInt(hunkMatch[2], 10) : 1;
      if (count === 0) continue; // deletion only, no added lines
      if (!changedLines.has(curFile)) changedLines.set(curFile, []);
      changedLines.get(curFile)!.push([start, start + count - 1]);
    }
  }

  const cg = ctx.callGraph as SerializedCallGraph;
  const nodeMap = new Map(cg.nodes.map(n => [n.id, n]));

  // Map changed line ranges to function nodes; track overlapping line count per function
  const changedFnIds = new Set<string>();
  const fnChangedLineCount = new Map<string, number>(); // nodeId → #lines overlapping with diff
  for (const [filePath, ranges] of changedLines) {
    const fileNodes = cg.nodes.filter(n => n.filePath === filePath && !n.isExternal && !n.isTest && n.startLine);
    for (const node of fileNodes) {
      const fnEnd = node.endLine ?? node.startLine!;
      let overlap = 0;
      for (const [start, end] of ranges) {
        if (node.startLine! <= end && fnEnd >= start) {
          changedFnIds.add(node.id);
          overlap += Math.min(end, fnEnd) - Math.max(start, node.startLine!) + 1;
        }
      }
      if (overlap > 0) fnChangedLineCount.set(node.id, (fnChangedLineCount.get(node.id) ?? 0) + overlap);
    }
    // Fallback: no line match — include all functions in the file
    if (fileNodes.length > 0 && !fileNodes.some(n => changedFnIds.has(n.id))) {
      for (const n of fileNodes) changedFnIds.add(n.id);
    }
  }

  if (changedFnIds.size === 0) {
    return { changedFunctions: [], message: 'Changed files found but no matching function nodes. Re-run analyze_codebase.' };
  }

  const callsEdges = cg.edges.filter(e => !e.kind || e.kind === 'calls');

  // callerIndex: calleeId → callerIds (for upward BFS)
  const callerIndex = new Map<string, string[]>();
  for (const e of callsEdges) {
    if (!callerIndex.has(e.calleeId)) callerIndex.set(e.calleeId, []);
    callerIndex.get(e.calleeId)!.push(e.callerId);
  }

  // calleeIndex: callerId → calleeIds (for boundary score)
  const calleeIndex = new Map<string, string[]>();
  for (const e of callsEdges) {
    if (!calleeIndex.has(e.callerId)) calleeIndex.set(e.callerId, []);
    calleeIndex.get(e.callerId)!.push(e.calleeId);
  }

  // Distance-weighted BFS: Σ 1/d² over all transitive callers
  const transitiveScore = (startId: string): number => {
    const visited = new Map<string, number>(); // id → depth
    const queue: Array<{ id: string; depth: number }> = [{ id: startId, depth: 1 }];
    let score = 0;
    while (queue.length) {
      const { id, depth } = queue.shift()!;
      for (const callerId of callerIndex.get(id) ?? []) {
        if (!visited.has(callerId)) {
          visited.set(callerId, depth);
          score += 1 / (depth * depth);
          queue.push({ id: callerId, depth: depth + 1 });
        }
      }
    }
    return score;
  };

  // Boundary score: outgoing edges to external nodes; http/db weighted 3×, others 1×; normalized
  const boundaryScore = (nodeId: string): number => {
    let raw = 0;
    for (const calleeId of calleeIndex.get(nodeId) ?? []) {
      const callee = nodeMap.get(calleeId);
      if (!callee?.isExternal) continue;
      raw += (callee.externalKind === 'http' || callee.externalKind === 'database') ? 3 : 1;
    }
    return Math.min(raw / 3, 1);
  };

  // testedBy map: nodeId → [{name, confidence}]
  const testedByMap = new Map<string, Array<{ name: string; confidence: 'imported' | 'called' }>>();
  for (const e of cg.edges.filter(e => e.kind === 'tested_by')) {
    if (!testedByMap.has(e.callerId)) testedByMap.set(e.callerId, []);
    const arr = testedByMap.get(e.callerId)!;
    if (!arr.some(x => x.name === e.calleeName)) {
      arr.push({ name: e.calleeName, confidence: e.confidence === 'import' ? 'imported' : 'called' });
    }
  }

  const scored = [...changedFnIds].map(id => {
    const n = nodeMap.get(id)!;
    const fnLength = Math.max(1, (n.endLine ?? n.startLine ?? 1) - (n.startLine ?? 1) + 1);
    const changed = fnChangedLineCount.get(id) ?? Math.round(fnLength * 0.5);
    const changeScore = Math.min(changed / fnLength, 1);
    const testCount = testedByMap.get(id)?.length ?? 0;
    const coveragePenalty = 1 / (1 + Math.log(1 + testCount));
    const tScore = transitiveScore(id);
    const bScore = boundaryScore(id);
    const riskScore = Math.round((
      Math.log(1 + n.fanIn) * 0.8 +
      tScore * 1.2 +
      bScore * 2.5 +
      changeScore * 2.0 +
      coveragePenalty * 2.0
    ) * 100) / 100;
    return {
      name: n.name,
      file: relative(absDir, n.filePath),
      startLine: n.startLine ?? null,
      endLine: n.endLine ?? null,
      fanIn: n.fanIn,
      blastRadius: Math.round(tScore * 100) / 100,
      riskScore,
      testedBy: testedByMap.get(id) ?? [],
    };
  }).sort((a, b) => b.riskScore - a.riskScore);

  return {
    base: ref,
    totalChanged: scored.length,
    changedFunctions: scored,
  };
}
