# EdgeStore Benchmark Results

Run: `npm run bench -- <project-dir>`

---

## spec-gen (1019 nodes, 5203 edges)

Date: 2026-05-09

| Operation | p50 | p95 |
|-----------|-----|-----|
| searchNodes("handle") [FTS5] | 343µs | 517µs |
| searchNodes("fi") [LIKE <3ch] | 217µs | 328µs |
| getNode(hub) | 35µs | 41µs |
| getCallers(hub, fanIn=41) | 89µs | 153µs |
| getCallees(entry, fanOut=49) | 97µs | 164µs |
| getCallersForIds([5 hubs]) | 285µs | 471µs |
| bfsFromDB forward depth=2 | 76µs | 128µs |
| bfsFromDB forward depth=5 | 137µs | 174µs |
| bfsFromDB backward depth=2 | 287µs | 412µs |
| bfsFromDB backward depth=5 | 338µs | 692µs |
| orient path (search+5×callers+callees) | 536µs | 945µs |

---

## NestJS (2888 nodes, ~14k edges)

Date: 2026-05-09 — hub: `Body` decorator (fanIn=72)

| Operation | p50 | p95 |
|-----------|-----|-----|
| searchNodes("handle") [FTS5] | 329µs | 553µs |
| getNode(hub) | 35µs | 58µs |
| getCallers(hub, fanIn=72) | 125µs | 218µs |
| getCallees(entry, fanOut=14) | 50µs | 103µs |
| getCallersForIds([5 hubs]) | 555µs | 785µs |
| bfsFromDB forward depth=2 | 68µs | 131µs |
| bfsFromDB forward depth=5 | 138µs | 219µs |
| bfsFromDB backward depth=2 | 270µs | 434µs |
| bfsFromDB backward depth=5 | 274µs | 549µs |
| orient path (search+5×callers+callees) | 433µs | 705µs |

---

## TypeScript compiler (8727 nodes, ~59k edges)

Date: 2026-05-09 — hub: `visitNode` (fanIn=239), entry: `createTypeChecker` (fanOut=124)  
Source: `src/` only, `tests/**` and `**/*.d.ts` excluded, 601 files

| Operation | p50 | p95 |
|-----------|-----|-----|
| searchNodes("handle") [FTS5] | 262µs | 544µs |
| getNode(hub) | 34µs | 64µs |
| getCallers(hub, fanIn=239) | 673µs | 1.08ms |
| getCallees(entry, fanOut=124) | 373µs | 512µs |
| getCallersForIds([5 hubs]) | 2.66ms | 3.56ms |
| bfsFromDB forward depth=2 | 34µs | 51µs |
| bfsFromDB forward depth=5 | 36µs | 41µs |
| bfsFromDB backward depth=2 | 2.07ms | 2.73ms |
| bfsFromDB backward depth=5 | 3.36ms | 4.69ms |
| orient path (search+5×callers+callees) | 458µs | 594µs |

---

## Observations

- Orient path stays under 500µs p50 across all scales (1k→9k nodes)
- BFS forward is O(depth), near-flat across scales ✓
- BFS backward cost driven by fanIn of seed node — `visitNode` (fanIn=239) at depth=5 → 3.36ms p50
- `getCallersForIds([5 hubs])` at 2.66ms p50 on TS compiler — large result set from 5×239-caller nodes
- FTS5 searchNodes stays ~300µs regardless of DB size (index scan)
- Hub ranking dominated by decorators on decorator-heavy frameworks (NestJS `@Body`, `@Inject`)
