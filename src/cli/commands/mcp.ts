/**
 * spec-gen MCP Server
 *
 * Exposes spec-gen's static analysis capabilities as Model Context Protocol
 * tools, usable from Cline, Claude Code, or any MCP-compatible AI agent.
 *
 * Transport: stdio (standard for editor-embedded MCP servers)
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
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { sanitizeMcpError, validateDirectory } from '../../core/services/mcp-handlers/utils.js';
import { DEFAULT_DRIFT_MAX_FILES } from '../../constants.js';
import {
  handleGetCallGraph,
  handleGetSubgraph,
  handleAnalyzeImpact,
  handleGetLowRiskRefactorCandidates,
  handleGetLeafFunctions,
  handleGetCriticalHubs,
  handleGetGodFunctions,
  handleGetFileDependencies,
} from '../../core/services/mcp-handlers/graph.js';
import {
  handleSearchCode,
  handleSuggestInsertionPoints,
  handleSearchSpecs,
  handleListSpecDomains,
  handleGetSpec,
} from '../../core/services/mcp-handlers/semantic.js';
import { handleOrient } from '../../core/services/mcp-handlers/orient.js';
import {
  handleAnalyzeCodebase,
  handleGetArchitectureOverview,
  handleGetRefactorReport,
  handleGetDuplicateReport,
  handleGetSignatures,
  handleGetMapping,
  handleCheckSpecDrift,
  handleGetFunctionSkeleton,
  handleGetFunctionBody,
  handleGetDecisions,
} from '../../core/services/mcp-handlers/analysis.js';

// Re-export utilities for tests
export { sanitizeMcpError, validateDirectory };

// Re-export handlers for use by chat-tools.ts and tests
export {
  handleGetCallGraph,
  handleGetSubgraph,
  handleAnalyzeImpact,
  handleGetLowRiskRefactorCandidates,
  handleGetLeafFunctions,
  handleGetCriticalHubs,
  handleGetGodFunctions,
  handleSearchCode,
  handleSuggestInsertionPoints,
  handleSearchSpecs,
  handleAnalyzeCodebase,
  handleGetArchitectureOverview,
  handleGetRefactorReport,
  handleGetDuplicateReport,
  handleGetSignatures,
  handleGetMapping,
  handleCheckSpecDrift,
  handleGetFunctionSkeleton,
};

// ============================================================================
// TOOL DEFINITIONS
// ============================================================================

export const TOOL_DEFINITIONS = [
  {
    name: 'orient',
    description:
      'START HERE. Call this before any other tool when beginning a new task on an unfamiliar codebase. ' +
      'Given a natural-language task description, returns in ONE call: relevant functions, source files, ' +
      'spec domains that cover them, depth-1 call neighbours, top insertion point candidates, ' +
      'and matching spec sections. Falls back to keyword search if the embedding server is down. ' +
      'Requires "spec-gen analyze" to have been run at least once.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Absolute path to the project directory',
        },
        task: {
          type: 'string',
          description: 'Natural language description of the task, e.g. "add rate limiting to the HTTP API"',
        },
        limit: {
          type: 'number',
          description: 'Number of relevant functions to return (default: 5)',
        },
      },
      required: ['directory', 'task'],
    },
  },
  {
    name: 'analyze_codebase',
    description:
      'USE THIS WHEN: the project has never been analyzed, or the user says the code changed ' +
      'significantly since the last run, or other tools return "no cache found". ' +
      'Builds the call graph, dependency graph, and refactor priorities — all without an LLM. ' +
      'Results are cached for 1 hour; skip this if the cache is recent.',
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
    name: 'get_architecture_overview',
    description:
      'USE THIS WHEN: onboarding to an unknown codebase, or before planning a large feature. ' +
      'Returns domain clusters, cross-cluster dependencies, global entry points, and critical hubs — ' +
      'faster than reading package.json + directory tree yourself. Run analyze_codebase first.',
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
      'Supports TypeScript, JavaScript, Python, Go, Rust, Ruby, Java, C++. ' +
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
  {
    name: 'check_spec_drift',
    description:
      'USE THIS WHEN: you\'ve modified code and want to know if the specs are still aligned, ' +
      'or when asked "is the code in sync with the spec?", "what changed since the last spec run?". ' +
      'Compares git-changed files against spec coverage — impossible to replicate by reading files. ' +
      'Requires spec-gen generate to have been run at least once. No LLM required.',
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
  {
    name: 'analyze_impact',
    description:
      'USE THIS WHEN: you\'re about to modify a function and want to know the full consequences — ' +
      '"what breaks if I change X?", "what\'s the blast radius of modifying Y?". ' +
      'Returns fan-in/out, full call chains, risk score (0–100), and refactoring strategy. ' +
      'Call this before touching any non-trivial function. Run analyze_codebase first.',
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
  {
    name: 'suggest_insertion_points',
    description:
      'USE THIS WHEN: you need to find where to implement a new feature — ' +
      '"where should I add rate limiting?", "where\'s the best place to add email validation?". ' +
      'Combines semantic search + call graph to return ranked candidates with strategy. ' +
      'Call this before writing any code; then use get_subgraph on the top candidates. ' +
      'Requires "spec-gen analyze --embed".',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Absolute path to the project directory',
        },
        description: {
          type: 'string',
          description:
            'Natural language description of the feature to implement, ' +
            'e.g. "add retry mechanism for HTTP requests" or "validate user email on registration"',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of candidates to return (default: 5)',
        },
        language: {
          type: 'string',
          description: 'Filter by language: "TypeScript", "Python", "Go", "Rust", "Ruby", "Java"',
        },
      },
      required: ['directory', 'description'],
    },
  },
  {
    name: 'search_code',
    description:
      'USE THIS WHEN: you don\'t know which file or function handles a concept — ' +
      '"where is rate limiting implemented?", "which function validates tokens?", ' +
      '"what handles authentication?". Beats grep when the function name is unknown. ' +
      'Falls back to keyword search automatically if the embedding server is down. ' +
      'Requires "spec-gen analyze --embed" to have been run at least once.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Absolute path to the project directory',
        },
        query: {
          type: 'string',
          description: 'Natural language query, e.g. "authenticate user with JWT"',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return (default: 10)',
        },
        language: {
          type: 'string',
          description: 'Filter by language: "TypeScript", "Python", "Go", "Rust", "Ruby", "Java"',
        },
        minFanIn: {
          type: 'number',
          description: 'Only return functions with at least this many callers (hub filter)',
        },
      },
      required: ['directory', 'query'],
    },
  },
  {
    name: 'list_spec_domains',
    description:
      'List all OpenSpec domains available in this project. ' +
      'Use this first when you need to discover what domains exist before doing a targeted search_specs call.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Absolute path to the project directory' },
      },
      required: ['directory'],
    },
  },
  {
    name: 'search_specs',
    description:
      'USE THIS WHEN: asked "which spec covers X?", "what does the spec say about Y?", ' +
      '"which requirement describes Z?". Searches specs by meaning and returns linked source files. ' +
      'Use spec-first: check what the spec says before reading or writing code. ' +
      'Requires "spec-gen analyze --embed" or "spec-gen analyze --reindex-specs".',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Absolute path to the project directory',
        },
        query: {
          type: 'string',
          description: 'Natural language query, e.g. "email validation workflow"',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return (default: 10)',
        },
        domain: {
          type: 'string',
          description: 'Filter by domain name (e.g. "auth", "analyzer")',
        },
        section: {
          type: 'string',
          description: 'Filter by section type: "requirements", "purpose", "design", "architecture", "entities"',
        },
      },
      required: ['directory', 'query'],
    },
  },
  {
    name: 'get_spec',
    description:
      'Return the full content of a spec domain\'s specification file (spec.md) and the ' +
      'functions that implement it. Use this to read requirements directly when you know the ' +
      'domain name. Complements search_specs (which searches by meaning) by giving exact ' +
      'read access to a known domain.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Absolute path to the project directory' },
        domain: {
          type: 'string',
          description: 'Domain name as returned by list_spec_domains (e.g. "auth", "analyzer")',
        },
      },
      required: ['directory', 'domain'],
    },
  },
  {
    name: 'get_function_body',
    description:
      'Return the exact source code of a named function in a file. ' +
      'Use this after search_code or get_function_skeleton to read the full implementation. ' +
      'Requires a prior "spec-gen analyze" run for precise byte-range extraction; ' +
      'falls back to a brace-depth scan when the call graph is unavailable.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Absolute path to the project directory' },
        filePath: {
          type: 'string',
          description: 'File path relative to the project directory, e.g. "src/auth/jwt.ts"',
        },
        functionName: {
          type: 'string',
          description: 'Name of the function to extract, e.g. "verifyToken"',
        },
      },
      required: ['directory', 'filePath', 'functionName'],
    },
  },
  {
    name: 'get_file_dependencies',
    description:
      'Return the file-level import dependencies for a given source file. ' +
      'Answers "what does this file import?" and "what files import this file?". ' +
      'Useful for planning refactors, understanding coupling, or scoping the blast radius ' +
      'of a change. Reads the dependency-graph.json produced by "spec-gen analyze".',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Absolute path to the project directory' },
        filePath: {
          type: 'string',
          description: 'File path relative to the project root, e.g. "src/core/analyzer/vector-index.ts"',
        },
        direction: {
          type: 'string',
          enum: ['imports', 'importedBy', 'both'],
          description: '"imports" = what this file depends on, "importedBy" = what depends on this file, "both" = both directions (default)',
        },
      },
      required: ['directory', 'filePath'],
    },
  },
  {
    name: 'get_decisions',
    description:
      'List or search Architecture Decision Records (ADRs) stored in openspec/decisions/. ' +
      'Use this when you need to understand why an architectural decision was made, ' +
      'or to check whether a pattern is already documented. ' +
      'ADRs are generated by "spec-gen generate --adrs".',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Absolute path to the project directory' },
        query: {
          type: 'string',
          description: 'Optional text filter — returns only ADRs whose title or content contains this string',
        },
      },
      required: ['directory'],
    },
  },
];

// ============================================================================
// MCP SERVER
// ============================================================================

interface McpServerOptions {
  watch?: string;
  watchAuto?: boolean;
  watchEmbed?: boolean;
  watchDebounce?: string;
}

async function startMcpServer(options: McpServerOptions = {}): Promise<void> {
  const server = new Server(
    { name: 'spec-gen', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  // --watch-auto: start the watcher on the first tool call that carries a directory
  let autoWatcher: import('../../core/services/mcp-watcher.js').McpWatcher | undefined;

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    if (options.watchAuto && !autoWatcher) {
      const dir = (args as Record<string, unknown>).directory;
      if (typeof dir === 'string') {
        const { resolve } = await import('node:path');
        const { McpWatcher } = await import('../../core/services/mcp-watcher.js');
        const debounceMs = parseInt(options.watchDebounce ?? '400', 10);
        autoWatcher = new McpWatcher({
          rootPath: resolve(dir),
          debounceMs: isNaN(debounceMs) ? 400 : debounceMs,
          embed: options.watchEmbed ?? false,
        });
        await autoWatcher.start();
        const cleanup = () => autoWatcher!.stop().then(() => process.exit(0));
        process.on('SIGINT',  cleanup);
        process.on('SIGTERM', cleanup);
      }
    }

    try {
      let result: unknown;

      if (name === 'orient') {
        const { directory, task, limit = 5 } = args as { directory: string; task: string; limit?: number };
        result = await handleOrient(directory, task, limit);
      } else if (name === 'analyze_codebase') {
        const { directory, force = false } = args as { directory: string; force?: boolean };
        result = await handleAnalyzeCodebase(directory, force);
      } else if (name === 'get_architecture_overview') {
        const { directory } = args as { directory: string };
        result = await handleGetArchitectureOverview(directory);
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
        const { directory, base = 'auto', files = [], domains = [], failOn = 'warning', maxFiles = DEFAULT_DRIFT_MAX_FILES } =
          args as { directory: string; base?: string; files?: string[]; domains?: string[]; failOn?: 'error' | 'warning' | 'info'; maxFiles?: number };
        result = await handleCheckSpecDrift(directory, base, files, domains, failOn, maxFiles);
      } else if (name === 'search_code') {
        const { directory, query, limit = 10, language, minFanIn } =
          args as { directory: string; query: string; limit?: number; language?: string; minFanIn?: number };
        result = await handleSearchCode(directory, query, limit, language, minFanIn);
      } else if (name === 'suggest_insertion_points') {
        const { directory, description, limit = 5, language } =
          args as { directory: string; description: string; limit?: number; language?: string };
        result = await handleSuggestInsertionPoints(directory, description, limit, language);
      } else if (name === 'search_specs') {
        const { directory, query, limit = 10, domain, section } =
          args as { directory: string; query: string; limit?: number; domain?: string; section?: string };
        result = await handleSearchSpecs(directory, query, limit, domain, section);
      } else if (name === 'list_spec_domains') {
        const { directory } = args as { directory: string };
        result = await handleListSpecDomains(directory);
      } else if (name === 'get_spec') {
        const { directory, domain } = args as { directory: string; domain: string };
        result = await handleGetSpec(directory, domain);
      } else if (name === 'get_function_body') {
        const { directory, filePath, functionName } =
          args as { directory: string; filePath: string; functionName: string };
        result = await handleGetFunctionBody(directory, filePath, functionName);
      } else if (name === 'get_file_dependencies') {
        const { directory, filePath, direction = 'both' } =
          args as { directory: string; filePath: string; direction?: 'imports' | 'importedBy' | 'both' };
        result = await handleGetFileDependencies(directory, filePath, direction);
      } else if (name === 'get_decisions') {
        const { directory, query } = args as { directory: string; query?: string };
        result = await handleGetDecisions(directory, query);
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

  if (options.watch) {
    const { resolve } = await import('node:path');
    const { McpWatcher } = await import('../../core/services/mcp-watcher.js');
    const debounceMs = parseInt(options.watchDebounce ?? '400', 10);
    const watcher = new McpWatcher({
      rootPath: resolve(options.watch),
      debounceMs: isNaN(debounceMs) ? 400 : debounceMs,
      embed: options.watchEmbed ?? false,
    });
    await watcher.start();
    const cleanup = () => watcher.stop().then(() => process.exit(0));
    process.on('SIGINT',  cleanup);
    process.on('SIGTERM', cleanup);
  }
}

// ============================================================================
// COMMAND EXPORT
// ============================================================================

export const mcpCommand = new Command('mcp')
  .description('Start spec-gen as an MCP server (stdio transport, for Cline/Claude Code)')
  .option('--watch <directory>', 'Watch a project directory and incrementally re-index signatures on file changes')
  .option('--watch-auto', 'Auto-detect the project directory from the first tool call and start watching (recommended for Cline/Claude Code)', false)
  .option('--watch-embed', 'Also re-embed changed functions into the vector index when watching (requires embedding server)', false)
  .option('--watch-debounce <ms>', 'Debounce delay in ms before re-indexing after a file change (default: 400)', '400')
  .action((options: McpServerOptions) => startMcpServer(options));
