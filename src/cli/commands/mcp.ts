/**
 * spec-gen MCP Server
 *
 * Exposes spec-gen's static analysis capabilities as Model Context Protocol
 * tools, usable from Cline, Claude Code, or any MCP-compatible AI agent.
 *
 * Transport: stdio (standard for editor-embedded MCP servers)
 *
 * Tools:
 *   analyze_codebase    — Run static analysis, return structured summary
 *   get_refactor_report — Return refactoring priorities (from cached analysis)
 *   get_call_graph      — Return call graph: hubs, entry points, violations
 *   get_signatures      — Return compact function/class signatures per file
 *   get_subgraph        — Extract upstream/downstream call subgraph from a function
 *
 * Configuration for Cline / Claude Code:
 *   {
 *     "mcpServers": {
 *       "spec-gen": {
 *         "command": "node",
 *         "args": ["/path/to/spec-gen/dist/cli/index.js", "mcp"]
 *       }
 *     }
 *   }
 */

import { Command } from 'commander';
// We use the low-level `Server` class rather than the high-level `McpServer`
// because our tool definitions use raw JSON Schema. `McpServer` requires Zod.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runAnalysis } from './analyze.js';
import { analyzeForRefactoring } from '../../core/analyzer/refactor-analyzer.js';
import { formatSignatureMaps } from '../../core/analyzer/signature-extractor.js';
import { getSkeletonContent, detectLanguage, isSkeletonWorthIncluding } from '../../core/analyzer/code-shaper.js';
import { getFileGodFunctions, extractSubgraph } from '../../core/analyzer/subgraph-extractor.js';
import type { LLMContext } from '../../core/analyzer/artifact-generator.js';
import type { SerializedCallGraph, FunctionNode } from '../../core/analyzer/call-graph.js';
import type { MappingArtifact } from '../../core/generator/mapping-generator.js';
import {
  isGitRepository,
  getChangedFiles,
  buildSpecMap,
  buildADRMap,
  detectDrift,
} from '../../core/drift/index.js';
import { readSpecGenConfig } from '../../core/services/config-manager.js';
import type { DriftResult } from '../../types/index.js';

// ============================================================================
// TOOL DEFINITIONS
// ============================================================================

