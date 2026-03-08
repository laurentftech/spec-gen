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
import {
  handleGetCallGraph,
  handleGetSubgraph,
  handleAnalyzeImpact,
  handleGetLowRiskRefactorCandidates,
  handleGetLeafFunctions,
  handleGetCriticalHubs,
  handleGetGodFunctions,
} from '../../core/services/mcp-handlers/graph.js';
import {
  handleSearchCode,
  handleSuggestInsertionPoints,
  handleSearchSpecs,
  handleListSpecDomains,
} from '../../core/services/mcp-handlers/semantic.js';
import {
  handleAnalyzeCodebase,
  handleGetArchitectureOverview,
  handleGetRefactorReport,
  handleGetDuplicateReport,
  handleGetSignatures,
  handleGetMapping,
  handleCheckSpecDrift,
  handleGetFunctionSkeleton,
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
    name: 'get_architecture_overview',
    description:
      'Return a high-level architecture map of the project: domain clusters with their ' +
      'key files and roles, cross-cluster dependencies, global entry points, and critical hubs. ' +
      'Start here when onboarding to an unknown codebase or before planning a large feature. ' +
      'Run analyze_codebase first.',
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
  {
    name: 'suggest_insertion_points',
    description:
      'Find the best places in the codebase to implement a new feature described in natural language. ' +
      'Combines semantic similarity with structural analysis (entry points, orchestrators, hubs) ' +
      'to return ranked insertion candidates with an actionable strategy for each. ' +
      'Ideal before implementing a feature: run this first, then use get_subgraph or ' +
      'get_function_skeleton on the top candidates to understand the local context. ' +
      'Requires a vector index built with "spec-gen analyze --embed".',
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
      'Semantic search over indexed functions using a natural language query. ' +
      'Returns the closest functions by meaning — useful for finding implementations, ' +
      'understanding how a concept is handled, or navigating unfamiliar codebases. ' +
      'Requires a vector index built with "spec-gen analyze --embed". ' +
      'Configure the embedding endpoint via EMBED_BASE_URL + EMBED_MODEL env vars ' +
      'or the "embedding" section in .spec-gen/config.json.',
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
      'Semantic search over OpenSpec specifications to find requirements, design notes, ' +
      'and architecture decisions by meaning. Returns linked source files for graph highlighting. ' +
      'Use this when asked "which spec covers X?", "what requirement describes Y?", ' +
      'or "where should we implement Z?" (spec-first approach). ' +
      'Requires a spec index built with "spec-gen analyze --embed" or "spec-gen analyze --reindex-specs". ' +
      'Configure the embedding endpoint via EMBED_BASE_URL + EMBED_MODEL env vars ' +
      'or the "embedding" section in .spec-gen/config.json.',
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
];

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
        const { directory, base = 'auto', files = [], domains = [], failOn = 'warning', maxFiles = 100 } =
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
}

// ============================================================================
// COMMAND EXPORT
// ============================================================================

export const mcpCommand = new Command('mcp')
  .description('Start spec-gen as an MCP server (stdio transport, for Cline/Claude Code)')
  .action(startMcpServer);
