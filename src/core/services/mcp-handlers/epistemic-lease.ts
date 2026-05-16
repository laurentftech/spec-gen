/**
 * Epistemic Lease — session-level architectural confidence decay for MCP agents.
 *
 * Models repository understanding as a temporary, degradable representation rather
 * than permanent truth. Injects freshness signals into every MCP tool response so
 * that agents drifting toward internally cached reasoning ("repo fiction") see
 * confidence decay even when they have stopped calling orient/graph tools.
 *
 * Decay triggers (any one sufficient):
 *   - Time: >15min → degraded, >30min → stale
 *   - Git hash divergence from orient baseline → immediate stale
 *   - Weighted cognitive load: >30 → degraded, >60 → stale
 *   - Cross-module file access diversity: >3 distinct top-level modules → degraded
 *
 * Injection:
 *   - fresh  → no injection (zero overhead)
 *   - degraded → 2-line signal appended (low friction)
 *   - stale  → explicit capability-invalidation block prepended (hard to miss)
 */

import { spawnSync } from 'node:child_process';

// ============================================================================
// TYPES
// ============================================================================

export type FreshnessState = 'fresh' | 'degraded' | 'stale';

export interface EpistemicTracker {
  lastOrientAt: Date;
  graphVersionAtOrient: string;
  cognitiveLoad: number;
  modulesVisited: Set<string>;
  freshnessState: FreshnessState;
  lastGitCheckAt: number;
}

// ============================================================================
// TOOL COGNITIVE WEIGHTS
// Three tiers: lightweight ops (1-2), structural ops (3-5), architectural ops (8).
// ============================================================================

const TOOL_WEIGHTS: Record<string, number> = {
  // Resets tracker — not counted
  orient: 0,
  analyze_codebase: 0,

  // Lightweight: search / read operations
  search_code: 1,
  search_specs: 1,
  search_unified: 1,
  list_spec_domains: 1,
  list_decisions: 1,
  record_decision: 1,
  get_env_vars: 1,
  get_external_packages: 1,

  // Structural: function/file-level reads
  get_spec: 2,
  get_signatures: 2,
  get_function_body: 2,
  get_function_skeleton: 2,
  get_mapping: 2,
  get_test_coverage: 2,
  get_route_inventory: 2,
  get_schema_inventory: 2,
  get_ui_components: 2,
  get_middleware_inventory: 2,

  // Structural-heavy: graph and architecture reads
  get_architecture_overview: 3,
  get_call_graph: 3,
  get_file_dependencies: 3,
  get_critical_hubs: 3,
  get_god_functions: 3,
  get_leaf_functions: 3,
  get_refactor_report: 3,
  get_duplicate_report: 3,
  check_spec_drift: 3,
  detect_changes: 3,
  audit_spec_coverage: 3,
  get_decisions: 3,
  get_minimal_context: 3,

  // Graph traversal / cross-module
  get_subgraph: 5,
  analyze_impact: 5,
  get_cluster: 4,
  generate_change_proposal: 5,
  annotate_story: 5,
  generate_tests: 4,
  get_low_risk_refactor_candidates: 4,

  // Deep architectural tracing
  trace_execution_path: 8,
};

// ============================================================================
// THRESHOLDS
// ============================================================================

const DEGRADE_LOAD_THRESHOLD = 30;
const STALE_LOAD_THRESHOLD = 60;
const DEGRADE_AGE_MS = 15 * 60 * 1000;
const STALE_AGE_MS = 30 * 60 * 1000;
const DEGRADE_MODULE_THRESHOLD = 3;
const GIT_CHECK_INTERVAL_MS = 30_000;

// ============================================================================
// GIT HASH
// ============================================================================

function getGitHash(directory: string): string {
  try {
    const result = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: directory,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    });
    return result.stdout?.trim() ?? '';
  } catch {
    return '';
  }
}

// ============================================================================
// MODULE EXTRACTION
// Extract top-level module segment from a file path: src/core/... → "core"
// ============================================================================

function moduleFromPath(filePath: string): string | null {
  const parts = filePath.split(/[/\\]/);
  const srcIdx = parts.indexOf('src');
  if (srcIdx >= 0 && srcIdx + 1 < parts.length) {
    return parts[srcIdx + 1];
  }
  return null;
}

// ============================================================================
// TRACKER LIFECYCLE
// ============================================================================

