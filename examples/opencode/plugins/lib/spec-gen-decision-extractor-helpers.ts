/**
 * spec-gen-decision-extractor-helpers.ts
 *
 * Pure helper functions extracted from spec-gen-decision-extractor.ts so they
 * can be exported for testing without exposing them as OpenCode Plugin symbols.
 *
 * OpenCode loads every export from a plugin file and tries to call it as a
 * Plugin — exporting plain helpers directly from the plugin file causes a
 * null-deref on S.auth at TUI bootstrap.  This companion file is the safe
 * export surface for unit tests.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

// ─── Thresholds ───────────────────────────────────────────────────────────────

export const HUB_INDEGREE = 3; // ≥ 3 files import this file
export const HIGH_PAGERANK = 0.4; // normalised PageRank ≥ 40 %
export const HIGH_FILE_SCORE = 0.65; // significance score ≥ 65 %

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FileScore {
  inDegree: number;
  pageRank: number;
  fileScore: number;
  isHub: boolean;
}

// ─── scoreFromDepGraph ────────────────────────────────────────────────────────

/**
 * Read the dep-graph and score a file by its structural centrality.
 * Returns null if the file is not in the graph (new file — treat as unknown).
 */
export function scoreFromDepGraph(filePath: string, rootDir = process.cwd()): FileScore | null {
  try {
    const raw = readFileSync(
      join(rootDir, '.spec-gen', 'analysis', 'dependency-graph.json'),
      'utf-8'
    );
    const graph = JSON.parse(raw);
    const nodes: any[] = graph.nodes ?? [];

    // Match by relative path or absolute path suffix
    const node = nodes.find(
      (n) => n.file?.path === filePath || n.id === filePath || n.file?.path?.endsWith(filePath)
    );
    if (!node) return null;

    const inDegree: number = node.metrics?.inDegree ?? 0;
    const pageRank: number = node.metrics?.pageRank ?? 0;
    const fileScore: number = node.file?.score ?? 0;

    return {
      inDegree,
      pageRank,
      fileScore,
      isHub: inDegree >= HUB_INDEGREE || pageRank >= HIGH_PAGERANK || fileScore >= HIGH_FILE_SCORE,
    };
  } catch {
    return null;
  }
}