const TOOL_DEFINITIONS = [
  {
    name: 'analyze_codebase',
    description:
      'Run static analysis on a project directory. Extracts repo structure, ' +
      'dependency graph, call graph (hub functions, entry points), and top ' +
      'refactoring priorities — all without an LLM. Results are cached for 1 hour.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Absolute path to the project directory to analyze',
        },
        force: {
          type: 'boolean',
          description: 'Force re-analysis even if a recent cache exists (default: false)',
        },
      },
      required: ['directory'],
    },
  },
  {
    name: 'get_refactor_report',
    description:
      'Return a prioritized list of functions that need refactoring, based on ' +
      'the cached static analysis. Issues detected: unreachable code, high fan-in ' +
      '(hub overload), high fan-out (god function), SRP violations (multi-requirement), ' +
      'and cyclic dependencies. Run analyze_codebase first.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Absolute path to the project directory (must have been analyzed first)',
        },
      },
      required: ['directory'],
    },
  },
  {
    name: 'get_call_graph',
    description:
      'Return the call graph for a project: hub functions (high fan-in), ' +
      'entry points (no internal callers), and architectural layer violations. ' +
      'Supports TypeScript, JavaScript, Python, Go, Rust, Ruby, Java. ' +
      'Run analyze_codebase first.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Absolute path to the project directory',
        },
      },
      required: ['directory'],
    },
  },
  {
    name: 'get_duplicate_report',
    description:
      'Detect duplicate code (clone groups) across the codebase using pure static analysis. ' +
      'Detects Type 1 (exact clones — identical after whitespace/comment normalization), ' +
      'Type 2 (structural clones — same structure with renamed variables), and ' +
      'Type 3 (near-clones with Jaccard similarity ≥ 0.7 on token n-grams). ' +
      'No LLM calls required. Run analyze_codebase first.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Absolute path to the project directory (must have been analyzed first)',
        },
      },
      required: ['directory'],
    },
  },
  {
    name: 'get_signatures',
    description:
      'Return compact function and class signatures for files in a project. ' +
      'Useful for understanding a codebase\'s public API without reading full source. ' +
      'Optionally filter by file path pattern. Run analyze_codebase first.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Absolute path to the project directory',
        },
        filePattern: {
          type: 'string',
          description:
            'Optional substring to filter file paths (e.g. "services", "api", ".py")',
        },
      },
      required: ['directory'],
    },
  },
  {
    name: 'get_subgraph',
    description:
      'Extract a subgraph of the call graph centred on a specific function. ' +
      'Useful for impact analysis ("what does X call?"), dependency tracing ' +
      '("who calls X?"), or understanding a change\'s blast radius. ' +
      'Run analyze_codebase first.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Absolute path to the project directory',
        },
        functionName: {
          type: 'string',
          description: 'Name of the function to centre the subgraph on (exact or partial match)',
        },
        direction: {
          type: 'string',
          enum: ['downstream', 'upstream', 'both'],
          description:
            'downstream = what this function calls (default), ' +
            'upstream = who calls this function, ' +
            'both = full neighbourhood',
        },
        maxDepth: {
          type: 'number',
          description: 'Maximum traversal depth (default: 3)',
        },
        format: {
          type: 'string',
          enum: ['json', 'mermaid'],
          description: 'Output format: "json" (default) or "mermaid" flowchart diagram',
        },
      },
      required: ['directory', 'functionName'],
    },
  },
  {
    name: 'get_mapping',
    description:
      'Return the requirement → function mapping produced by spec-gen generate. ' +
      'Shows which functions implement which spec requirements, confidence level ' +
      '(llm / heuristic), and orphan functions not covered by any requirement. ' +
      'Requires spec-gen generate to have been run at least once.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Absolute path to the project directory',
        },
        domain: {
          type: 'string',
          description: 'Filter by domain name (e.g. "auth", "crawler")',
        },
        orphansOnly: {
          type: 'boolean',
          description: 'Return only orphan functions (not covered by any requirement)',
        },
      },
      required: ['directory'],
    },
  },
  // ── Spec drift ──────────────────────────────────────────────────────────────
  {
    name: 'check_spec_drift',
    description:
      'Detect spec drift: identify code changes that are not reflected in the ' +
      'project\'s OpenSpec specifications. Compares git-changed files against ' +
      'spec coverage maps. Returns issues categorised as gap, stale, uncovered, ' +
      'or orphaned-spec. Requires spec-gen generate to have been run at least once. ' +
      'Runs in static mode (no LLM required).',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Absolute path to the project directory (must be a git repository)',
        },
        base: {
          type: 'string',
          description: 'Git ref to compare against (default: auto-detect main/master)',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Specific files to check (default: all changed files)',
        },
        domains: {
          type: 'array',
          items: { type: 'string' },
          description: 'Only check these spec domains (default: all domains)',
        },
        failOn: {
          type: 'string',
          enum: ['error', 'warning', 'info'],
          description: 'Minimum severity to report (default: "warning")',
        },
        maxFiles: {
          type: 'number',
          description: 'Maximum number of changed files to analyze (default: 100)',
        },
      },
      required: ['directory'],
    },
  },
  // ── Decision-aid tools ──────────────────────────────────────────────────────
  {
    name: 'analyze_impact',
    description:
      'Deep impact analysis for a specific function or symbol. Returns fan-in, fan-out, ' +
      'upstream call chain, downstream critical path, a risk score (0–100), blast radius ' +
      'estimation, and a recommended refactoring strategy. Use this before touching any ' +
      'function to understand the full consequences. Run analyze_codebase first.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Absolute path to the project directory',
        },
        symbol: {
          type: 'string',
          description: 'Function or method name to analyse (exact or partial match)',
        },
        depth: {
          type: 'number',
          description: 'Traversal depth for upstream/downstream chains (default: 2)',
        },
      },
      required: ['directory', 'symbol'],
    },
  },
  {
    name: 'get_low_risk_refactor_candidates',
    description:
      'Return the safest functions to refactor first: low fan-in (few callers), ' +
      'low fan-out (few dependencies), no cyclic involvement, not a hub. ' +
      'Ideal starting point for incremental, low-risk refactoring sessions. ' +
      'Run analyze_codebase first.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Absolute path to the project directory',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of candidates to return (default: 5)',
        },
        filePattern: {
          type: 'string',
          description: 'Optional substring to restrict candidates to matching file paths',
        },
      },
      required: ['directory'],
    },
  },
  {
    name: 'get_leaf_functions',
    description:
      'Return functions that make no internal calls (leaves of the call graph). ' +
      'These are the safest refactoring targets: self-contained, easy to unit-test, ' +
      'zero downstream blast radius. Best entry point for bottom-up refactoring. ' +
      'Run analyze_codebase first.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Absolute path to the project directory',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return (default: 20)',
        },
        filePattern: {
          type: 'string',
          description: 'Optional substring to restrict results to matching file paths',
        },
        sortBy: {
          type: 'string',
          enum: ['fanIn', 'name', 'file'],
          description:
            'Sort order: "fanIn" (most-called leaves first, default), "name", or "file"',
        },
      },
      required: ['directory'],
    },
  },
  {
    name: 'get_critical_hubs',
    description:
      'Return the highest-impact hub functions: high fan-in (many callers depend on them), ' +
      'possibly high fan-out (god functions). These require the most careful, incremental ' +
      'refactoring with broad test coverage. Includes a stability score and recommended ' +
      'approach (extract, split, facade, delegate). Run analyze_codebase first.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Absolute path to the project directory',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of hubs to return (default: 10)',
        },
        minFanIn: {
          type: 'number',
          description: 'Minimum fan-in threshold to be considered a hub (default: 3)',
        },
      },
      required: ['directory'],
    },
  },
  {
    name: 'get_function_skeleton',
    description:
      'Return a noise-stripped skeleton of a source file: logs, inline comments, and ' +
      'non-JSDoc block comments are removed while signatures, control flow (if/for/try), ' +
      'return/throw statements, and call expressions are preserved. ' +
      'Use this before refactoring a god function to get a compact structural view ' +
      'without reading thousands of lines of raw source.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Absolute path to the project directory',
        },
        filePath: {
          type: 'string',
          description: 'Path to the file, relative to the project directory',
        },
      },
      required: ['directory', 'filePath'],
    },
  },
  {
    name: 'get_god_functions',
    description:
      'Detect god functions (high fan-out, likely orchestrators) in the project or in a ' +
      'specific file, and return their call-graph neighborhood. ' +
      'Use this to identify which functions need to be refactored and understand what ' +
      'logical blocks to extract. Run analyze_codebase first.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Absolute path to the project directory',
        },
        filePath: {
          type: 'string',
          description: 'Optional: restrict search to this file (relative path)',
        },
        fanOutThreshold: {
          type: 'number',
          description: 'Minimum fan-out to be considered a god function (default: 8)',
        },
      },
      required: ['directory'],
    },
  },
];

// ============================================================================
// INPUT VALIDATION
// ============================================================================

/**
 * Resolve and validate a user-supplied directory path.
 *
 * Ensures the path resolves to an existing directory, which prevents path
 * traversal attacks where a client supplies `"../../../../etc"` or a plain
 * file path instead of a project directory.
 */
export async function validateDirectory(directory: string): Promise<string> {
  if (!directory || typeof directory !== 'string') {
    throw new Error('directory parameter is required and must be a string');
  }
  const absDir = resolve(directory);
  let s: Awaited<ReturnType<typeof stat>>;
  try {
    s = await stat(absDir);
  } catch {
    throw new Error(`Directory not found: ${absDir}`);
  }
  if (!s.isDirectory()) {
    throw new Error(`Not a directory: ${absDir}`);
  }
  return absDir;
}

