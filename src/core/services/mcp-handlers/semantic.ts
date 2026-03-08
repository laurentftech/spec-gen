/**
 * MCP tool handlers for semantic search and feature insertion:
 * search_code, suggest_insertion_points, search_specs.
 */

import { join } from 'node:path';
import { validateDirectory } from './utils.js';
import { readSpecGenConfig } from '../config-manager.js';

// ============================================================================
// INSERTION POINT HELPERS
// ============================================================================

export type InsertionRole = 'entry_point' | 'orchestrator' | 'hub' | 'utility' | 'internal';
export type InsertionStrategy =
  | 'extend_entry_point'
  | 'add_orchestration_step'
  | 'cross_cutting_hook'
  | 'extract_shared_logic'
  | 'call_alongside';

export interface InsertionCandidate {
  rank: number;
  score: number;
  semanticDistance: number;
  name: string;
  filePath: string;
  className?: string;
  language: string;
  signature?: string;
  docstring?: string;
  role: InsertionRole;
  insertionStrategy: InsertionStrategy;
  reason: string;
  fanIn: number;
  fanOut: number;
  isHub: boolean;
  isEntryPoint: boolean;
}

export function classifyRole(fanIn: number, fanOut: number, isHub: boolean, isEntryPoint: boolean): InsertionRole {
  if (isEntryPoint) return 'entry_point';
  if (isHub) return 'hub';
  if (fanOut >= 5) return 'orchestrator';
  if (fanIn <= 1) return 'utility';
  return 'internal';
}

export function deriveStrategy(role: InsertionRole): InsertionStrategy {
  switch (role) {
    case 'entry_point':  return 'extend_entry_point';
    case 'orchestrator': return 'add_orchestration_step';
    case 'hub':          return 'cross_cutting_hook';
    case 'utility':      return 'extract_shared_logic';
    default:             return 'call_alongside';
  }
}

export function buildReason(
  name: string,
  role: InsertionRole,
  strategy: InsertionStrategy,
  fanIn: number,
  fanOut: number
): string {
  switch (strategy) {
    case 'extend_entry_point':
      return `${name} is an entry point (no internal callers). Add your feature here or create a sibling entry point that delegates to it.`;
    case 'add_orchestration_step':
      return `${name} orchestrates ${fanOut} downstream calls. Insert your feature as a new step in this pipeline.`;
    case 'cross_cutting_hook':
      return `${name} is called by ${fanIn} functions — adding logic here affects the entire callsite surface.`;
    case 'extract_shared_logic':
      return `${name} is a low-traffic utility. Shared logic for your feature can live here or be extracted alongside it.`;
    default:
      return `${name} is semantically close to your feature and operates in the same domain. Extend or call alongside it.`;
  }
}

/** Composite score = (1 - semanticDistance) * 0.6 + structuralBonus * 0.4 */
export function compositeScore(semanticDistance: number, role: InsertionRole): number {
  const semantic = Math.max(0, 1 - semanticDistance);
  const structuralBonus: Record<InsertionRole, number> = {
    entry_point:  1.0,
    orchestrator: 0.8,
    hub:          0.6,
    internal:     0.4,
    utility:      0.3,
  };
  return semantic * 0.6 + structuralBonus[role] * 0.4;
}

// ============================================================================
// HANDLERS
// ============================================================================

/**
 * Semantic search over the vector index built by "spec-gen analyze --embed".
 */
export async function handleSearchCode(
  directory: string,
  query: string,
  limit = 10,
  language?: string,
  minFanIn?: number
): Promise<unknown> {
  const absDir = await validateDirectory(directory);
  const outputDir = join(absDir, '.spec-gen', 'analysis');

  const { VectorIndex } = await import('../../analyzer/vector-index.js');
  const { EmbeddingService } = await import('../../analyzer/embedding-service.js');

  if (!VectorIndex.exists(outputDir)) {
    return {
      error:
        'No vector index found. Run "spec-gen analyze --embed" first, ' +
        'then configure EMBED_BASE_URL and EMBED_MODEL.',
    };
  }

  let embedSvc: InstanceType<typeof EmbeddingService>;
  try {
    embedSvc = EmbeddingService.fromEnv();
  } catch {
    const cfg = await readSpecGenConfig(absDir);
    if (!cfg) {
      return { error: 'No embedding configuration found. Set EMBED_BASE_URL and EMBED_MODEL env vars, or add an "embedding" section to .spec-gen/config.json.' };
    }
    const svcFromConfig = EmbeddingService.fromConfig(cfg);
    if (!svcFromConfig) {
      return { error: 'No embedding configuration found. Set EMBED_BASE_URL and EMBED_MODEL env vars, or add an "embedding" section to .spec-gen/config.json.' };
    }
    embedSvc = svcFromConfig;
  }

  limit = Math.max(1, Math.min(limit, 100));
  const results = await VectorIndex.search(outputDir, query, embedSvc, { limit, language, minFanIn });

  return {
    query,
    count: results.length,
    results: results.map(r => ({
      score: r.score,
      name: r.record.name,
      filePath: r.record.filePath,
      className: r.record.className || undefined,
      language: r.record.language,
      signature: r.record.signature || undefined,
      docstring: r.record.docstring || undefined,
      fanIn: r.record.fanIn,
      fanOut: r.record.fanOut,
      isHub: r.record.isHub,
      isEntryPoint: r.record.isEntryPoint,
    })),
  };
}

/**
 * Find the best places in the codebase to implement a new feature.
 */
