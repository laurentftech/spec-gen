/**
 * McpWatcher — incremental re-indexer for the MCP server's --watch mode.
 *
 * Watches source files for changes and incrementally updates:
 *   1. signatures in llm-context.json (always)
 *   2. vector index (only when embed: true and an embedding server is reachable)
 *
 * The call graph is deliberately excluded — rebuilding it requires full
 * tree-sitter analysis of all call sites and is too expensive for a watch loop.
 * It stays current via the post-commit hook (spec-gen analyze --force --embed).
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { extractSignatures, detectLanguage } from '../analyzer/signature-extractor.js';
import type { LLMContext } from '../analyzer/artifact-generator.js';
import {
  SPEC_GEN_DIR,
  SPEC_GEN_ANALYSIS_SUBDIR,
  ARTIFACT_LLM_CONTEXT,
} from '../../constants.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface McpWatcherOptions {
  /** Absolute path to the project root being watched */
  rootPath: string;
  /** Absolute path to .spec-gen/analysis/ — where llm-context.json lives */
  outputPath?: string;
  /** Milliseconds to debounce file-change events (default: 400) */
  debounceMs?: number;
  /** Extra glob patterns to ignore in addition to defaults */
  ignore?: string[];
}

const SOURCE_EXTENSIONS = /\.(ts|tsx|js|jsx|py|go|rs|rb|java|kt|php|cs|cpp|cc|cxx|h|hpp|c)$/;

const DEFAULT_IGNORED = [
  '**/node_modules/**',
  '**/.spec-gen/**',
  '**/dist/**',
  '**/.git/**',
  '**/*.test.ts',
  '**/*.test.js',
  '**/*.spec.ts',
  '**/*.spec.js',
];

// ── McpWatcher ────────────────────────────────────────────────────────────────

export class McpWatcher {
  private readonly rootPath: string;
  private readonly outputPath: string;
  private readonly debounceMs: number;
  private readonly ignore: string[];

  private fsWatcher?: FSWatcher;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private running = false;

  constructor(options: McpWatcherOptions) {
    this.rootPath   = options.rootPath;
    this.outputPath = options.outputPath
      ?? join(options.rootPath, SPEC_GEN_DIR, SPEC_GEN_ANALYSIS_SUBDIR);
    this.debounceMs = options.debounceMs ?? 400;
    this.ignore     = [...DEFAULT_IGNORED, ...(options.ignore ?? [])];
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.fsWatcher = chokidar.watch(this.rootPath, {
        ignored: this.ignore,
        persistent: true,
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
      });

      this.fsWatcher.on('change', (absPath: string) => {
        if (SOURCE_EXTENSIONS.test(absPath)) {
          this.scheduleChange(absPath);
        }
      });

      this.fsWatcher.on('ready', () => resolve());
      this.fsWatcher.on('error', (err) => reject(err));
    });

    process.stderr.write(`[mcp-watcher] watching ${this.rootPath}\n`);
  }

  async stop(): Promise<void> {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    await this.fsWatcher?.close();
    process.stderr.write('[mcp-watcher] stopped\n');
  }

  // ── Debounce ───────────────────────────────────────────────────────────────

  private scheduleChange(absPath: string): void {
    const existing = this.timers.get(absPath);
    if (existing) clearTimeout(existing);

    const t = setTimeout(() => {
      this.timers.delete(absPath);
      if (this.running) {
        // Re-schedule instead of dropping — ensures no changes are lost
        this.scheduleChange(absPath);
        return;
      }
      this.running = true;
      this.handleChange(absPath)
        .catch(err => process.stderr.write(`[mcp-watcher] error: ${(err as Error).message}\n`))
        .finally(() => { this.running = false; });
    }, this.debounceMs);

    this.timers.set(absPath, t);
  }

  // ── Core re-index ──────────────────────────────────────────────────────────

  /**
   * Re-index a single changed file.
   * Exposed for unit testing without needing a real file watcher.
   */
  async handleChange(absPath: string): Promise<void> {
    const rel = relative(this.rootPath, absPath);

    // Skip test files and unsupported languages
    if (isTestFile(rel)) return;
    if (detectLanguage(rel) === 'unknown') return;

    // Read llm-context.json — bail silently if analyze has never been run
    const contextPath = join(this.outputPath, ARTIFACT_LLM_CONTEXT);
    let context: LLMContext;
    try {
      const raw = await readFile(contextPath, 'utf-8');
      context = JSON.parse(raw) as LLMContext;
    } catch {
      process.stderr.write(`[mcp-watcher] no context at ${contextPath} — run analyze first\n`);
      return;
    }

    // Re-extract signatures for the changed file
    let content: string;
    try {
      content = await readFile(absPath, 'utf-8');
    } catch {
      return; // file may have been deleted between the event and now
    }

    const newMap = extractSignatures(rel, content);

    // Patch signatures array (preserve callGraph and everything else)
    if (!context.signatures) context.signatures = [];
    const idx = context.signatures.findIndex(m => m.path === rel);
    if (idx >= 0) {
      context.signatures[idx] = newMap;
    } else {
      context.signatures.push(newMap);
    }

    await writeFile(contextPath, JSON.stringify(context, null, 2), 'utf-8');
    process.stderr.write(`[mcp-watcher] re-indexed signatures: ${rel}\n`);

    // Incremental vector re-embed — silently skipped if no embedding service available
    if (context.callGraph) {
      await this.reEmbed(context, rel, content);
    }
  }

  // ── Embed step ─────────────────────────────────────────────────────────────

  private async reEmbed(context: LLMContext, rel: string, content: string): Promise<void> {
    try {
      const { VectorIndex }      = await import('../analyzer/vector-index.js');
      const { EmbeddingService } = await import('../analyzer/embedding-service.js');
      const { readSpecGenConfig } = await import('./config-manager.js');

      if (!VectorIndex.exists(this.outputPath)) return;

      let embedSvc;
      try {
        embedSvc = EmbeddingService.fromEnv();
      } catch {
        const cfg = await readSpecGenConfig(this.rootPath);
        embedSvc = cfg ? EmbeddingService.fromConfig(cfg) : null;
      }
      if (!embedSvc) {
        process.stderr.write('[mcp-watcher] no embedding service — skipping re-embed\n');
        return;
      }

      const cg = context.callGraph!;
      const hubIds    = new Set((cg.hubFunctions ?? []).map(f => f.id));
      const entryIds  = new Set((cg.entryPoints ?? []).map(f => f.id));
      const fileContents = new Map([[rel, content]]);

      const { embedded, reused } = await VectorIndex.build(
        this.outputPath,
        cg.nodes,
        context.signatures ?? [],
        hubIds,
        entryIds,
        embedSvc,
        fileContents,
        /* incremental */ true
      );

      process.stderr.write(
        `[mcp-watcher] re-embedded ${rel}: ${embedded} new, ${reused} reused\n`
      );
    } catch (err) {
      process.stderr.write(`[mcp-watcher] embed error: ${(err as Error).message}\n`);
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isTestFile(relPath: string): boolean {
  return (
    relPath.includes('.test.') ||
    relPath.includes('.spec.') ||
    relPath.includes('__tests__')
  );
}
