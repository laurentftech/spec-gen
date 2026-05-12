/**
 * EdgeStore performance benchmark against the openlore repo's own call graph.
 * Run: npm run bench
 *
 * Requires: openlore analyze has been run at least once (call-graph.db must exist).
 */

import { EdgeStore } from '../src/core/services/edge-store.js';
import { bfsFromDB } from '../src/core/services/mcp-handlers/graph.js';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const targetDir = process.argv[2]
  ? resolve(process.argv[2])
  : join(__dirname, '..');

const DB_PATH = join(targetDir, '.openlore', 'analysis', 'call-graph.db');

if (!existsSync(DB_PATH)) {
  console.error(`call-graph.db not found at ${DB_PATH}`);
  console.error(`Run: openlore analyze ${targetDir} --force`);
  process.exit(1);
}

// ── helpers ───────────────────────────────────────────────────────────────────

interface Stats { min: number; p50: number; p95: number; max: number }

function measure(fn: () => unknown, iterations = 200): Stats {
  // Warmup (not counted)
  for (let i = 0; i < 10; i++) fn();

  const times: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return {
    min: times[0],
    p50: times[Math.floor(iterations * 0.5)],
    p95: times[Math.floor(iterations * 0.95)],
    max: times[times.length - 1],
  };
}

function fmt(ms: number): string {
  return ms < 1 ? `${(ms * 1000).toFixed(0)}µs` : `${ms.toFixed(2)}ms`;
}

function row(label: string, s: Stats): void {
  console.log(
    `  ${label.padEnd(40)} │ ${fmt(s.min).padStart(7)} │ ${fmt(s.p50).padStart(7)} │ ${fmt(s.p95).padStart(7)} │ ${fmt(s.max).padStart(7)}`
  );
}

// ── open DB ───────────────────────────────────────────────────────────────────

const store = EdgeStore.open(DB_PATH);
const nodeCount = store.countNodes();
const hubs = store.getHubs(5);
const entries = store.getEntryPoints(5);

if (hubs.length === 0 || entries.length === 0) {
  console.error('DB appears empty. Re-run analyze_codebase.');
  store.close();
  process.exit(1);
}

const hub = hubs[0];          // highest fan-in node
const entry = entries[0];     // highest fan-out entry point
const midHub = hubs[Math.min(2, hubs.length - 1)];

console.log(`\nEdgeStore benchmark — openlore call graph`);
console.log(`  Nodes: ${nodeCount}  Hub: ${hub.name} (fanIn=${hub.fanIn})  Entry: ${entry.name} (fanOut=${entry.fanOut})\n`);

console.log(`  ${'Operation'.padEnd(40)} │ ${'min'.padStart(7)} │ ${'p50'.padStart(7)} │ ${'p95'.padStart(7)} │ ${'max'.padStart(7)}`);
console.log(`  ${'-'.repeat(40)}-┼-${'-'.repeat(7)}-┼-${'-'.repeat(7)}-┼-${'-'.repeat(7)}-┼-${'-'.repeat(7)}`);

// ── node lookup ───────────────────────────────────────────────────────────────

row('searchNodes("handle") [FTS5 ≥3]',  measure(() => store.searchNodes('handle')));
row('searchNodes("fi") [LIKE <3]',       measure(() => store.searchNodes('fi')));
row(`getNode("${hub.name}")`,            measure(() => store.getNode(hub.id)));

// ── edge queries ──────────────────────────────────────────────────────────────

row(`getCallers("${hub.name}")`,         measure(() => store.getCallers(hub.id)));
row(`getCallees("${entry.name}")`,       measure(() => store.getCallees(entry.id)));
row(`getCallerFiles("${hub.filePath}")`, measure(() => store.getCallerFiles(hub.filePath)));

// ── batch edge queries ────────────────────────────────────────────────────────

const hubIds = hubs.map(h => h.id);
row('getCallersForIds([5 hubs])',         measure(() => store.getCallersForIds(hubIds)));
row('getCalleesForIds([5 hubs])',         measure(() => store.getCalleesForIds(hubIds)));

// ── BFS traversal ─────────────────────────────────────────────────────────────

row(`bfsFromDB forward  depth=2 (hub)`,  measure(() => bfsFromDB([hub.id], 'forward',  2, store)));
row(`bfsFromDB forward  depth=5 (hub)`,  measure(() => bfsFromDB([hub.id], 'forward',  5, store)));
row(`bfsFromDB backward depth=2 (hub)`,  measure(() => bfsFromDB([hub.id], 'backward', 2, store)));
row(`bfsFromDB backward depth=5 (hub)`,  measure(() => bfsFromDB([hub.id], 'backward', 5, store)));
row(`bfsFromDB forward  depth=2 (mid)`,  measure(() => bfsFromDB([midHub.id], 'forward',  2, store)));

// ── orient critical path ──────────────────────────────────────────────────────
// orient: searchNodes → getCallers → getCallees (per top-5 result)

row('orient path (searchNodes+5×callers+callees)', measure(() => {
  const seeds = store.searchNodes('handle', 5);
  for (const s of seeds) {
    store.getCallers(s.id);
    store.getCallees(s.id);
  }
}));

console.log();
store.close();