/**
 * Strip common API key and token patterns from an error message before
 * returning it to MCP clients, to prevent secret leakage via error responses.
 */
export function sanitizeMcpError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg
    .replace(/sk-ant-[A-Za-z0-9\-_]{10,}/g, '[REDACTED]')
    .replace(/sk-[A-Za-z0-9\-_]{20,}/g, '[REDACTED]')
    .replace(/Bearer\s+\S{10,}/g, 'Bearer [REDACTED]')
    .replace(/Authorization:\s*\S+/gi, 'Authorization: [REDACTED]')
    .replace(/api[_-]?key[=:]\s*\S{8,}/gi, 'api_key=[REDACTED]');
}

// ============================================================================
// CACHE HELPERS
// ============================================================================

async function readCachedContext(directory: string): Promise<LLMContext | null> {
  try {
    const raw = await readFile(
      join(directory, '.spec-gen', 'analysis', 'llm-context.json'),
      'utf-8'
    );
    return JSON.parse(raw) as LLMContext;
  } catch {
    return null;
  }
}

/** Returns true if the cached analysis is present and less than 1 hour old. */
async function isCacheFresh(directory: string): Promise<boolean> {
  try {
    const s = await stat(join(directory, '.spec-gen', 'analysis', 'llm-context.json'));
    return Date.now() - s.mtimeMs < 60 * 60 * 1000;
  } catch {
    return false;
  }
}

// ============================================================================
// TOOL HANDLERS
// ============================================================================

/**
 * Run a full static analysis pass on `directory` and return a compact summary.
 *
 * Always writes results to `<directory>/.spec-gen/analysis/`. The `force`
 * flag bypasses the 1-hour cache and triggers a fresh analysis.
 *
 * Returned object includes: project metadata, file/dep/call-graph stats,
 * detected domains, and the top-10 refactoring priorities (if a call graph
 * was produced).
 */
async function handleAnalyzeCodebase(
  directory: string,
  force: boolean
): Promise<Record<string, unknown>> {
  const absDir = await validateDirectory(directory);
  const outputPath = join(absDir, '.spec-gen', 'analysis');

  // Skip re-analysis if cache is fresh and force is not set
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

  // Compute top refactor priorities if call graph available
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
    domains: rs.domains.map(d => d.name),
    topRefactorIssues,
    analysisPath: join('.spec-gen', 'analysis'),
  };
}

/**
 * Return a prioritized refactor report from cached analysis.
 *
 * Detects five issue categories: unreachable code, high fan-in (hub overload),
 * high fan-out (god function), SRP violations, and cyclic dependencies.
 * Requires a prior successful `analyze_codebase` call.
 */
export async function handleGetRefactorReport(directory: string): Promise<unknown> {
  const absDir = await validateDirectory(directory);
  const ctx = await readCachedContext(absDir);

  if (!ctx) {
    return { error: 'No analysis found. Run analyze_codebase first.' };
  }
  if (!ctx.callGraph) {
    return { error: 'Call graph not available in cached analysis. Re-run analyze_codebase.' };
  }

  return analyzeForRefactoring(ctx.callGraph as SerializedCallGraph);
}

/**
 * Return the call graph summary from cached analysis.
 *
 * Includes hub functions (high fan-in), entry points (no internal callers),
 * and architectural layer violations. Supports TypeScript, JavaScript, Python,
 * Go, Rust, Ruby, and Java. Requires a prior `analyze_codebase` call.
 */
export async function handleGetCallGraph(directory: string): Promise<unknown> {
  const absDir = await validateDirectory(directory);
  const ctx = await readCachedContext(absDir);

  if (!ctx) {
    return { error: 'No analysis found. Run analyze_codebase first.' };
  }
  if (!ctx.callGraph) {
    return { error: 'Call graph not available in cached analysis. Re-run analyze_codebase.' };
  }

  const cg = ctx.callGraph;
  return {
    stats: cg.stats,
    hubFunctions: cg.hubFunctions.map(n => ({
      name: n.name,
      file: n.filePath,
      className: n.className,
      fanIn: n.fanIn,
      fanOut: n.fanOut,
      language: n.language,
    })),
    entryPoints: cg.entryPoints.map(n => ({
      name: n.name,
      file: n.filePath,
      className: n.className,
      language: n.language,
    })),
    layerViolations: cg.layerViolations,
  };
}

/**
 * Read the cached duplicate detection result produced during `analyze`.
 *
 * Returns clone groups (exact, structural, near) and summary stats.
 * Requires a prior `analyze_codebase` call.
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
 *
 * Useful for understanding a codebase's public API without reading full source.
 * Pass `filePattern` to filter by path substring (e.g. `"services"`, `".py"`).
 * Multiple chunks are joined with a `---` separator.
 * Requires a prior `analyze_codebase` call.
 */
export async function handleGetSignatures(directory: string, filePattern?: string): Promise<string> {
  const absDir = await validateDirectory(directory);
  const ctx = await readCachedContext(absDir);

  if (!ctx) {
    return 'No analysis found. Run analyze_codebase first.';
  }
  if (!ctx.signatures || ctx.signatures.length === 0) {
    return 'No signatures available in cached analysis. Re-run analyze_codebase.';
  }

  const filtered = filePattern
    ? ctx.signatures.filter(s => s.path.includes(filePattern))
    : ctx.signatures;

  if (filtered.length === 0) {
    return `No files matching pattern "${filePattern}" found in analysis.`;
  }

  const chunks = formatSignatureMaps(filtered);
  return chunks.join('\n\n---\n\n');
}

