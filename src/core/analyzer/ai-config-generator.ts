/**
 * AI Config File Generator
 *
 * Generates tool-specific AI context files during `spec-gen analyze`:
 *   - .cursorrules            (Cursor IDE)
 *   - .clinerules/spec-gen.md (Cline / Roo Code / Kilocode)
 *   - CLAUDE.md               (Claude Code)
 *   - .github/copilot-instructions.md  (GitHub Copilot)
 *   - .windsurf/rules.md      (Windsurf)
 *
 * Files are NEVER overwritten — if a file already exists it is skipped silently.
 * Returns the list of paths that were actually created.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileExists } from '../../utils/command-helpers.js';

// ============================================================================
// TYPES
// ============================================================================

/** Supported AI assistant targets */
export type AiTool = 'claude' | 'cursor' | 'cline' | 'copilot' | 'windsurf' | 'vibe' | 'agents';

export interface AiConfigOptions {
  /** Absolute path to the project root */
  rootDir: string;
  /** Relative path to the analysis output directory (e.g. ".spec-gen/analysis") */
  analysisDir: string;
  /** Project name shown in the generated header */
  projectName: string;
  /**
   * Which tools to generate configs for.
   * Defaults to all tools if omitted.
   */
  tools?: AiTool[];
}

// ============================================================================
// TOOL REGISTRY
// ============================================================================

interface ToolTarget {
  tool: AiTool;
  /** Display label shown in the interactive prompt */
  label: string;
  /** Relative path from project root */
  rel: string;
  /** Use @-import syntax (Claude Code) vs HTML comment */
  forClaude: boolean;
}

export const AI_TOOL_TARGETS: ToolTarget[] = [
  { tool: 'claude',   label: 'Claude Code    (CLAUDE.md)',                        rel: 'CLAUDE.md',                              forClaude: true  },
  { tool: 'cursor',   label: 'Cursor         (.cursorrules)',                      rel: '.cursorrules',                           forClaude: false },
  { tool: 'cline',    label: 'Cline / Roo    (.clinerules/spec-gen.md)',           rel: '.clinerules/spec-gen.md',                forClaude: false },
  { tool: 'copilot',  label: 'GitHub Copilot (.github/copilot-instructions.md)',  rel: '.github/copilot-instructions.md',        forClaude: false },
  { tool: 'windsurf', label: 'Windsurf       (.windsurf/rules.md)',               rel: '.windsurf/rules.md',                     forClaude: false },
  { tool: 'vibe',    label: 'Mistral Vibe   (.vibe/skills/spec-gen.md)',          rel: '.vibe/skills/spec-gen.md',               forClaude: false },
  { tool: 'agents',  label: 'OpenAI Codex  (AGENTS.md)',                          rel: 'AGENTS.md',                              forClaude: false },
];

// ============================================================================
// TEMPLATE
// ============================================================================

const MCP_TOOLS_TABLE = `
## spec-gen MCP workflow

**Follow this sequence for every task:**

1. **\`orient "<task description>"\`** — always start here. Returns relevant functions, files, spec domains, call paths, and insertion points in one call.
2. **If the task involves data models, APIs, or config** — call the relevant inventory tool:
   \`get_schema_inventory\` · \`get_route_inventory\` · \`get_env_vars\` · \`get_ui_components\` · \`get_middleware_inventory\`
3. **If debugging a call flow** ("how does X reach Y?") — \`trace_execution_path\`
4. **Before modifying a function** — \`get_subgraph\` to understand blast radius
5. **Before opening a PR** — \`check_spec_drift\`

**On-demand** (when orient's results aren't enough):
\`search_code\` · \`suggest_insertion_points\` · \`get_spec <domain>\` · \`search_specs\` · \`analyze_impact\` · \`get_function_body\` · \`get_function_skeleton\`

## Architectural decisions

When making a significant design choice, call \`record_decision\` **before** writing the code.

Significant choices: data structure, library/dependency, API contract, auth strategy, module boundary, database schema, caching approach, error handling pattern.

\`\`\`
record_decision({
  title: "Use JWTs for stateless auth",         // short imperative
  rationale: "Avoids session store in infra",   // why this choice
  consequences: "Tokens can't be revoked early", // trade-offs
  affectedFiles: ["src/auth/middleware.ts"],    // optional
  supersedes: "a1b2c3d4"                        // 8-char ID of prior decision being reversed
})
\`\`\`

Decisions are consolidated in the background immediately after \`record_decision\` is called — the pre-commit gate reads the already-consolidated store and adds no LLM latency.

**Performance note**: if you skip \`record_decision\`, the gate detects unrecorded source changes at commit time and triggers a slow LLM extraction on the *next* commit (~10-30s). Calling \`record_decision\` proactively keeps every commit instant. Do not record trivial choices (variable names, formatting).
`.trim();

function buildContent(analysisDir: string, projectName: string, forClaude: boolean): string {
  const digestRef = forClaude
    ? `@${analysisDir}/CODEBASE.md`
    : `<!-- Import or paste ${analysisDir}/CODEBASE.md here for full project context -->`;

  return [
    `# ${projectName} — AI context (generated by spec-gen)`,
    '',
    digestRef,
    '',
    MCP_TOOLS_TABLE,
  ].join('\n');
}

// ============================================================================
// HELPERS
// ============================================================================

async function writeIfAbsent(filePath: string, content: string): Promise<boolean> {
  if (await fileExists(filePath)) return false;
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf-8');
  return true;
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Generate AI tool config files in the project root.
 * Skips any file that already exists.
 *
 * @param options.tools - Which assistants to generate for. Defaults to all.
 * @returns Relative paths (from rootDir) of files that were actually created.
 */
export interface AiConfigResult {
  /** Relative path from rootDir */
  rel: string;
  /** true = created now, false = already existed */
  created: boolean;
}

export async function generateAiConfigs(options: AiConfigOptions): Promise<AiConfigResult[]> {
  const { rootDir, analysisDir, projectName, tools } = options;

  const targets = tools
    ? AI_TOOL_TARGETS.filter(t => tools.includes(t.tool))
    : AI_TOOL_TARGETS;

  return Promise.all(
    targets.map(async ({ rel, forClaude }) => {
      const absPath = join(rootDir, rel);
      const content = buildContent(analysisDir, projectName, forClaude);
      const created = await writeIfAbsent(absPath, content);
      return { rel, created };
    })
  );
}

