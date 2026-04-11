/**
 * spec-gen setup command
 *
 * Installs workflow skills and agent integration files into the current project.
 * Unlike `analyze --ai-configs` (which generates project-specific context files),
 * `setup` copies static workflow assets that are the same for every project:
 *
 *   - Mistral Vibe skills  -> .vibe/skills/spec-gen-{name}/SKILL.md      (8 skills)
 *   - Cline workflows      -> .clinerules/workflows/spec-gen-{name}.md
 *   - Claude Code skills   -> .claude/skills/spec-gen-{name}/SKILL.md    (8 skills)
 *   - OpenCode skills      -> .opencode/skills/spec-gen-{name}/SKILL.md  (8 skills)
 *   - GSD commands         -> .claude/commands/gsd/spec-gen-{name}.md
 *
 * Files are never overwritten — existing files are skipped silently.
 * Assets are read from the `examples/` directory shipped with the spec-gen package.
 */

import { Command } from 'commander';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkbox } from '@inquirer/prompts';
import { logger } from '../../utils/logger.js';

// ============================================================================
// TYPES
// ============================================================================

type ToolName = 'vibe' | 'cline' | 'gsd' | 'bmad' | 'claude' | 'opencode';

interface SkillEntry {
  /** Absolute source path inside the package's examples/ directory */
  src: string;
  /** Relative destination path from the project root */
  dest: string;
}

interface SetupResult {
  tool: ToolName;
  rel: string;
  created: boolean;
}

// ============================================================================
// HELPERS
// ============================================================================

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Root of the spec-gen package (dist/cli/commands -> ../../.. -> package root) */
const PACKAGE_ROOT = join(__dirname, '../../..');

async function fileExists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

async function copyIfAbsent(src: string, dest: string): Promise<boolean> {
  if (await fileExists(dest)) return false;
  const content = await readFile(src, 'utf-8');
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, content, 'utf-8');
  return true;
}

// ============================================================================
// SKILL MANIFESTS
// ============================================================================

function buildManifest(projectRoot: string): Record<ToolName, SkillEntry[]> {
  const ex = join(PACKAGE_ROOT, 'examples');

  const VIBE_SKILLS = [
    'spec-gen-analyze-codebase',
    'spec-gen-brainstorm',
    'spec-gen-debug',
    'spec-gen-execute-refactor',
    'spec-gen-generate',
    'spec-gen-implement-story',
    'spec-gen-plan-refactor',
    'spec-gen-write-tests',
  ];

  const OPENCODE_SKILLS = VIBE_SKILLS; // same skill names, different source + dest

  const CLINE_WORKFLOWS = [
    'spec-gen-analyze-codebase.md',
    'spec-gen-check-spec-drift.md',
    'spec-gen-execute-refactor.md',
    'spec-gen-implement-feature.md',
    'spec-gen-plan-refactor.md',
    'spec-gen-refactor-codebase.md',
    'spec-gen-write-tests.md',
  ];

  const GSD_COMMANDS = [
    'spec-gen-orient.md',
    'spec-gen-drift.md',
  ];

  const BMAD_AGENTS = ['architect.md', 'dev-brownfield.md'];
  const BMAD_TASKS  = ['implement-story.md', 'onboarding.md', 'refactor.md', 'sprint-planning.md'];

  return {
    vibe: VIBE_SKILLS.map(name => ({
      src: join(ex, 'mistral-vibe', 'skills', name, 'SKILL.md'),
      dest: join(projectRoot, '.vibe', 'skills', name, 'SKILL.md'),
    })),
    cline: CLINE_WORKFLOWS.map(file => ({
      src: join(ex, 'cline-workflows', file),
      dest: join(projectRoot, '.clinerules', 'workflows', file),
    })),
    gsd: GSD_COMMANDS.map(file => ({
      src: join(ex, 'gsd', 'commands', 'gsd', file),
      dest: join(projectRoot, '.claude', 'commands', 'gsd', file),
    })),
    bmad: [
      ...BMAD_AGENTS.map(file => ({
        src: join(ex, 'bmad', 'agents', file),
        dest: join(projectRoot, '_bmad', 'spec-gen', 'agents', file),
      })),
      ...BMAD_TASKS.map(file => ({
        src: join(ex, 'bmad', 'tasks', file),
        dest: join(projectRoot, '_bmad', 'spec-gen', 'tasks', file),
      })),
    ],
    claude: OPENCODE_SKILLS.map(name => ({
      src: join(ex, 'opencode-skills', name, 'SKILL.md'),
      dest: join(projectRoot, '.claude', 'skills', name, 'SKILL.md'),
    })),
    opencode: OPENCODE_SKILLS.map(name => ({
      src: join(ex, 'opencode-skills', name, 'SKILL.md'),
      dest: join(projectRoot, '.opencode', 'skills', name, 'SKILL.md'),
    })),
  };
}

// ============================================================================
// CORE
// ============================================================================