export function createTracker(directory: string): EpistemicTracker {
  return {
    lastOrientAt: new Date(),
    graphVersionAtOrient: getGitHash(directory),
    cognitiveLoad: 0,
    modulesVisited: new Set(),
    freshnessState: 'fresh',
    lastGitCheckAt: Date.now(),
  };
}

function resetTracker(tracker: EpistemicTracker, directory: string): void {
  tracker.lastOrientAt = new Date();
  tracker.graphVersionAtOrient = getGitHash(directory);
  tracker.cognitiveLoad = 0;
  tracker.modulesVisited = new Set();
  tracker.freshnessState = 'fresh';
  tracker.lastGitCheckAt = Date.now();
}

export function updateTracker(
  tracker: EpistemicTracker,
  toolName: string,
  directory: string,
  filePath?: string,
): void {
  if (toolName === 'orient') {
    resetTracker(tracker, directory);
    return;
  }

  // Already stale — skip all accumulation and state evaluation
  if (tracker.freshnessState === 'stale') return;

  // Accumulate cognitive load
  const weight = TOOL_WEIGHTS[toolName] ?? 1;
  tracker.cognitiveLoad += weight;

  // Track cross-module file access
  if (filePath) {
    const mod = moduleFromPath(filePath);
    if (mod) tracker.modulesVisited.add(mod);
  }

  // Rate-limited git hash check (~every 30s) — structural invalidation
  const now = Date.now();
  if (now - tracker.lastGitCheckAt > GIT_CHECK_INTERVAL_MS) {
    tracker.lastGitCheckAt = now;
    const currentHash = getGitHash(directory);
    if (currentHash && tracker.graphVersionAtOrient && currentHash !== tracker.graphVersionAtOrient) {
      tracker.freshnessState = 'stale';
      return;
    }
  }

  // Time and load based decay (never reverses: stale > degraded > fresh)
  const ageMs = now - tracker.lastOrientAt.getTime();

  if (ageMs >= STALE_AGE_MS || tracker.cognitiveLoad >= STALE_LOAD_THRESHOLD) {
    tracker.freshnessState = 'stale';
  } else if (
    tracker.freshnessState === 'fresh' && (
      ageMs >= DEGRADE_AGE_MS ||
      tracker.cognitiveLoad >= DEGRADE_LOAD_THRESHOLD ||
      tracker.modulesVisited.size > DEGRADE_MODULE_THRESHOLD
    )
  ) {
    tracker.freshnessState = 'degraded';
  }
}

// ============================================================================
// FRESHNESS SIGNALS
// Stale: prepended — agent sees it before reading any result.
// Degraded: appended — low friction, visible but not blocking.
// ============================================================================

function staleBlock(ageMin: number, load: number): string {
  return (
    `\n╔══════════════════════════════════════════════════════════╗\n` +
    `║  EPISTEMIC LEASE: STALE                                  ║\n` +
    `╚══════════════════════════════════════════════════════════╝\n` +
    `Context age: ${ageMin}min | Cognitive load score: ${load}\n\n` +
    `Cached architectural reasoning reliability: LOW\n` +
    `Cross-module dependency assumptions: UNRELIABLE\n` +
    `Internal repository model: NOT AUTHORITATIVE\n\n` +
    `Before continuing:\n` +
    `  - Do NOT rely on previous dependency assumptions\n` +
    `  - Do NOT infer cross-module relationships from memory\n` +
    `  - Do NOT compile delegation prompts from cached architectural model\n` +
    `  - Do NOT continue architectural reasoning from internal state\n\n` +
    `Call orient() to restore architectural authority.\n` +
    `─────────────────────────────────────────────────────────────\n\n`
  );
}

function degradedSignal(ageMin: number, modules: number): string {
  return (
    `\n─────────────────────────────────────────────────────────────\n` +
    `[EPISTEMIC LEASE: DEGRADED | age: ${ageMin}min | modules visited: ${modules}]\n` +
    `Cross-module dependency assumptions: reduced confidence.\n` +
    `Call orient() before architectural decisions or delegation prompt compilation.\n`
  );
}

export function injectFreshness(text: string, tracker: EpistemicTracker): string {
  if (tracker.freshnessState === 'fresh') return text;

  const ageMin = Math.floor((Date.now() - tracker.lastOrientAt.getTime()) / 60_000);

  if (tracker.freshnessState === 'stale') {
    return staleBlock(ageMin, tracker.cognitiveLoad) + text;
  }

  return text + degradedSignal(ageMin, tracker.modulesVisited.size);
}