/**
 * Return the requirement→function mapping from `mapping.json`.
 *
 * Pass `domain` to filter by domain name, `orphansOnly` to return only
 * functions not covered by any requirement. Requires `spec-gen generate`
 * to have been run at least once.
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
      ? mapping.orphanFunctions.filter(f => f.file.includes(domain))
      : mapping.orphanFunctions;
    return { generatedAt: mapping.generatedAt, stats: mapping.stats, orphanFunctions: filtered };
  }

  const filteredMappings = domain
    ? mapping.mappings.filter(m => m.domain === domain)
    : mapping.mappings;

  return {
    generatedAt: mapping.generatedAt,
    stats: mapping.stats,
    mappings: filteredMappings,
    orphanFunctions: domain ? [] : mapping.orphanFunctions,
  };
}

// ============================================================================
// DECISION-AID HELPERS (shared across the 4 new tools)
// ============================================================================

/**
 * Build forward (caller→callees) and backward (callee→callers) adjacency maps
 * from a serialised call graph, returning both maps and a node lookup.
 */
function buildAdjacency(cg: SerializedCallGraph) {
  const nodeMap = new Map(cg.nodes.map(n => [n.id, n]));
  const forward  = new Map<string, Set<string>>(); // callerId → Set<calleeId>
  const backward = new Map<string, Set<string>>(); // calleeId → Set<callerId>

  for (const n of cg.nodes) {
    forward.set(n.id, new Set());
    backward.set(n.id, new Set());
  }
  for (const e of cg.edges) {
    if (!e.calleeId) continue;
    forward.get(e.callerId)?.add(e.calleeId);
    backward.get(e.calleeId)?.add(e.callerId);
  }
  return { nodeMap, forward, backward };
}

/** BFS up to `maxDepth`. Returns a map of visited node-id → depth reached. */
function bfs(
  seeds: string[],
  adjacency: Map<string, Set<string>>,
  maxDepth: number
): Map<string, number> {
  const visited = new Map<string, number>();
  const queue: Array<{ id: string; depth: number }> = seeds.map(id => ({ id, depth: 0 }));
  for (const id of seeds) visited.set(id, 0);

  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;
    if (depth >= maxDepth) continue;
    for (const nId of adjacency.get(id) ?? []) {
      if (!visited.has(nId)) {
        visited.set(nId, depth + 1);
        queue.push({ id: nId, depth: depth + 1 });
      }
    }
  }
  return visited;
}

/**
 * Compute a risk score [0–100] for a node.
 *
 * Weights:
 *   fan-in  × 4   — callers that break if we touch this
 *   fan-out × 2   — dependencies we must preserve
 *   isHub   × 20  — structural node flagged by the analyser
 *   blastRadius × 1.5
 *
 * Capped at 100.
 */
function computeRiskScore(node: FunctionNode, blastRadius: number, isHub: boolean): number {
  const raw =
    (node.fanIn  ?? 0) * 4 +
    (node.fanOut ?? 0) * 2 +
    (isHub ? 20 : 0) +
    blastRadius * 1.5;
  return Math.min(100, Math.round(raw));
}

/**
 * Derive a plain-language refactoring strategy from the risk profile.
 * Returns a short `approach` label and a longer `rationale`.
 */
function recommendStrategy(
  riskScore: number,
  fanIn: number,
  fanOut: number,
  isHub: boolean
): { approach: string; rationale: string } {
  if (riskScore <= 20) {
    return {
      approach: 'refactor freely',
      rationale:
        'Low fan-in and fan-out. Safe to rename, extract, or rewrite inline. ' +
        'A single PR with unit tests is sufficient.',
    };
  }
  if (riskScore <= 45) {
    return {
      approach: 'refactor with tests',
      rationale:
        'Moderate caller count. Write characterisation tests before changing the signature. ' +
        'Prefer additive changes (new overload / wrapper) then migrate callers.',
    };
  }
  if (isHub && fanOut > 5) {
    return {
      approach: 'split responsibility (SRP)',
      rationale:
        'God-function: high fan-in AND high fan-out. Extract cohesive sub-responsibilities ' +
        'into smaller functions behind a thin façade. Migrate callers incrementally.',
    };
  }
  if (isHub) {
    return {
      approach: 'introduce façade',
      rationale:
        'Critical hub with many callers. Do not change the public signature. ' +
        'Introduce a façade or adapter layer, move logic behind it, ' +
        'then update callers in waves.',
    };
  }
  if (fanOut > 8) {
    return {
      approach: 'decompose fan-out',
      rationale:
        'Too many outgoing dependencies. Extract orchestration logic into smaller coordinators. ' +
        'Consider dependency injection to decouple from concrete callees.',
    };
  }
  return {
    approach: 'incremental extraction',
    rationale:
      'High risk due to caller count. Use the Strangler-Fig pattern: introduce a parallel ' +
      'implementation, migrate callers one by one, then delete the original.',
  };
}

function nodeToSummary(n: FunctionNode | undefined) {
  if (!n) return { name: '', file: '', className: null, depth: 0 };
  return { name: n.name, file: n.filePath, className: n.className ?? null, depth: 0 };
}

// ============================================================================
// DECISION-AID TOOL HANDLERS
// ============================================================================

/**
 * Deep impact analysis for a single symbol.
 *
 * `symbol` is matched case-insensitively as a substring; when multiple nodes
 * match (overloads / same name across files), each is analysed independently
 * and results are returned as a `matches` array.
 *
 * Walks upstream (who calls it) and downstream (what it calls) up to `depth`
 * hops, computes a risk score [0–100], and recommends a refactoring strategy.
 * Requires a prior `analyze_codebase` call.
 */