export async function handleSuggestInsertionPoints(
  directory: string,
  description: string,
  limit = 5,
  language?: string
): Promise<unknown> {
  const absDir = await validateDirectory(directory);
  const outputDir = join(absDir, '.spec-gen', 'analysis');

  const { VectorIndex } = await import('../../analyzer/vector-index.js');
  const { EmbeddingService } = await import('../../analyzer/embedding-service.js');

  if (!VectorIndex.exists(outputDir)) {
    return {
      error:
        'No vector index found. Run "spec-gen analyze --embed" first, ' +
        'then configure EMBED_BASE_URL and EMBED_MODEL.',
    };
  }

  let embedSvc: InstanceType<typeof EmbeddingService>;
  try {
    embedSvc = EmbeddingService.fromEnv();
  } catch {
    const cfg = await readSpecGenConfig(absDir);
    if (!cfg) {
      return { error: 'No embedding configuration found. Set EMBED_BASE_URL and EMBED_MODEL env vars, or add an "embedding" section to .spec-gen/config.json.' };
    }
    const svcFromConfig = EmbeddingService.fromConfig(cfg);
    if (!svcFromConfig) {
      return { error: 'No embedding configuration found. Set EMBED_BASE_URL and EMBED_MODEL env vars, or add an "embedding" section to .spec-gen/config.json.' };
    }
    embedSvc = svcFromConfig;
  }

  limit = Math.max(1, Math.min(limit, 20));
  const rawResults = await VectorIndex.search(outputDir, description, embedSvc, { limit: limit * 4, language });

  const candidates: InsertionCandidate[] = rawResults.map(r => {
    const role     = classifyRole(r.record.fanIn, r.record.fanOut, r.record.isHub, r.record.isEntryPoint);
    const strategy = deriveStrategy(role);
    const score    = compositeScore(r.score, role);
    return {
      rank: 0,
      score,
      semanticDistance: r.score,
      name: r.record.name,
      filePath: r.record.filePath,
      className: r.record.className || undefined,
      language: r.record.language,
      signature: r.record.signature || undefined,
      docstring: r.record.docstring || undefined,
      role, insertionStrategy: strategy,
      reason: buildReason(r.record.name, role, strategy, r.record.fanIn, r.record.fanOut),
      fanIn: r.record.fanIn, fanOut: r.record.fanOut,
      isHub: r.record.isHub, isEntryPoint: r.record.isEntryPoint,
    };
  });

  candidates.sort((a, b) => b.score - a.score);
  const top = candidates.slice(0, limit).map((c, i) => ({ ...c, rank: i + 1 }));

  return {
    description,
    count: top.length,
    candidates: top,
    nextSteps: top.length > 0
      ? [
          `Run get_function_skeleton on "${top[0].filePath}" to see the internal structure of ${top[0].name}`,
          `Run get_subgraph on "${top[0].name}" to understand its call neighborhood`,
          `After implementing, run check_spec_drift to verify the code matches the spec`,
        ]
      : ['No candidates found. Try a broader description or run "spec-gen analyze --embed" to build the index.'],
  };
}

/**
 * List all spec domains available in the project (reads openspec/specs/ directory).
 * Useful for the agent to discover what domains exist before doing a targeted search.
 */
export async function handleListSpecDomains(directory: string): Promise<unknown> {
  const { existsSync } = await import('node:fs');
  const { readdir } = await import('node:fs/promises');
  const { join: pjoin } = await import('node:path');
  const absDir = await validateDirectory(directory);

  const specsDir = pjoin(absDir, 'openspec', 'specs');
  if (!existsSync(specsDir)) {
    return { domains: [], note: 'No openspec/specs/ directory found. Run "spec-gen generate" first.' };
  }

  let entries: string[];
  try {
    entries = await readdir(specsDir);
  } catch {
    return { domains: [] };
  }

  const { existsSync: ex2 } = await import('node:fs');
  const domains = entries.filter(e => ex2(pjoin(specsDir, e, 'spec.md')));
  return { domains, count: domains.length };
}

/**
 * Semantic search over the spec index built by "spec-gen analyze --embed"
 * or "spec-gen analyze --reindex-specs".
 */
export async function handleSearchSpecs(
  directory: string,
  query: string,
  limit = 10,
  domain?: string,
  section?: string
): Promise<unknown> {
  const absDir = await validateDirectory(directory);
  const outputDir = join(absDir, '.spec-gen', 'analysis');

  const { SpecVectorIndex } = await import('../../analyzer/spec-vector-index.js');
  const { EmbeddingService } = await import('../../analyzer/embedding-service.js');

  if (!SpecVectorIndex.exists(outputDir)) {
    return {
      error:
        'No spec index found. Run "spec-gen analyze --embed" or "spec-gen analyze --reindex-specs" first, ' +
        'then configure EMBED_BASE_URL and EMBED_MODEL.',
    };
  }

  let embedSvc: InstanceType<typeof EmbeddingService>;
  try {
    embedSvc = EmbeddingService.fromEnv();
  } catch {
    const cfg = await readSpecGenConfig(absDir);
    if (!cfg) {
      return { error: 'No embedding configuration found. Set EMBED_BASE_URL and EMBED_MODEL env vars, or add an "embedding" section to .spec-gen/config.json.' };
    }
    const svcFromConfig = EmbeddingService.fromConfig(cfg);
    if (!svcFromConfig) {
      return { error: 'No embedding configuration found. Set EMBED_BASE_URL and EMBED_MODEL env vars, or add an "embedding" section to .spec-gen/config.json.' };
    }
    embedSvc = svcFromConfig;
  }

  limit = Math.max(1, Math.min(limit, 50));
  const results = await SpecVectorIndex.search(outputDir, query, embedSvc, { limit, domain, section });

  return {
    query,
    count: results.length,
    results: results.map(r => ({
      score: r.score,
      id: r.record.id,
      domain: r.record.domain,
      section: r.record.section,
      title: r.record.title,
      text: r.record.text,
      linkedFiles: r.record.linkedFiles,
    })),
  };
}
