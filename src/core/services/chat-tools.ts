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
  handleGetFileDependencies,
} from './mcp-handlers/graph.js';

import {
  handleSearchCode,
  handleSuggestInsertionPoints,
  handleSearchSpecs,
  handleListSpecDomains,
  handleGetSpec,
} from './mcp-handlers/semantic.js';

import {
  handleGetArchitectureOverview,
  handleGetRefactorReport,
  handleGetDecisions,
} from './mcp-handlers/analysis.js';

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
      'USE THIS WHEN: the user asks "how is this project organized?", "what are the main ' +
      'components?", or wants a broad overview before diving in. ' +
      'Returns domain clusters, cross-cluster dependencies, global entry points, and critical ' +
      'hubs in one call — faster than reading package.json + directory tree yourself.',
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
      'USE THIS WHEN: the user asks "which functions are called the most?", "what are ' +
      'the critical bottlenecks?", or "are there layer violations?". ' +
      'Returns hub functions, entry points, and architecture violations across all files — ' +
      'impossible to reconstruct by reading individual files.',
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
      'USE THIS WHEN: the user needs to trace calls from or to a specific function — ' +
      '"what does X call?", "who calls Y?", "show me the call chain for Z". ' +
      'More targeted than get_call_graph. Works across all files without you having to ' +
      'grep through each one.',
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
      'USE THIS WHEN: the user asks "what breaks if I change X?", "what\'s the blast radius ' +
      'of modifying Y?", or "is it safe to refactor Z?". ' +
      'Returns risk score, fan-in/out, and full upstream/downstream call chains — ' +
      'gives the complete picture without reading every caller file.',
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
      'USE THIS WHEN: the user asks "what\'s the most central code?", "what should I ' +
      'refactor to reduce coupling?", or "which functions are shared the most?". ' +
      'Lists the highest fan-in functions — modifying them has the widest blast radius.',
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
      'USE THIS WHEN: the user asks "which functions do too much?", "what are the worst ' +
      'SRP violations?", or "which functions should be split?". ' +
      'Finds high fan-out orchestrators — the functions most likely to need decomposition.',
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
      'USE THIS WHEN: the user asks "where should I add X?", "where\'s the best place to ' +
      'implement Y?", or "how do I integrate Z into the existing code?". ' +
      'Combines semantic search + call graph to find ranked candidates with context — ' +
      'far more targeted than grepping for similar patterns.',
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
      'USE THIS WHEN: you don\'t know which file or function handles a concept — ' +
      '"where is rate limiting implemented?", "which function validates tokens?", ' +
      '"what handles authentication?". Beats grep when the function name is unknown. ' +
      'Falls back to keyword search automatically if the embedding server is down.',
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

  // ── Spec semantic search (+ domain discovery when query is omitted) ──────
  {
    name: 'search_specs',
    description:
      'USE THIS WHEN: the user asks "which spec covers X?", "what does the spec say about Y?", ' +
      '"which requirement describes Z?", or "what domains exist?". ' +
      'Omit query to list available spec domains. Provide a query to search by meaning. ' +
      'Returns linked source files for graph highlighting.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Absolute path to the project directory' },
        query:     { type: 'string', description: 'Natural language search query (omit to list domains)' },
        limit:     { type: 'number', description: 'Results to return (default: 10)' },
        domain:    { type: 'string', description: 'Filter by domain name (e.g. "auth", "analyzer")' },
        section:   {
          type: 'string',
          description: 'Filter by section type: "requirements", "purpose", "design", "architecture", "entities"',
        },
      },
      required: ['directory'],
    },
    async execute(directory, args) {
      const dir = (args.directory as string) ?? directory;
      // No query → return domain list instead
      if (!args.query) {
        const result = await handleListSpecDomains(dir);
        return { result, filePaths: [] };
      }
      const result = await handleSearchSpecs(
        dir,
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
      'USE THIS WHEN: the user asks to read a specific spec domain — "show me the auth ' +
      'spec", "what does the analyzer spec say?", "read the API spec". ' +
      'Returns the full spec content and the functions that implement it, in one call.',
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

  // ── Get file dependencies ────────────────────────────────────────────────
  {
    name: 'get_file_dependencies',
    description:
      'USE THIS WHEN: the user asks "what does file X import?", "what files depend on Y?", ' +
      'or when planning a refactor and needing to understand coupling before touching a file. ' +
      'Uses pre-computed in/out degree — no need to grep import statements across the codebase.',
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
      'USE THIS WHEN: the user asks "why was X decided?", "is there an ADR about Y?", ' +
      'or "what\'s the rationale behind Z?". Lists documented architectural decisions — ' +
      'gives the "why" that is not visible in the code itself.',
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
      'USE THIS WHEN: the user asks "what should I clean up?", "what\'s the biggest ' +
      'technical debt?", or "what are the worst code quality issues?". ' +
      'Returns a prioritized list: unreachable code, hub overload, god functions, ' +
      'SRP violations, cyclic dependencies — all in one report.',
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