export async function handleAnalyzeImpact(
  directory: string,
  symbol: string,
  depth = 2
): Promise<unknown> {
  const absDir = await validateDirectory(directory);
  const ctx = await readCachedContext(absDir);

  if (!ctx)           return { error: 'No analysis found. Run analyze_codebase first.' };
  if (!ctx.callGraph) return { error: 'Call graph not available. Re-run analyze_codebase.' };

  const cg = ctx.callGraph as SerializedCallGraph;
  const { nodeMap, forward, backward } = buildAdjacency(cg);
  const hubIds = new Set(cg.hubFunctions.map(n => n.id));

  // Find seed nodes — all functions whose name contains symbol (case-insensitive)
  const lower = symbol.toLowerCase();
  const seeds = cg.nodes.filter(n => n.name.toLowerCase().includes(lower));
  if (seeds.length === 0) {
    return { error: `No function matching "${symbol}" found in call graph.` };
  }

  const seedIds = seeds.map(n => n.id);

  // BFS upstream (callers) and downstream (callees)
  const upstreamMap   = bfs(seedIds, backward, depth);
  const downstreamMap = bfs(seedIds, forward,  depth);

  // Exclude seeds themselves from blast-radius counts
  const upstreamNodes = [...upstreamMap.entries()]
    .filter(([id]) => !seedIds.includes(id))
    .map(([id, d]) => ({ ...nodeToSummary(nodeMap.get(id)), depth: d }))
    .filter(n => n.name);

  const downstreamNodes = [...downstreamMap.entries()]
    .filter(([id]) => !seedIds.includes(id))
    .map(([id, d]) => ({ ...nodeToSummary(nodeMap.get(id)), depth: d }))
    .filter(n => n.name);

  const blastRadius = upstreamNodes.length + downstreamNodes.length;

  const results = seeds.map(seed => {
    const isHub     = hubIds.has(seed.id);
    const riskScore = computeRiskScore(seed, blastRadius, isHub);
    const strategy  = recommendStrategy(riskScore, seed.fanIn ?? 0, seed.fanOut ?? 0, isHub);

    // Leaf nodes of the downstream chain (deepest reachable nodes = critical path extremities)
    const criticalPathLeaves = downstreamNodes
      .filter(n => n.depth === depth)
      .map(n => n.name);

    return {
      symbol:    seed.name,
      file:      seed.filePath,
      className: seed.className ?? null,
      language:  seed.language,
      metrics: {
        fanIn:  seed.fanIn  ?? 0,
        fanOut: seed.fanOut ?? 0,
        isHub,
      },
      blastRadius: {
        total:      blastRadius,
        upstream:   upstreamNodes.length,
        downstream: downstreamNodes.length,
      },
      riskScore,
      riskLevel:
        riskScore <= 20 ? 'low'
        : riskScore <= 45 ? 'medium'
        : riskScore <= 70 ? 'high'
        : 'critical',
      upstreamChain:          upstreamNodes,
      downstreamCriticalPath: downstreamNodes,
      criticalPathLeaves,
      recommendedStrategy: strategy,
    };
  });

  return seeds.length === 1 ? results[0] : { matches: results };
}

/**
 * Return the N safest functions to refactor:
 *   - fan-in  ≤ 2   (few callers)
 *   - fan-out ≤ 3   (few dependencies)
 *   - not a hub
 *   - not an entry point (those carry implicit public-API risk)
 *
 * Sorted by ascending composite risk (fanIn + fanOut), then name.
 * Requires a prior `analyze_codebase` call.
 */
export async function handleGetLowRiskRefactorCandidates(
  directory: string,
  limit = 5,
  filePattern?: string
): Promise<unknown> {
  limit = Math.max(1, Math.min(limit, 500));
  const absDir = await validateDirectory(directory);
  const ctx = await readCachedContext(absDir);

  if (!ctx)           return { error: 'No analysis found. Run analyze_codebase first.' };
  if (!ctx.callGraph) return { error: 'Call graph not available. Re-run analyze_codebase.' };

  const cg       = ctx.callGraph as SerializedCallGraph;
  const hubIds   = new Set(cg.hubFunctions.map(n => n.id));
  const entryIds = new Set(cg.entryPoints.map(n => n.id));

  let candidates = cg.nodes.filter(n => {
    const fanIn  = n.fanIn  ?? 0;
    const fanOut = n.fanOut ?? 0;
    return fanIn <= 2 && fanOut <= 3 && !hubIds.has(n.id) && !entryIds.has(n.id);
  });

  if (filePattern) {
    candidates = candidates.filter(n => n.filePath.includes(filePattern));
  }

  // Sort: lowest combined risk first, break ties by name
  candidates.sort((a, b) => {
    const ra = (a.fanIn ?? 0) + (a.fanOut ?? 0);
    const rb = (b.fanIn ?? 0) + (b.fanOut ?? 0);
    return ra !== rb ? ra - rb : a.name.localeCompare(b.name);
  });

  const top = candidates.slice(0, limit).map(n => ({
    name:      n.name,
    file:      n.filePath,
    className: n.className ?? null,
    language:  n.language,
    fanIn:     n.fanIn  ?? 0,
    fanOut:    n.fanOut ?? 0,
    riskScore: computeRiskScore(n, 0, false),
    rationale: 'Low fan-in, low fan-out, not a hub — safe to rename, extract, or rewrite.',
  }));

  return {
    total:      candidates.length,
    returned:   top.length,
    candidates: top,
    tip: 'Start with the first candidate and work downward. Each can be changed in isolation.',
  };
}

/**
 * Return leaf functions (fan-out === 0 — no outgoing internal calls).
 *
 * Leaves are the safest possible refactoring targets: zero downstream blast
 * radius. Nodes with `fanIn === 0` are additionally flagged as likely dead code.
 *
 * Sort order:
 *   `"fanIn"` (default) — most-called leaves first (best unit-test ROI)
 *   `"name"`            — alphabetical
 *   `"file"`            — grouped by file path
 *
 * Requires a prior `analyze_codebase` call.
 */