async function runSetup(
  projectRoot: string,
  tools: ToolName[],
): Promise<SetupResult[]> {
  const manifest = buildManifest(projectRoot);
  const results: SetupResult[] = [];

  for (const tool of tools) {
    for (const entry of manifest[tool]) {
      if (!await fileExists(entry.src)) {
        logger.warning(`setup: source not found — ${entry.src} (re-install spec-gen to fix)`);
        continue;
      }
      const created = await copyIfAbsent(entry.src, entry.dest);
      const rel = entry.dest.startsWith(projectRoot)
        ? entry.dest.slice(projectRoot.length).replace(/^\//, '')
        : entry.dest;
      results.push({ tool, rel, created });
    }
  }

  return results;
}

// ============================================================================
// COMMAND
// ============================================================================

export const setupCommand = new Command('setup')
  .description(
    'Install workflow skills and agent integration files into this project.\n' +
    'Copies static assets from the spec-gen package — safe to re-run (skips existing files).'
  )
  .option(
    '--tools <list>',
    'Comma-separated list of tools to install: vibe, cline, claude, opencode, gsd, bmad (default: all)',
  )
  .option(
    '--dir <path>',
    'Project root directory',
    process.cwd(),
  )
  .action(async (options: { tools?: string; dir: string }) => {
    const projectRoot = options.dir;
    const allTools: ToolName[] = ['vibe', 'cline', 'gsd', 'bmad', 'claude', 'opencode'];

    let tools: ToolName[];
    if (options.tools) {
      tools = (options.tools.split(',').map(t => t.trim()) as ToolName[]).filter(t => allTools.includes(t));
      if (tools.length === 0) {
        logger.error('setup: no valid tools specified. Valid values: vibe, cline, gsd, bmad, claude, opencode');
        process.exit(1);
      }
    } else if (process.stdout.isTTY) {
      const selected = await checkbox({
        message: 'Which agent tools do you want to install skills for?',
        choices: [
          { name: 'Mistral Vibe  (.vibe/skills/spec-gen-{name}/SKILL.md — 8 skills)', value: 'vibe' as ToolName, checked: true },
          { name: 'Cline / Roo   (.clinerules/workflows/spec-gen-{name}.md — 7 workflows)', value: 'cline' as ToolName, checked: true },
          { name: 'Claude Code   (.claude/skills/spec-gen-{name}/SKILL.md — 8 skills)', value: 'claude' as ToolName, checked: true },
          { name: 'OpenCode      (.opencode/skills/spec-gen-{name}/SKILL.md — 8 skills)', value: 'opencode' as ToolName, checked: false },
          { name: 'GSD           (.claude/commands/gsd/spec-gen-{name}.md — 2 commands)', value: 'gsd' as ToolName, checked: true },
          { name: 'BMAD          (_bmad/spec-gen/{agents,tasks}/ — 2 agents, 4 tasks)', value: 'bmad' as ToolName, checked: false },
        ],
      });
      if (selected.length === 0) {
        console.log('Nothing selected — exiting.');
        process.exit(0);
      }
      tools = selected;
    } else {
      // Non-TTY: install all except BMAD (more invasive) and OpenCode (less common)
      tools = ['vibe', 'cline', 'claude', 'gsd'];
    }

    logger.success(`Installing workflow skills into ${projectRoot}`);

    let results: SetupResult[];
    try {
      results = await runSetup(projectRoot, tools);
    } catch (err) {
      logger.error(`setup failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    // ── Report ───────────────────────────────────────────────────────────────
    const byTool: Record<string, SetupResult[]> = {};
    for (const r of results) {
      (byTool[r.tool] ??= []).push(r);
    }

    const LABELS: Record<ToolName, string> = {
      vibe:    'Mistral Vibe',
      cline:   'Cline / Roo Code',
      claude:  'Claude Code',
      opencode: 'OpenCode',
      gsd:     'get-shit-done (GSD)',
      bmad:    'BMAD',
    };

    for (const tool of tools) {
      const entries = byTool[tool] ?? [];
      const created = entries.filter(e => e.created).length;
      const skipped = entries.filter(e => !e.created).length;
      console.log(`\n${LABELS[tool as ToolName]}`);
      for (const e of entries) {
        console.log(`  ${e.created ? '✓ created' : '– exists '} ${e.rel}`);
      }
      if (entries.length === 0) {
        logger.warning('  (no source files found — check spec-gen installation)');
      } else {
        console.log(`  ${created} created, ${skipped} already existed`);
      }
    }

    const totalCreated = results.filter(r => r.created).length;
    if (totalCreated > 0) {
      logger.success(`${totalCreated} file(s) installed.`);
      console.log('Run `spec-gen analyze --ai-configs` to also generate project-specific context files (CLAUDE.md, .cursorrules, etc.).');
    } else {
      console.log('\nAll files already existed — nothing to do.');
    }
  });
