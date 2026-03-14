/**
 * Tool registry for the diagram chatbot.
 *
 * Each entry in CHAT_TOOLS maps a tool name to:
 *  - description / inputSchema  — forwarded to the LLM as tool definitions
 *  - execute()                  — calls the matching handler and returns
 *                                 { result, filePaths } where filePaths is
 *                                 the list of source files to highlight in
 *                                 the dependency graph.
 *
 * To add a future MCP tool: add one entry here pointing to any handler.
 */

import {
  handleGetCallGraph,
  handleGetSubgraph,
  handleAnalyzeImpact,
  handleGetCriticalHubs,
  handleGetGodFunctions,
} from './mcp-handlers/graph.js';

import {
  handleSearchCode,
  handleSuggestInsertionPoints,
  handleSearchSpecs,
  handleListSpecDomains,
} from './mcp-handlers/semantic.js';

import {
  handleGetArchitectureOverview,
  handleGetRefactorReport,
  handleGetFunctionBody,
  handleGetDecisions,
} from './mcp-handlers/analysis.js';
import {
  handleGetFileDependencies,
} from './mcp-handlers/graph.js';
import {
  handleGetSpec,
} from './mcp-handlers/semantic.js';

// ============================================================================
// TYPES
// ============================================================================

export interface ChatTool {
  name: string;
  description: string;
  inputSchema: object;
  execute(
    directory: string,
    args: Record<string, unknown>
  ): Promise<{ result: unknown; filePaths: string[] }>;
}

// ============================================================================
// HELPERS
// ============================================================================

/** Recursively extract file-path-looking values from tool results for highlighting. */
function extractFilePaths(obj: unknown): string[] {
  if (!obj || typeof obj !== 'object') return [];
  const paths: string[] = [];

  const push = (v: unknown) => {
    if (typeof v === 'string' && v.includes('/')) paths.push(v);
  };

  const rec = (o: unknown) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { o.forEach(rec); return; }
    const r = o as Record<string, unknown>;
    for (const [k, v] of Object.entries(r)) {
      if (k === 'file' || k === 'filePath' || k === 'callerFile' || k === 'calleeFile') {
        push(v);
      } else if (typeof v === 'object') {
        rec(v);
      }
    }
  };
  rec(obj);
  return [...new Set(paths)];
}

// ============================================================================
// TOOL REGISTRY
// ============================================================================