export async function handleGetLeafFunctions(
  directory: string,
  limit = 20,
  filePattern?: string,
  sortBy: 'fanIn' | 'name' | 'file' = 'fanIn'
): Promise<unknown> {
  limit = Math.max(1, Math.min(limit, 500));
  const absDir = await validateDirectory(directory);
  const ctx = await readCachedContext(absDir);

  if (!ctx)           return { error: 'No analysis found. Run analyze_codebase first.' };
  if (!ctx.callGraph) return { error: 'Call graph not available. Re-run analyze_codebase.' };

  const cg = ctx.callGraph as SerializedCallGraph;

  // A leaf has no outgoing edges to other internal nodes
  const hasOutgoing = new Set(cg.edges.filter(e => e.calleeId).map(e => e.callerId));
  let leaves = cg.nodes.filter(n => !hasOutgoing.has(n.id));

  if (filePattern) {
    leaves = leaves.filter(n => n.filePath.includes(filePattern));
  }

  leaves.sort((a, b) => {
    if (sortBy === 'fanIn') return (b.fanIn ?? 0) - (a.fanIn ?? 0);
    if (sortBy === 'name')  return a.name.localeCompare(b.name);
    return a.filePath.localeCompare(b.filePath) || a.name.localeCompare(b.name);
  });

  const top = leaves.slice(0, limit).map(n => ({
    name:           n.name,
    file:           n.filePath,
    className:      n.className ?? null,
    language:       n.language,
    fanIn:          n.fanIn  ?? 0,
    fanOut:         0,
    blastRadius:    0,
    riskScore:      computeRiskScore(n, 0, false),
    refactorAdvice: (n.fanIn ?? 0) === 0
      ? 'Unreachable or dead code — safe to delete after confirmation.'
      : 'Pure leaf: rewrite freely, then re-run tests for its callers.',
  }));

  return {
    totalLeaves: leaves.length,
    returned:    top.length,
    sortedBy:    sortBy,
    leaves:      top,
    insight:
      'Refactoring leaves bottom-up lets you build confidence and test coverage ' +
      'before tackling higher-risk hubs.',
  };
}

/**
 * Return critical hub functions ranked by composite criticality:
 *   `criticality = fanIn × 3 + fanOut × 1.5 + (layerViolation ? 10 : 0)`
 *
 * Each hub receives:
 *   - `stabilityScore` (0–100, inverse of criticality) — higher = easier to touch now
 *   - `recommendedApproach`: extract | split | facade | delegate
 *   - `refactoringOrder`: guidance on when to tackle this hub relative to its dependencies
 *
 * Requires a prior `analyze_codebase` call.
 */
export async function handleGetCriticalHubs(
  directory: string,
  limit = 10,
  minFanIn = 3
): Promise<unknown> {
  limit = Math.max(1, Math.min(limit, 500));
  minFanIn = Math.max(1, Math.min(minFanIn, 100));
  const absDir = await validateDirectory(directory);
  const ctx = await readCachedContext(absDir);

  if (!ctx)           return { error: 'No analysis found. Run analyze_codebase first.' };
  if (!ctx.callGraph) return { error: 'Call graph not available. Re-run analyze_codebase.' };

  const cg = ctx.callGraph as SerializedCallGraph;
  const nodeMap = new Map(cg.nodes.map(n => [n.id, n]));
  const violatorFiles = new Set(
    cg.layerViolations.flatMap(v =>
      [nodeMap.get(v.callerId)?.filePath, nodeMap.get(v.calleeId)?.filePath]
        .filter(Boolean) as string[]
    )
  );

  const hubs = cg.nodes
    .filter(n => (n.fanIn ?? 0) >= minFanIn)
    .map(n => {
      const fanIn        = n.fanIn  ?? 0;
      const fanOut       = n.fanOut ?? 0;
      const hasViolation = violatorFiles.has(n.filePath);
      const criticality  = fanIn * 3 + fanOut * 1.5 + (hasViolation ? 10 : 0);
      const stabilityScore = Math.max(0, Math.round(100 - Math.min(100, criticality)));

      let approach: string;
      let approachRationale: string;
      if (fanIn >= 8 && fanOut >= 5) {
        approach = 'split responsibility';
        approachRationale =
          'God-function: extract cohesive groups of callees into dedicated modules ' +
          'and expose a minimal coordinator interface.';
      } else if (fanIn >= 8) {
        approach = 'introduce façade';
        approachRationale =
          'Heavily depended-upon: keep the signature stable, move implementation behind ' +
          'a façade, then migrate callers to the new interface over time.';
      } else if (fanOut >= 5) {
        approach = 'delegate';
        approachRationale =
          'Too many outgoing calls: extract groups of related calls into helper services ' +
          'and delegate to them, reducing this function\'s orchestration burden.';
      } else {
        approach = 'extract';
        approachRationale =
          'Moderate hub: identify the core responsibility, extract secondary logic into ' +
          'well-named helpers, and add integration tests before changing callers.';
      }

      return {
        name:              n.name,
        file:              n.filePath,
        className:         n.className ?? null,
        language:          n.language,
        fanIn,
        fanOut,
        hasLayerViolation: hasViolation,
        criticality:       Math.round(criticality * 10) / 10,
        stabilityScore,
        riskScore:         computeRiskScore(n, fanIn + fanOut, true),
        recommendedApproach: { approach, rationale: approachRationale },
        refactoringOrder:
          stabilityScore >= 60
            ? 'can refactor now with good test coverage'
            : stabilityScore >= 30
            ? 'refactor after stabilising its leaf dependencies'
            : 'defer — stabilise surrounding code first, then tackle incrementally',
      };
    })
    .sort((a, b) => b.criticality - a.criticality)
    .slice(0, limit);

  return {
    totalHubs: cg.nodes.filter(n => (n.fanIn ?? 0) >= minFanIn).length,
    returned:  hubs.length,
    minFanIn,
    hubs,
    guidance:
      'Start with hubs that have the highest stabilityScore (easiest wins). ' +
      'Defer hubs with stabilityScore < 30 until their dependencies are cleaner.',
  };
}

