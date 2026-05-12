# EdgeStore Benchmark Results

Run: `npm run bench -- <project-dir>`

---

## openlore (1019 nodes, 5203 edges)

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

## TypeScript compiler (14654 nodes, ~79k edges)

Date: 2026-05-09 — hub: `isIdentifier` (fanIn=367), entry: `visitDeclarationSubtree` (fanOut=70)  
Source: `src/` only, `tests/**` and `**/*.d.ts` excluded, 601 files

| Operation | p50 | p95 |
|-----------|-----|-----|
| searchNodes("handle") [FTS5] | 345µs | 513µs |
| searchNodes("fi") [LIKE <3ch] | 200µs | 263µs |
| getNode(hub) | 35µs | 40µs |
| getCallers(hub, fanIn=367) | 794µs | 1.16ms |
| getCallees(entry, fanOut=70) | 222µs | 312µs |
| getCallerFiles("parser.ts") | 1.22ms | 1.44ms |
| getCallersForIds([5 hubs]) | 3.38ms | 3.73ms |
| bfsFromDB forward depth=2 | 87µs | 122µs |
| bfsFromDB forward depth=5 | 111µs | 163µs |
| bfsFromDB backward depth=2 | 3.73ms | 4.64ms |
| bfsFromDB backward depth=5 | 19.43ms | 20.99ms |
| orient path (search+5×callers+callees) | 429µs | 523µs |

Real hubs (excluding harness): `isIdentifier` (367), `setTextRange` (234), `finishNode` (178), `visitEachChild` (177), `findAncestor` (167)

---

## Observations

- Orient path stays under 500µs p50 across all scales (1k→15k nodes)
- BFS forward is O(depth), near-flat across scales ✓
- BFS backward cost driven by fanIn of seed node — `isIdentifier` (fanIn=367) at depth=5 → 19ms p50
- `getCallersForIds([5 hubs])` at 3.38ms p50 on TS compiler — large result set from 5×367-caller nodes
- FTS5 searchNodes stays ~350µs regardless of DB size (index scan)
- Hub ranking dominated by decorators on decorator-heavy frameworks (NestJS `@Body`, `@Inject`)