export const CHAT_TOOLS: ChatTool[] = [
  // ── Architecture overview ────────────────────────────────────────────────
  {
    name: 'get_architecture_overview',
    description:
      'Return a high-level architecture map: domain clusters, cross-cluster dependencies, ' +
      'global entry points, and critical hubs. Use this as the first call when the user asks ' +
      'about the project architecture or wants a broad overview.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Absolute path to the project directory' },
      },
      required: ['directory'],
    },
    async execute(directory, args) {
      const result = await handleGetArchitectureOverview(
        (args.directory as string) ?? directory
      );
      const paths: string[] = [];
      if (result && typeof result === 'object') {
        const r = result as Record<string, unknown>;
        for (const ep of (r.globalEntryPoints as Array<{ file?: string }>) ?? []) {
          if (ep.file) paths.push(ep.file);
        }
        for (const hub of (r.criticalHubs as Array<{ file?: string }>) ?? []) {
          if (hub.file) paths.push(hub.file);
        }
      }
      return { result, filePaths: [...new Set(paths)] };
    },
  },

  // ── Call graph ───────────────────────────────────────────────────────────
  {
    name: 'get_call_graph',
    description:
      'Return hub functions (high fan-in), entry points, and layer violations. ' +
      'Use this when the user asks about which functions are most critical or most called.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Absolute path to the project directory' },
      },
      required: ['directory'],
    },
    async execute(directory, args) {
      const result = await handleGetCallGraph((args.directory as string) ?? directory);
      return { result, filePaths: extractFilePaths(result) };
    },
  },

  // ── Subgraph ─────────────────────────────────────────────────────────────
  {
    name: 'get_subgraph',
    description:
      'Extract the call subgraph around a function. Use this to show what a function calls ' +
      '(downstream) or who calls it (upstream), or both.',
    inputSchema: {
      type: 'object',
      properties: {
        directory:    { type: 'string', description: 'Absolute path to the project directory' },
        functionName: { type: 'string', description: 'Function name (exact or partial match)' },
        direction:    {
          type: 'string',
          enum: ['downstream', 'upstream', 'both'],
          description: 'Direction (default: downstream)',
        },
        maxDepth: { type: 'number', description: 'BFS depth limit (default: 3)' },
      },
      required: ['directory', 'functionName'],
    },
    async execute(directory, args) {
      const result = await handleGetSubgraph(
        (args.directory as string) ?? directory,
        args.functionName as string,
        (args.direction as 'downstream' | 'upstream' | 'both') ?? 'downstream',
        (args.maxDepth as number) ?? 3,
        'json'
      );
      return { result, filePaths: extractFilePaths(result) };
    },
  },

  // ── Impact analysis ──────────────────────────────────────────────────────
  {
    name: 'analyze_impact',
    description:
      'Deep impact analysis for a function: fan-in, fan-out, blast radius, risk score, ' +
      'upstream/downstream chains. Use this when the user asks about the impact of changing ' +
      'or adding something.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Absolute path to the project directory' },
        symbol:    { type: 'string', description: 'Function name to analyse (exact or partial)' },
        depth:     { type: 'number', description: 'Chain depth (default: 2)' },
      },
      required: ['directory', 'symbol'],
    },
    async execute(directory, args) {
      const result = await handleAnalyzeImpact(
        (args.directory as string) ?? directory,
        args.symbol as string,
        (args.depth as number) ?? 2
      );
      return { result, filePaths: extractFilePaths(result) };
    },
  },

  // ── Critical hubs ────────────────────────────────────────────────────────
  {
    name: 'get_critical_hubs',
    description:
      'Return the most critical hub functions (high fan-in). Use this when the user asks ' +
      'about bottlenecks, central functions, or what to refactor.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Absolute path to the project directory' },
        limit:     { type: 'number', description: 'Maximum hubs to return (default: 10)' },
        minFanIn:  { type: 'number', description: 'Minimum fan-in threshold (default: 3)' },
      },
      required: ['directory'],
    },
    async execute(directory, args) {
      const result = await handleGetCriticalHubs(
        (args.directory as string) ?? directory,
        (args.limit as number) ?? 10,
        (args.minFanIn as number) ?? 3
      );
      return { result, filePaths: extractFilePaths(result) };
    },
  },

  // ── God functions ────────────────────────────────────────────────────────
  {
    name: 'get_god_functions',
    description:
      'Find god functions (high fan-out orchestrators). Use this when the user asks ' +
      'about complex or oversized functions that do too much.',
    inputSchema: {
      type: 'object',
      properties: {
        directory:       { type: 'string', description: 'Absolute path to the project directory' },
        filePath:        { type: 'string', description: 'Optional: restrict to a specific file' },
        fanOutThreshold: { type: 'number', description: 'Minimum fan-out (default: 8)' },
      },
      required: ['directory'],
    },
    async execute(directory, args) {
      const result = await handleGetGodFunctions(
        (args.directory as string) ?? directory,
        args.filePath as string | undefined,
        (args.fanOutThreshold as number) ?? 8
      );
      return { result, filePaths: extractFilePaths(result) };
    },
  },

  // ── Suggest insertion points ─────────────────────────────────────────────
  {
    name: 'suggest_insertion_points',
    description:
      'Find the best places to implement a new feature using semantic + structural analysis. ' +
      'Use this when the user asks where to add a feature or how to integrate something new. ' +
      'Requires a vector index (spec-gen analyze --embed).',
    inputSchema: {
      type: 'object',
      properties: {
        directory:   { type: 'string', description: 'Absolute path to the project directory' },
        description: { type: 'string', description: 'Natural language description of the feature' },
        limit:       { type: 'number', description: 'Number of candidates (default: 5)' },
      },
      required: ['directory', 'description'],
    },
    async execute(directory, args) {
      const result = await handleSuggestInsertionPoints(
        (args.directory as string) ?? directory,
        args.description as string,
        (args.limit as number) ?? 5
      );
      const paths: string[] = [];
      if (result && typeof result === 'object') {
        const r = result as Record<string, unknown>;
        for (const c of (r.candidates as Array<{ filePath?: string }>) ?? []) {
          if (c.filePath) paths.push(c.filePath);
        }
      }
      return { result, filePaths: [...new Set(paths)] };
    },
  },

  // ── Semantic code search ─────────────────────────────────────────────────
  {
    name: 'search_code',
    description:
      'Semantic search over the codebase to find functions by meaning. ' +
      'Use this when the user asks "where is X implemented?" or "which code handles Y?". ' +
      'Requires a vector index (spec-gen analyze --embed).',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Absolute path to the project directory' },
        query:     { type: 'string', description: 'Natural language search query' },
        limit:     { type: 'number', description: 'Results to return (default: 10)' },
      },
      required: ['directory', 'query'],
    },
    async execute(directory, args) {
      const result = await handleSearchCode(
        (args.directory as string) ?? directory,
        args.query as string,
        (args.limit as number) ?? 10
      );
      const paths: string[] = [];
      if (result && typeof result === 'object') {
        const r = result as Record<string, unknown>;
        for (const res of (r.results as Array<{ filePath?: string }>) ?? []) {
          if (res.filePath) paths.push(res.filePath);
        }
      }
      return { result, filePaths: [...new Set(paths)] };
    },
  },

  // ── List spec domains ────────────────────────────────────────────────────
  {
    name: 'list_spec_domains',
    description:
      'List all OpenSpec domains available in this project. ' +
      'Use this first when the user asks a broad spec question and you need to discover ' +
      'what domains exist before doing a targeted search_specs call.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Absolute path to the project directory' },
      },
      required: ['directory'],
    },
    async execute(directory, args) {
      const result = await handleListSpecDomains((args.directory as string) ?? directory);
      return { result, filePaths: [] };
    },
  },

  // ── Spec semantic search ─────────────────────────────────────────────────
  {
    name: 'search_specs',
    description:
      'Semantic search over OpenSpec specifications to find requirements, design notes, ' +
      'and architecture decisions by meaning. Returns linked source files for graph highlighting. ' +
      'Use this when the user asks "which spec covers X?", "what requirement describes Y?", ' +
      'or "where should we implement Z?" (spec-first approach). ' +
      'Requires a spec index (spec-gen analyze --embed or --reindex-specs).',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Absolute path to the project directory' },
        query:     { type: 'string', description: 'Natural language search query' },
        limit:     { type: 'number', description: 'Results to return (default: 10)' },
        domain:    { type: 'string', description: 'Filter by domain name (e.g. "auth", "analyzer")' },
        section:   {
          type: 'string',
          description: 'Filter by section type: "requirements", "purpose", "design", "architecture", "entities"',
        },
      },
      required: ['directory', 'query'],
    },
    async execute(directory, args) {
      const result = await handleSearchSpecs(
        (args.directory as string) ?? directory,
        args.query as string,
        (args.limit as number) ?? 10,
        args.domain as string | undefined,
        args.section as string | undefined,
      );
      // linkedFiles arrays are returned per result — collect all for graph highlighting
      const paths: string[] = [];
      if (result && typeof result === 'object') {
        const r = result as Record<string, unknown>;
        for (const res of (r.results as Array<{ linkedFiles?: string[] }>) ?? []) {
          for (const f of res.linkedFiles ?? []) paths.push(f);
        }
      }
      return { result, filePaths: [...new Set(paths)] };
    },
  },

  // ── Get spec by domain ───────────────────────────────────────────────────
  {
    name: 'get_spec',
    description:
      'Return the full content of a spec domain\'s specification file plus the functions ' +
      'that implement it. Use this when the user asks "show me the auth spec" or ' +
      '"what does the spec say about X domain?".',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Absolute path to the project directory' },
        domain:    { type: 'string', description: 'Domain name, e.g. "auth" or "analyzer"' },
      },
      required: ['directory', 'domain'],
    },
    async execute(directory, args) {
      const result = await handleGetSpec(
        (args.directory as string) ?? directory,
        args.domain as string,
      );
      return { result, filePaths: [] };
    },
  },

  // ── Get function body ────────────────────────────────────────────────────
  {
    name: 'get_function_body',
    description:
      'Return the full source code of a named function. Use this after search_code ' +
      'or suggest_insertion_points to read the actual implementation before deciding ' +
      'where to make changes.',
    inputSchema: {
      type: 'object',
      properties: {
        directory:    { type: 'string', description: 'Absolute path to the project directory' },
        filePath:     { type: 'string', description: 'Relative file path, e.g. "src/auth/jwt.ts"' },
        functionName: { type: 'string', description: 'Function name, e.g. "verifyToken"' },
      },
      required: ['directory', 'filePath', 'functionName'],
    },
    async execute(directory, args) {
      const result = await handleGetFunctionBody(
        (args.directory as string) ?? directory,
        args.filePath as string,
        args.functionName as string,
      );
      const paths: string[] = [];
      if (result && typeof result === 'object') {
        const r = result as Record<string, unknown>;
        if (typeof r.filePath === 'string') paths.push(r.filePath);
      }
      return { result, filePaths: paths };
    },
  },

  // ── Get file dependencies ────────────────────────────────────────────────
  {
    name: 'get_file_dependencies',
    description:
      'Return the file-level import dependencies for a source file. ' +
      'Use this when the user asks "what does X depend on?" or "what imports Y?" ' +
      'to understand coupling or plan a refactor.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Absolute path to the project directory' },
        filePath:  { type: 'string', description: 'Relative file path, e.g. "src/core/analyzer/vector-index.ts"' },
        direction: {
          type: 'string',
          enum: ['imports', 'importedBy', 'both'],
          description: '"imports", "importedBy", or "both" (default)',
        },
      },
      required: ['directory', 'filePath'],
    },
    async execute(directory, args) {
      const result = await handleGetFileDependencies(
        (args.directory as string) ?? directory,
        args.filePath as string,
        (args.direction as 'imports' | 'importedBy' | 'both') ?? 'both',
      );
      const paths: string[] = [];
      if (result && typeof result === 'object') {
        const r = result as Record<string, unknown>;
        for (const dep of (r.imports as Array<{ filePath?: string }>) ?? []) {
          if (dep.filePath) paths.push(dep.filePath);
        }
        for (const dep of (r.importedBy as Array<{ filePath?: string }>) ?? []) {
          if (dep.filePath) paths.push(dep.filePath);
        }
      }
      return { result, filePaths: [...new Set(paths)] };
    },
  },

  // ── Architecture Decision Records ────────────────────────────────────────
  {
    name: 'get_decisions',
    description:
      'List or search Architecture Decision Records (ADRs). Use this when the user asks ' +
      '"why was X decided?" or "is there an ADR about Y?" to surface documented decisions.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Absolute path to the project directory' },
        query:     { type: 'string', description: 'Optional text filter on title or content' },
      },
      required: ['directory'],
    },
    async execute(directory, args) {
      const result = await handleGetDecisions(
        (args.directory as string) ?? directory,
        args.query as string | undefined,
      );
      return { result, filePaths: [] };
    },
  },

  // ── Refactor report ──────────────────────────────────────────────────────
  {
    name: 'get_refactor_report',
    description:
      'Return a prioritized refactor report: unreachable code, hub overload, god functions, ' +
      'SRP violations, cyclic dependencies. Use this when the user asks about code quality ' +
      'or what to improve.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Absolute path to the project directory' },
      },
      required: ['directory'],
    },
    async execute(directory, args) {
      const result = await handleGetRefactorReport((args.directory as string) ?? directory);
      return { result, filePaths: extractFilePaths(result) };
    },
  },
];

// ============================================================================
// HELPERS
// ============================================================================

/** Convert CHAT_TOOLS to the OpenAI function-calling format. */
export function toChatToolDefinitions() {
  return CHAT_TOOLS.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}