/**
 * Extract a depth-limited subgraph centred on a named function.
 *
 * `functionName` is matched case-insensitively as a substring against all node
 * names; multiple seed nodes may be returned. Traversal direction:
 *   - `downstream` — what this function calls (blast radius / impact analysis)
 *   - `upstream`   — who calls this function (dependency tracing)
 *   - `both`       — full neighbourhood
 *
 * `maxDepth` limits BFS depth (default: 3). `format` controls output:
 * `"json"` (default) returns structured data; `"mermaid"` returns a Mermaid
 * flowchart diagram with seed nodes highlighted in orange.
 * Requires a prior `analyze_codebase` call.
 */
export async function handleGetSubgraph(
  directory: string,
  functionName: string,
  direction: 'downstream' | 'upstream' | 'both' = 'downstream',
  maxDepth = 3,
  format: 'json' | 'mermaid' = 'json'
): Promise<unknown> {
  // Cap depth to prevent unbounded BFS / resource exhaustion
  maxDepth = Math.max(1, Math.min(maxDepth, 20));
  const absDir = await validateDirectory(directory);
  const ctx = await readCachedContext(absDir);

  if (!ctx) {
    return { error: 'No analysis found. Run analyze_codebase first.' };
  }
  if (!ctx.callGraph) {
    return { error: 'Call graph not available in cached analysis. Re-run analyze_codebase.' };
  }

  const cg = ctx.callGraph as SerializedCallGraph;

  // Find seed nodes — all functions whose name contains functionName (case-insensitive)
  const lower = functionName.toLowerCase();
  const seeds = cg.nodes.filter(n => n.name.toLowerCase().includes(lower));

  if (seeds.length === 0) {
    return { error: `No function matching "${functionName}" found in call graph.` };
  }

  // Build adjacency lists
  const forward = new Map<string, string[]>();  // callerId → calleeIds
  const backward = new Map<string, string[]>(); // calleeId → callerIds
  for (const node of cg.nodes) {
    forward.set(node.id, []);
    backward.set(node.id, []);
  }
  for (const edge of cg.edges) {
    if (!edge.calleeId) continue;
    forward.get(edge.callerId)?.push(edge.calleeId);
    backward.get(edge.calleeId)?.push(edge.callerId);
  }

  // BFS in the requested direction(s)
  const visitedIds = new Set<string>();
  const queue: Array<{ id: string; depth: number }> = seeds.map(n => ({ id: n.id, depth: 0 }));
  for (const seed of seeds) visitedIds.add(seed.id);

  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;
    if (depth >= maxDepth) continue;

    const neighbours: string[] = [];
    if (direction === 'downstream' || direction === 'both') {
      neighbours.push(...(forward.get(id) ?? []));
    }
    if (direction === 'upstream' || direction === 'both') {
      neighbours.push(...(backward.get(id) ?? []));
    }

    for (const nId of neighbours) {
      if (!visitedIds.has(nId)) {
        visitedIds.add(nId);
        queue.push({ id: nId, depth: depth + 1 });
      }
    }
  }

  // Collect subgraph nodes and edges
  const nodeMap = new Map(cg.nodes.map(n => [n.id, n]));
  const subNodes = Array.from(visitedIds)
    .map(id => nodeMap.get(id)!)
    .filter(Boolean)
    .map(n => ({
      name: n.name,
      file: n.filePath,
      className: n.className,
      fanIn: n.fanIn,
      fanOut: n.fanOut,
      language: n.language,
      isSeed: seeds.some(s => s.id === n.id),
    }));

  const subEdges = cg.edges
    .filter(e => e.calleeId && visitedIds.has(e.callerId) && visitedIds.has(e.calleeId))
    .map(e => ({
      caller: nodeMap.get(e.callerId)?.name ?? e.callerId,
      callee: nodeMap.get(e.calleeId)?.name ?? e.calleeId,
      callerFile: nodeMap.get(e.callerId)?.filePath,
      calleeFile: nodeMap.get(e.calleeId)?.filePath,
    }));

  if (format === 'mermaid') {
    // Assign stable numeric IDs to avoid Mermaid parsing issues with special chars
    const idOf = new Map<string, string>();
    subNodes.forEach((n, i) => idOf.set(n.name + '|' + n.file, `n${i}`));

    const nodeLines = subNodes.map(n => {
      const id = idOf.get(n.name + '|' + n.file)!;
      const label = `"${n.name}\\n${n.file}"`;
      return n.isSeed ? `    ${id}[${label}]:::seed` : `    ${id}[${label}]`;
    });

    const edgeLines = subEdges.map(e => {
      const fromId = idOf.get(e.caller + '|' + e.callerFile) ?? e.caller;
      const toId   = idOf.get(e.callee + '|' + e.calleeFile) ?? e.callee;
      return `    ${fromId} --> ${toId}`;
    });

    const deduped = [...new Set(edgeLines)];
    const diagram = [
      'flowchart LR',
      '    classDef seed fill:#f5a623,stroke:#d4891a,color:#000',
      ...nodeLines,
      ...deduped,
    ].join('\n');

    return `\`\`\`mermaid\n${diagram}\n\`\`\`\n\n` +
      `_${subNodes.length} nodes · ${deduped.length} edges · ` +
      `seeds: ${seeds.map(s => s.name).join(', ')}_`;
  }

  return {
    query: { functionName, direction, maxDepth },
    seeds: seeds.map(n => ({ name: n.name, file: n.filePath })),
    stats: { nodes: subNodes.length, edges: subEdges.length },
    nodes: subNodes,
    edges: subEdges,
  };
}

// ============================================================================
// SPEC DRIFT HANDLER
// ============================================================================

/**
 * Run spec-drift detection on `directory` in static mode (no LLM).
 *
 * Compares git-changed files against the project's OpenSpec coverage maps and
 * returns a structured `DriftResult`. Returns `{ error }` when preconditions
 * are not met (not a git repo, no config, no specs).
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
  } catch { /* no prior analysis — use spec headers only */ }

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

// ============================================================================
// GOD FUNCTION + SKELETON HANDLERS
// ============================================================================

/**
 * Return a noise-stripped skeleton of a source file.
 * Logs, inline comments, and non-JSDoc block comments are removed.
 */
export async function handleGetFunctionSkeleton(
  directory: string,
  filePath: string,
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

/**
 * Detect god functions (high fan-out) in the project or in a specific file,
 * and return their call-graph neighborhood for refactoring guidance.
 */
export async function handleGetGodFunctions(
  directory: string,
  filePath?: string,
  fanOutThreshold = 8,
): Promise<unknown> {
  const absDir = await validateDirectory(directory);
  const ctx = await readCachedContext(absDir);

  if (!ctx) return { error: 'No analysis found. Run analyze_codebase first.' };
  if (!ctx.callGraph) return { error: 'Call graph not available. Re-run analyze_codebase.' };

  const cg = ctx.callGraph as SerializedCallGraph;

  // Find candidates: either in specific file or across whole project
  let candidates: FunctionNode[];
  if (filePath) {
    candidates = getFileGodFunctions(cg, filePath, fanOutThreshold);
  } else {
    candidates = cg.nodes.filter(n => n.fanOut >= fanOutThreshold);
  }

  if (candidates.length === 0) {
    return {
      threshold: fanOutThreshold,
      count: 0,
      godFunctions: [],
      message: `No god functions found with fanOut >= ${fanOutThreshold}`,
    };
  }

  // For each candidate, extract its subgraph
  const godFunctions = candidates
    .sort((a, b) => b.fanOut - a.fanOut)
    .map(fn => {
      const sub = extractSubgraph(cg, fn);
      const directCallees = [...new Set(
        sub.edges.filter(([from]) => from === fn.name).map(([, to]) => to)
      )];
      return {
        name: fn.name,
        file: fn.filePath,
        className: fn.className,
        fanIn: fn.fanIn,
        fanOut: fn.fanOut,
        directCallees,
        subgraphNodes: sub.nodes.length,
      };
    });

  return {
    threshold: fanOutThreshold,
    count: godFunctions.length,
    godFunctions,
  };
}

// ============================================================================
// MCP SERVER
// ============================================================================

async function startMcpServer(): Promise<void> {
  const server = new Server(
    { name: 'spec-gen', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    try {
      let result: unknown;

      if (name === 'analyze_codebase') {
        const { directory, force = false } = args as { directory: string; force?: boolean };
        result = await handleAnalyzeCodebase(directory, force);
      } else if (name === 'get_refactor_report') {
        const { directory } = args as { directory: string };
        result = await handleGetRefactorReport(directory);
      } else if (name === 'get_call_graph') {
        const { directory } = args as { directory: string };
        result = await handleGetCallGraph(directory);
      } else if (name === 'get_signatures') {
        const { directory, filePattern } = args as { directory: string; filePattern?: string };
        result = await handleGetSignatures(directory, filePattern);
      } else if (name === 'get_subgraph') {
        const { directory, functionName, direction = 'downstream', maxDepth = 3, format = 'json' } =
          args as { directory: string; functionName: string; direction?: 'downstream' | 'upstream' | 'both'; maxDepth?: number; format?: 'json' | 'mermaid' };
        result = await handleGetSubgraph(directory, functionName, direction, maxDepth, format);
      } else if (name === 'get_mapping') {
        const { directory, domain, orphansOnly } = args as { directory: string; domain?: string; orphansOnly?: boolean };
        result = await handleGetMapping(directory, domain, orphansOnly);
      } else if (name === 'analyze_impact') {
        const { directory, symbol, depth = 2 } =
          args as { directory: string; symbol: string; depth?: number };
        result = await handleAnalyzeImpact(directory, symbol, depth);
      } else if (name === 'get_low_risk_refactor_candidates') {
        const { directory, limit = 5, filePattern } =
          args as { directory: string; limit?: number; filePattern?: string };
        result = await handleGetLowRiskRefactorCandidates(directory, limit, filePattern);
      } else if (name === 'get_leaf_functions') {
        const { directory, limit = 20, filePattern, sortBy = 'fanIn' } =
          args as { directory: string; limit?: number; filePattern?: string; sortBy?: 'fanIn' | 'name' | 'file' };
        result = await handleGetLeafFunctions(directory, limit, filePattern, sortBy);
      } else if (name === 'get_critical_hubs') {
        const { directory, limit = 10, minFanIn = 3 } =
          args as { directory: string; limit?: number; minFanIn?: number };
        result = await handleGetCriticalHubs(directory, limit, minFanIn);
      } else if (name === 'get_duplicate_report') {
        const { directory } = args as { directory: string };
        result = await handleGetDuplicateReport(directory);
      } else if (name === 'get_function_skeleton') {
        const { directory, filePath } = args as { directory: string; filePath: string };
        result = await handleGetFunctionSkeleton(directory, filePath);
      } else if (name === 'get_god_functions') {
        const { directory, filePath, fanOutThreshold = 8 } =
          args as { directory: string; filePath?: string; fanOutThreshold?: number };
        result = await handleGetGodFunctions(directory, filePath, fanOutThreshold);
      } else if (name === 'check_spec_drift') {
        const { directory, base = 'auto', files = [], domains = [], failOn = 'warning', maxFiles = 100 } =
          args as { directory: string; base?: string; files?: string[]; domains?: string[]; failOn?: 'error' | 'warning' | 'info'; maxFiles?: number };
        result = await handleCheckSpecDrift(directory, base, files, domains, failOn, maxFiles);
      } else {
        return {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true,
        };
      }

      const text =
        typeof result === 'string' ? result : JSON.stringify(result, null, 2);

      return {
        content: [{ type: 'text', text }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Tool error: ${sanitizeMcpError(err)}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Server runs until stdio is closed by the client
}

// ============================================================================
// COMMAND EXPORT
// ============================================================================

export const mcpCommand = new Command('mcp')
  .description('Start spec-gen as an MCP server (stdio transport, for Cline/Claude Code)')
  .action(startMcpServer);
