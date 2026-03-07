import { useState, useCallback, useRef, useEffect, useMemo } from 'react';

// ─── Palette ──────────────────────────────────────────────────────────────────
const CLUSTER_PALETTE = [
  '#7c6af7',
  '#3ecfcf',
  '#f77c6a',
  '#6af7a0',
  '#f7c76a',
  '#f76ac8',
  '#6aaff7',
  '#c8f76a',
  '#f7a06a',
  '#a0a0ff',
  '#ff6b9d',
  '#00d4aa',
  '#ffb347',
];
const EXT_COLOR = {
  '.ts': '#4ecdc4',
  '.tsx': '#3ecfcf',
  '.js': '#f5c518',
  '.jsx': '#f5a018',
  '.css': '#a78bfa',
  '.html': '#fb923c',
  '.json': '#34d399',
  '.toml': '#f472b6',
  '.md': '#94a3b8',
  '.yml': '#60a5fa',
  '': '#64748b',
};
const extColor = (ext) => EXT_COLOR[ext] || '#64748b';

// ─── Spec helpers ─────────────────────────────────────────────────────────────
// Parse spec.md into a map of requirementId → { title, body }
function parseSpecRequirements(mdText) {
  const reqs = {};
  if (!mdText) return reqs;
  // Split on "### Requirement:" and "#### Requirement:" headings (sub-specs use 4 hashes).
  const sections = mdText.split(/^#{3,4}\s+Requirement:\s*/m);
  for (let i = 1; i < sections.length; i++) {
    const lines = sections[i].split('\n');
    const rawTitle = lines[0].trim();
    if (!rawTitle) continue;
    const body = lines.slice(1).join('\n').trim();
    // Index only by the exact requirement title found in the spec file.
    reqs[rawTitle] = { title: rawTitle, body };
  }
  return reqs;
}

// Fuzzy lookup removed — viewer now relies on exact requirement keys provided by the spec-requirements API.
// If needed, a deterministic lookup can be reintroduced in future, but for now we avoid fuzzy heuristics.

// Build index: filePath (normalized) → [{ requirement, service, domain, confidence }]
function buildMappingIndex(mappingJson) {
  const index = {}; // normalized filePath → array of mapping entries
  if (!mappingJson?.mappings) return index;
  for (const m of mappingJson.mappings) {
    for (const fn of m.functions || []) {
      const key = fn.file.replace(/\\/g, '/');
      if (!index[key]) index[key] = [];
      index[key].push({
        requirement: m.requirement,
        service: m.service,
        domain: m.domain,
        specFile: m.specFile,
        fnName: fn.name,
        fnLine: fn.line,
        confidence: fn.confidence,
      });
    }
  }
  return index;
}

// Normalize a node path for matching against mapping keys
function normalizePath(p) {
  return (p || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function parseGraph(raw) {
  const clusterByNode = {};
  (raw.clusters || []).forEach((cl, ci) => {
    cl.files.forEach((fid) => {
      clusterByNode[fid] = {
        name: cl.name,
        index: ci,
        id: cl.id,
        color: CLUSTER_PALETTE[ci % CLUSTER_PALETTE.length],
      };
    });
  });

  const nodes = (raw.nodes || []).map((n) => ({
    id: n.id,
    label: n.file.name,
    path: n.file.path,
    ext: n.file.extension,
    dir: n.file.directory,
    size: n.file.size,
    lines: n.file.lines,
    score: n.file.score,
    isEntry: n.file.isEntryPoint,
    isConfig: n.file.isConfig,
    isTest: n.file.isTest,
    tags: n.file.tags || [],
    exports: n.exports || [],
    metrics: n.metrics,
    cluster: clusterByNode[n.id] || {
      name: '(root)',
      index: 12,
      id: 'root',
      color: CLUSTER_PALETTE[12],
    },
  }));

  const edges = (raw.edges || []).map((e, i) => ({
    id: `e${i}`,
    source: e.source,
    target: e.target,
    importedNames: e.importedNames || [],
    isType: e.isTypeOnly || false,
    weight: e.weight || 1,
  }));

  const clusters = (raw.clusters || []).map((cl, ci) => ({
    ...cl,
    color: CLUSTER_PALETTE[ci % CLUSTER_PALETTE.length],
  }));

  return { nodes, edges, clusters, statistics: raw.statistics || {}, rankings: raw.rankings || {} };
}

function enrichGraphWithRefactors(graph, refReport) {
  if (!graph || !refReport || !refReport.priorities) return graph;

  const byFile = new Map();
  refReport.priorities.forEach((entry) => {
    const list = byFile.get(entry.file) || [];
    list.push(entry);
    byFile.set(entry.file, list);
  });

  const nodes = graph.nodes.map((n) => {
    const entries = byFile.get(n.path) || [];
    if (!entries.length) return { ...n, refactor: null };

    let maxPriority = 0;
    const issuesSet = new Set();
    entries.forEach((e) => {
      if (typeof e.priorityScore === 'number') {
        maxPriority = Math.max(maxPriority, e.priorityScore);
      }
      (e.issues || []).forEach((iss) => issuesSet.add(iss));
    });

    return {
      ...n,
      refactor: {
        functions: entries.length,
        maxPriority,
        issues: Array.from(issuesSet),
      },
    };
  });

  return {
    ...graph,
    nodes,
    refactorStats: refReport.stats || null,
  };
}

// ─── BFS blast radius ─────────────────────────────────────────────────────────
function computeBlast(edges, nodeId) {
  const affected = new Set();
  const q = [nodeId];
  while (q.length) {
    const cur = q.shift();
    edges.forEach((e) => {
      if (e.source === cur && !affected.has(e.target)) {
        affected.add(e.target);
        q.push(e.target);
      }
    });
  }
  return [...affected];
}

// ─── Force layout ─────────────────────────────────────────────────────────────
function computeLayout(nodes, edges, W = 900, H = 540) {
  if (!nodes.length) return {};
  const pos = {};

  // seed by cluster ring
  const byCluster = {};
  nodes.forEach((n) => {
    if (!byCluster[n.cluster.id]) byCluster[n.cluster.id] = [];
    byCluster[n.cluster.id].push(n.id);
  });
  const clIds = Object.keys(byCluster);
  clIds.forEach((cid, ci) => {
    const angle = (ci / clIds.length) * Math.PI * 2 - Math.PI / 2;
    const cx = W / 2 + Math.cos(angle) * W * 0.33;
    const cy = H / 2 + Math.sin(angle) * H * 0.3;
    byCluster[cid].forEach((nid, mi) => {
      const a2 = (mi / Math.max(byCluster[cid].length, 1)) * Math.PI * 2;
      const r = Math.min(60, 13 * Math.sqrt(byCluster[cid].length));
      pos[nid] = { x: cx + Math.cos(a2) * r, y: cy + Math.sin(a2) * r };
    });
  });

  const edgeMap = {};
  edges.forEach((e) => {
    if (!edgeMap[e.source]) edgeMap[e.source] = [];
    edgeMap[e.source].push(e.target);
  });

  const k = 55;
  for (let iter = 0; iter < 80; iter++) {
    const disp = {};
    nodes.forEach((n) => {
      disp[n.id] = { x: 0, y: 0 };
    });

    // repulsion
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i],
          b = nodes[j];
        const dx = pos[a.id].x - pos[b.id].x;
        const dy = pos[a.id].y - pos[b.id].y;
        const d = Math.max(Math.sqrt(dx * dx + dy * dy), 0.01);
        const f = (k * k) / d;
        disp[a.id].x += (dx / d) * f;
        disp[a.id].y += (dy / d) * f;
        disp[b.id].x -= (dx / d) * f;
        disp[b.id].y -= (dy / d) * f;
      }
    }

    // attraction along edges
    edges.forEach((e) => {
      if (!pos[e.source] || !pos[e.target]) return;
      const dx = pos[e.source].x - pos[e.target].x;
      const dy = pos[e.source].y - pos[e.target].y;
      const d = Math.max(Math.sqrt(dx * dx + dy * dy), 0.01);
      const f = (d * d) / (k * (e.isType ? 2 : 1));
      disp[e.source].x -= (dx / d) * f;
      disp[e.source].y -= (dy / d) * f;
      disp[e.target].x += (dx / d) * f;
      disp[e.target].y += (dy / d) * f;
    });

    const temp = k * Math.max(0.05, 1 - iter / 80) * 0.5;
    nodes.forEach((n) => {
      const d = Math.sqrt(disp[n.id].x ** 2 + disp[n.id].y ** 2);
      if (d > 0) {
        pos[n.id].x += (disp[n.id].x / d) * Math.min(d, temp);
        pos[n.id].y += (disp[n.id].y / d) * Math.min(d, temp);
      }
      pos[n.id].x = Math.max(36, Math.min(W - 36, pos[n.id].x));
      pos[n.id].y = Math.max(36, Math.min(H - 36, pos[n.id].y));
    });
  }
  return pos;
}

// ─── Cluster layout ───────────────────────────────────────────────────────────
function computeClusterLayout(clusters, W = 900, H = 540) {
  const pos = {};
  clusters.forEach((cl, i) => {
    const angle = (i / clusters.length) * Math.PI * 2 - Math.PI / 2;
    pos[cl.id] = {
      x: W / 2 + Math.cos(angle) * W * 0.34,
      y: H / 2 + Math.sin(angle) * H * 0.32,
    };
  });
  return pos;
}

// ─── Pan/Zoom hook ────────────────────────────────────────────────────────────
function usePanZoom() {
  const [transform, setTransform] = useState({ x: 0, y: 0, k: 1 });
  const dragging = useRef(false);
  const hasDragged = useRef(false);
  const last = useRef({ x: 0, y: 0 });

  const onMouseDown = useCallback((e) => {
    if (e.button !== 0) return;
    dragging.current = true;
    hasDragged.current = false;
    last.current = { x: e.clientX, y: e.clientY };
    e.currentTarget.style.cursor = 'grabbing';
  }, []);

  const onMouseMove = useCallback((e) => {
    if (!dragging.current) return;
    const dx = e.clientX - last.current.x;
    const dy = e.clientY - last.current.y;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) hasDragged.current = true;
    last.current = { x: e.clientX, y: e.clientY };
    setTransform((t) => ({ ...t, x: t.x + dx, y: t.y + dy }));
  }, []);

  const onMouseUp = useCallback((e) => {
    dragging.current = false;
    e.currentTarget.style.cursor = 'grab';
  }, []);

  const onWheel = useCallback((e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.06 : 1 / 1.06;
    const rect = e.currentTarget.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    setTransform((t) => {
      const k = Math.max(0.15, Math.min(8, t.k * factor));
      const ratio = k / t.k;
      return {
        k,
        x: cx - ratio * (cx - t.x),
        y: cy - ratio * (cy - t.y),
      };
    });
  }, []);

  const onDblClick = useCallback((e) => {
    // Double-click on background resets view (not on nodes)
    if (e.target === e.currentTarget || e.target.tagName === 'svg') {
      setTransform({ x: 0, y: 0, k: 1 });
    }
  }, []);

  const onMouseLeave = useCallback((e) => {
    dragging.current = false;
    e.currentTarget.style.cursor = 'grab';
  }, []);

  const reset = useCallback(() => setTransform({ x: 0, y: 0, k: 1 }), []);

  // Expose whether the last mousedown→mouseup was a drag (to suppress click on nodes)
  const isDrag = useCallback(() => hasDragged.current, []);

  return {
    transform,
    onMouseDown,
    onMouseMove,
    onMouseUp,
    onWheel,
    onMouseLeave,
    onDblClick,
    reset,
    isDrag,
  };
}

// ─── Flat SVG graph ───────────────────────────────────────────────────────────
function FlatGraph({
  nodes,
  edges,
  selectedId,
  affectedIds,
  focusedIds,
  onSelect,
  refactorOnly,
  linkedIds,
}) {
  const posRef = useRef(null);
  const prevKey = useRef(null);
  const [, tick] = useState(0);
  const key = nodes
    .map((n) => n.id)
    .sort()
    .join('|');
  const {
    transform,
    onMouseDown,
    onMouseMove,
    onMouseUp,
    onWheel,
    onMouseLeave,
    onDblClick,
    reset,
    isDrag,
  } = usePanZoom();

  useEffect(() => {
    if (key !== prevKey.current) {
      posRef.current = computeLayout(nodes, edges);
      prevKey.current = key;
      tick((t) => t + 1);
      reset();
    }
  }, [key]);

  const pos = posRef.current || {};

  const getState = (id) => {
    if (id === selectedId) return 'selected';
    if (affectedIds.includes(id)) return 'affected';
    if (focusedIds.length && focusedIds.includes(id)) return 'focused';
    if (focusedIds.length) return 'dimmed';
    return 'default';
  };

  return (
    <svg
      viewBox="0 0 900 540"
      style={{ width: '100%', height: '100%', cursor: 'grab' }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseLeave}
      onWheel={onWheel}
      onDoubleClick={onDblClick}
      onClick={(e) => {
        if (!isDrag() && (e.target === e.currentTarget || e.target.tagName === 'svg'))
          onSelect(null);
      }}
    >
      <defs>
        <marker id="arr" markerWidth="6" markerHeight="6" refX="5" refY="2.5" orient="auto">
          <path d="M0,0 L0,5 L6,2.5z" fill="#1e2340" />
        </marker>
        <marker id="arr-sel" markerWidth="6" markerHeight="6" refX="5" refY="2.5" orient="auto">
          <path d="M0,0 L0,5 L6,2.5z" fill="#7c6af7" />
        </marker>
        <marker id="arr-aff" markerWidth="6" markerHeight="6" refX="5" refY="2.5" orient="auto">
          <path d="M0,0 L0,5 L6,2.5z" fill="#f77c6a" />
        </marker>
        <marker id="arr-type" markerWidth="6" markerHeight="6" refX="5" refY="2.5" orient="auto">
          <path d="M0,0 L0,5 L6,2.5z" fill="#2a2f5a" />
        </marker>
        <filter id="glow">
          <feGaussianBlur stdDeviation="4" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <filter id="glow-aff">
          <feGaussianBlur stdDeviation="2.5" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      <g transform={`translate(${transform.x},${transform.y}) scale(${transform.k})`}>
        {/* Cluster halos */}
        {Object.entries(
          nodes.reduce((acc, n) => {
            if (!acc[n.cluster.id]) acc[n.cluster.id] = { nodes: [], color: n.cluster.color };
            acc[n.cluster.id].nodes.push(n);
            return acc;
          }, {})
        ).map(([cid, { nodes: cn, color }]) => {
          const pts = cn.map((n) => pos[n.id]).filter(Boolean);
          if (!pts.length) return null;
          const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
          const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
          const r =
            Math.max(...pts.map((p) => Math.sqrt((p.x - cx) ** 2 + (p.y - cy) ** 2)), 20) + 28;
          return (
            <ellipse
              key={cid}
              cx={cx}
              cy={cy}
              rx={r}
              ry={r * 0.85}
              fill={`${color}07`}
              stroke={`${color}18`}
              strokeWidth={1}
              strokeDasharray="5 3"
            />
          );
        })}

        {/* Edges */}
        {edges.map((e) => {
          const s = pos[e.source],
            t = pos[e.target];
          if (!s || !t) return null;
          const dx = t.x - s.x,
            dy = t.y - s.y,
            len = Math.sqrt(dx * dx + dy * dy) || 1;
          const nx = dx / len,
            ny = dy / len,
            nr = 18;
          const isSel = e.source === selectedId || e.target === selectedId;
          const isAff = affectedIds.includes(e.target) && e.source === selectedId;
          return (
            <line
              key={e.id}
              x1={s.x + nx * nr}
              y1={s.y + ny * nr}
              x2={t.x - nx * (nr + 5)}
              y2={t.y - ny * (nr + 5)}
              stroke={isSel ? '#7c6af7' : isAff ? '#f77c6a' : e.isType ? '#252a4a' : '#181c36'}
              strokeWidth={isSel ? 1.5 : isAff ? 1.2 : 0.8}
              strokeOpacity={isSel ? 0.9 : isAff ? 0.7 : e.isType ? 0.35 : 0.55}
              strokeDasharray={e.isType ? '4 2' : undefined}
              markerEnd={
                isSel
                  ? 'url(#arr-sel)'
                  : isAff
                    ? 'url(#arr-aff)'
                    : e.isType
                      ? 'url(#arr-type)'
                      : 'url(#arr)'
              }
            />
          );
        })}

        {/* Nodes */}
        {nodes.map((n) => {
          const p = pos[n.id];
          if (!p) return null;
          const state = getState(n.id);
          const col = extColor(n.ext);
          const isSel = state === 'selected';
          const isAff = state === 'affected';
          const isDim = state === 'dimmed';
          const isZeroScore = refactorOnly && n.score === 0 && !linkedIds.has(n.id);
          const r = 15 + Math.min(n.score / 14, 6);
          const hasRef = !!n.refactor;
          let refColor = null;
          if (hasRef) {
            const p = n.refactor.maxPriority || 0;
            refColor = p >= 5 ? '#f97373' : p >= 3 ? '#fbbf24' : '#4ade80';
          }

          return (
            <g
              key={n.id}
              transform={`translate(${p.x},${p.y})`}
              onClick={() => {
                if (!isDrag()) onSelect(n.id);
              }}
              style={{ cursor: 'pointer' }}
              opacity={isDim ? 0.08 : isZeroScore ? 0.18 : 1}
              filter={isSel ? 'url(#glow)' : isAff ? 'url(#glow-aff)' : undefined}
            >
              <circle
                r={r + 4}
                fill="none"
                stroke={n.cluster.color}
                strokeWidth={1}
                strokeOpacity={isSel ? 0.5 : 0.1}
              />
              {hasRef && (
                <circle
                  r={r + 7}
                  fill="none"
                  stroke={refColor}
                  strokeWidth={1.3}
                  strokeOpacity={0.9}
                />
              )}
              <circle
                r={r}
                fill={isSel ? `${col}1a` : isAff ? `${col}0d` : '#0b0d1e'}
                stroke={isSel ? col : isAff ? col : '#1c2038'}
                strokeWidth={isSel ? 2.5 : isAff ? 2 : 0.8}
              />
              {n.isEntry && (
                <circle
                  r={r + 8}
                  fill="none"
                  stroke={col}
                  strokeWidth={0.7}
                  strokeDasharray="3 2"
                  strokeOpacity={0.28}
                />
              )}
              <text
                textAnchor="middle"
                dominantBaseline="middle"
                fontSize={7}
                fontWeight={isSel ? 700 : 400}
                fill={isSel ? '#fff' : isAff ? col : '#5a6090'}
                fontFamily="'JetBrains Mono',monospace"
                style={{ pointerEvents: 'none' }}
              >
                {n.label.length > 13 ? n.label.slice(0, 12) + '…' : n.label}
              </text>
              {n.score > 0 && (
                <text
                  x={r + 1}
                  y={-r + 2}
                  fontSize={6}
                  fill={col}
                  fontFamily="monospace"
                  style={{ pointerEvents: 'none' }}
                >
                  {n.score}
                </text>
              )}
            </g>
          );
        })}
      </g>
      <foreignObject x="8" y="8" width="62" height="22" style={{ pointerEvents: 'all' }}>
        <button
          onClick={reset}
          title="Reset view (or double-click background)"
          style={{
            fontSize: 8,
            padding: '3px 8px',
            background: '#0d0f22',
            border: `1px solid ${transform.x !== 0 || transform.y !== 0 || transform.k !== 1 ? '#7c6af7' : '#1a1f38'}`,
            borderRadius: 4,
            color:
              transform.x !== 0 || transform.y !== 0 || transform.k !== 1 ? '#7c6af7' : '#2a2f4a',
            cursor: 'pointer',
            fontFamily: "'JetBrains Mono',monospace",
            letterSpacing: '0.05em',
          }}
        >
          ⌖ reset
        </button>
      </foreignObject>
    </svg>
  );
}

// ─── Cluster SVG graph ────────────────────────────────────────────────────────
function ClusterGraph({
  clusters,
  edges,
  nodes,
  allNodes,
  expandedClusters,
  onToggle,
  onSelectNode,
  selectedId,
  affectedIds,
  linkedIds,
}) {
  const clusterPos = useMemo(
    () => computeClusterLayout(clusters),
    [clusters.map((c) => c.id).join()]
  );
  const visibleIds = useMemo(() => new Set(nodes.map((n) => n.id)), [nodes]);
  const {
    transform,
    onMouseDown,
    onMouseMove,
    onMouseUp,
    onWheel,
    onMouseLeave,
    onDblClick,
    reset,
    isDrag,
  } = usePanZoom();

  // Reset pan/zoom when clusters change significantly
  const clusterKey = clusters.map((c) => c.id).join('|');
  useEffect(() => {
    reset();
  }, [clusterKey]);

  const nodeLayouts = useMemo(() => {
    const layouts = {};
    clusters.forEach((cl) => {
      if (!expandedClusters.has(cl.id)) return;
      const members = (allNodes || nodes).filter((n) => n.cluster.id === cl.id);
      const cp = clusterPos[cl.id];
      if (!cp) return;
      const r = 55 + members.length * 9;
      const layout = {};
      members.forEach((n, i) => {
        const a = (i / Math.max(members.length, 1)) * Math.PI * 2 - Math.PI / 2;
        layout[n.id] = { x: cp.x + Math.cos(a) * r, y: cp.y + Math.sin(a) * r };
      });
      layouts[cl.id] = layout;
    });
    return layouts;
  }, [clusters, expandedClusters, allNodes, nodes, clusterPos]);

  // inter-cluster edges (deduplicated, weighted by count)
  const clusterEdges = useMemo(() => {
    const counts = {};
    edges.forEach((e) => {
      const sn = nodes.find((n) => n.id === e.source);
      const tn = nodes.find((n) => n.id === e.target);
      if (!sn || !tn || sn.cluster.id === tn.cluster.id) return;
      const key = `${sn.cluster.id}→${tn.cluster.id}`;
      counts[key] = (counts[key] || 0) + 1;
    });
    return Object.entries(counts).map(([key, count]) => {
      const [sc, tc] = key.split('→');
      return { id: key, source: sc, target: tc, count };
    });
  }, [edges, nodes]);

  return (
    <svg
      viewBox="0 0 900 540"
      style={{ width: '100%', height: '100%', cursor: 'grab' }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseLeave}
      onWheel={onWheel}
      onDoubleClick={onDblClick}
      onClick={(e) => {
        if (!isDrag() && (e.target === e.currentTarget || e.target.tagName === 'svg'))
          onSelectNode(null);
      }}
    >
      <defs>
        <marker id="carr" markerWidth="6" markerHeight="6" refX="5" refY="2.5" orient="auto">
          <path d="M0,0 L0,5 L6,2.5z" fill="#2a3060" />
        </marker>
        <marker id="carr-sel" markerWidth="6" markerHeight="6" refX="5" refY="2.5" orient="auto">
          <path d="M0,0 L0,5 L6,2.5z" fill="#7c6af7" />
        </marker>
        <marker id="carr-in" markerWidth="6" markerHeight="6" refX="5" refY="2.5" orient="auto">
          <path d="M0,0 L0,5 L6,2.5z" fill="#3ecfcf" />
        </marker>
        <filter id="cglow">
          <feGaussianBlur stdDeviation="6" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <filter id="nglow">
          <feGaussianBlur stdDeviation="3" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      <g transform={`translate(${transform.x},${transform.y}) scale(${transform.k})`}>
        {/* Inter-cluster edges — hidden when a node is selected (replaced by node-level edges below) */}
        {!selectedId &&
          clusterEdges.map((e) => {
            const s = clusterPos[e.source],
              t = clusterPos[e.target];
            if (!s || !t) return null;
            const dx = t.x - s.x,
              dy = t.y - s.y,
              len = Math.sqrt(dx * dx + dy * dy) || 1;
            const nx = dx / len,
              ny = dy / len;
            const rs = 38,
              rt = 38;
            const w = Math.min(1 + e.count * 0.15, 4);
            return (
              <g key={e.id}>
                <line
                  x1={s.x + nx * rs}
                  y1={s.y + ny * rs}
                  x2={t.x - nx * (rt + 5)}
                  y2={t.y - ny * (rt + 5)}
                  stroke="#1e2448"
                  strokeWidth={w}
                  strokeOpacity={0.5}
                  markerEnd="url(#carr)"
                />
                <text
                  x={(s.x + nx * rs + t.x - nx * (rt + 5)) / 2}
                  y={(s.y + ny * rs + t.y - ny * (rt + 5)) / 2 - 4}
                  textAnchor="middle"
                  fontSize={7}
                  fill="#2a3060"
                  fontFamily="'JetBrains Mono',monospace"
                  style={{ pointerEvents: 'none' }}
                >
                  {e.count}
                </text>
              </g>
            );
          })}

        {/* Node-level edges when a node is selected — drawn across clusters */}
        {selectedId &&
          (() => {
            // Collect all positions: from expanded node layouts + cluster centers for collapsed
            const getNodePos = (nid) => {
              const n = (allNodes || nodes).find((x) => x.id === nid);
              if (!n) return null;
              const clId = n.cluster.id;
              // If cluster is expanded and node has a layout position, use it
              if (nodeLayouts[clId]?.[nid]) return nodeLayouts[clId][nid];
              // Otherwise use the cluster bubble center
              return clusterPos[clId] || null;
            };

            return edges
              .filter((e) => e.source === selectedId || e.target === selectedId)
              .map((e, i) => {
                const sp = getNodePos(e.source);
                const tp = getNodePos(e.target);
                if (!sp || !tp) return null;
                const dx = tp.x - sp.x,
                  dy = tp.y - sp.y,
                  len = Math.sqrt(dx * dx + dy * dy) || 1;
                const nx = dx / len,
                  ny = dy / len;
                const isOut = e.source === selectedId;
                return (
                  <line
                    key={i}
                    x1={sp.x + nx * 14}
                    y1={sp.y + ny * 14}
                    x2={tp.x - nx * 19}
                    y2={tp.y - ny * 19}
                    stroke={isOut ? '#7c6af7' : '#3ecfcf'}
                    strokeWidth={1.5}
                    strokeOpacity={0.9}
                    strokeDasharray={e.isType ? '4 2' : undefined}
                    markerEnd={isOut ? 'url(#carr-sel)' : 'url(#carr-in)'}
                  />
                );
              });
          })()}

        {/* Intra-cluster edges (expanded) */}
        {clusters
          .filter((cl) => expandedClusters.has(cl.id))
          .map((cl) => {
            const layout = nodeLayouts[cl.id] || {};
            return edges
              .filter((e) => {
                const sn = nodes.find((n) => n.id === e.source);
                const tn = nodes.find((n) => n.id === e.target);
                return sn?.cluster.id === cl.id && tn?.cluster.id === cl.id;
              })
              .map((e) => {
                const s = layout[e.source],
                  t = layout[e.target];
                if (!s || !t) return null;
                const dx = t.x - s.x,
                  dy = t.y - s.y,
                  len = Math.sqrt(dx * dx + dy * dy) || 1;
                const nx = dx / len,
                  ny = dy / len,
                  r = 13;
                return (
                  <line
                    key={e.id}
                    x1={s.x + nx * r}
                    y1={s.y + ny * r}
                    x2={t.x - nx * (r + 4)}
                    y2={t.y - ny * (r + 4)}
                    stroke={cl.color}
                    strokeWidth={0.8}
                    strokeOpacity={0.45}
                    strokeDasharray={e.isType ? '3 2' : undefined}
                    markerEnd="url(#carr)"
                  />
                );
              });
          })}

        {/* Cluster bubbles */}
        {clusters.map((cl) => {
          const p = clusterPos[cl.id];
          if (!p) return null;
          const allMembers = (allNodes || nodes).filter((n) => n.cluster.id === cl.id);
          const visibleMembers = allMembers.filter((n) => visibleIds.has(n.id));
          const isExpanded = expandedClusters.has(cl.id);
          const r = 32 + Math.min(allMembers.length * 1.4, 18);
          const inDeg = clusterEdges
            .filter((e) => e.target === cl.id)
            .reduce((s, e) => s + e.count, 0);
          const outDeg = clusterEdges
            .filter((e) => e.source === cl.id)
            .reduce((s, e) => s + e.count, 0);

          return (
            <g key={cl.id}>
              {/* Cluster bubble — rendered first so nodes paint on top and receive clicks */}
              {(() => {
                const clusterLinked =
                  linkedIds.size > 0 && allMembers.some((n) => linkedIds.has(n.id));
                const isClusterGreyed = visibleMembers.length === 0 && !clusterLinked;
                // Highlight if any member is linked but cluster is not expanded
                const isLinkedCollapsed = clusterLinked && !isExpanded;
                return (
                  <g
                    transform={`translate(${p.x},${p.y})`}
                    onClick={() => {
                      if (!isDrag()) onToggle(cl.id);
                    }}
                    style={{ cursor: 'pointer' }}
                    filter={
                      isExpanded ? 'url(#cglow)' : isLinkedCollapsed ? 'url(#cglow)' : undefined
                    }
                    opacity={isClusterGreyed ? 0.18 : 1}
                  >
                    <circle
                      r={r}
                      fill={isLinkedCollapsed ? `${cl.color}18` : `${cl.color}10`}
                      stroke={cl.color}
                      strokeWidth={isExpanded ? 1.8 : isLinkedCollapsed ? 1.5 : 1}
                      strokeOpacity={isExpanded ? 0.85 : isLinkedCollapsed ? 0.7 : 0.35}
                    />
                    <text
                      textAnchor="middle"
                      y={-10}
                      fontSize={8.5}
                      fontWeight={700}
                      fill={cl.color}
                      fontFamily="'JetBrains Mono',monospace"
                      style={{ pointerEvents: 'none' }}
                    >
                      {cl.name.split('/').pop()}
                    </text>
                    <text
                      textAnchor="middle"
                      y={3}
                      fontSize={7}
                      fill={`${cl.color}90`}
                      fontFamily="'JetBrains Mono',monospace"
                      style={{ pointerEvents: 'none' }}
                    >
                      {visibleMembers.length}/{allMembers.length} files
                    </text>
                    <text
                      textAnchor="middle"
                      y={14}
                      fontSize={6.5}
                      fill={`${cl.color}60`}
                      fontFamily="'JetBrains Mono',monospace"
                      style={{ pointerEvents: 'none' }}
                    >
                      ↙{inDeg} ↗{outDeg}
                    </text>
                    <text
                      textAnchor="middle"
                      y={r - 8}
                      fontSize={9}
                      fill={`${cl.color}80`}
                      fontFamily="'JetBrains Mono',monospace"
                      style={{ pointerEvents: 'none' }}
                    >
                      {isExpanded ? '▲' : '▼'}
                    </text>
                  </g>
                );
              })()}

              {/* Member nodes — rendered after cluster bubble to sit on top and receive clicks */}
              {isExpanded &&
                allMembers.map((n) => {
                  const np = nodeLayouts[cl.id]?.[n.id];
                  if (!np) return null;
                  const isSel = n.id === selectedId;
                  const isAff = affectedIds.includes(n.id);
                  const col = extColor(n.ext);
                  const isGreyed = !visibleIds.has(n.id) && !linkedIds.has(n.id);
                  return (
                    <g
                      key={n.id}
                      transform={`translate(${np.x},${np.y})`}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!isDrag()) onSelectNode(n.id);
                      }}
                      style={{ cursor: 'pointer' }}
                      filter={isSel ? 'url(#nglow)' : undefined}
                      opacity={isGreyed ? 0.18 : 1}
                    >
                      <circle
                        r={13}
                        fill={isSel ? `${col}1a` : '#0b0d1e'}
                        stroke={isSel ? col : isAff ? col : cl.color}
                        strokeWidth={isSel ? 2 : 0.8}
                        strokeOpacity={isSel ? 1 : isAff ? 0.9 : 0.45}
                      />
                      <text
                        textAnchor="middle"
                        dominantBaseline="middle"
                        fontSize={6}
                        fill={isSel ? '#fff' : '#5a6090'}
                        fontFamily="'JetBrains Mono',monospace"
                        style={{ pointerEvents: 'none' }}
                      >
                        {n.label.length > 10 ? n.label.slice(0, 9) + '…' : n.label}
                      </text>
                    </g>
                  );
                })}
            </g>
          );
        })}
      </g>
      <foreignObject x="8" y="8" width="62" height="22" style={{ pointerEvents: 'all' }}>
        <button
          onClick={reset}
          title="Reset view (or double-click background)"
          style={{
            fontSize: 8,
            padding: '3px 8px',
            background: '#0d0f22',
            border: `1px solid ${transform.x !== 0 || transform.y !== 0 || transform.k !== 1 ? '#7c6af7' : '#1a1f38'}`,
            borderRadius: 4,
            color:
              transform.x !== 0 || transform.y !== 0 || transform.k !== 1 ? '#7c6af7' : '#2a2f4a',
            cursor: 'pointer',
            fontFamily: "'JetBrains Mono',monospace",
            letterSpacing: '0.05em',
          }}
        >
          ⌖ reset
        </button>
      </foreignObject>
    </svg>
  );
}

// ─── Filter bar ───────────────────────────────────────────────────────────────
function FilterBar({ filters, setFilters, stats, clusterNames }) {
  const hasActive =
    filters.hideOrphans ||
    filters.minScore > 0 ||
    filters.topN < 999 ||
    filters.cluster !== '' ||
    filters.refactorOnly;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        flexWrap: 'wrap',
        padding: '7px 18px',
        borderBottom: '1px solid #0f1224',
        background: '#07091a',
        flexShrink: 0,
        fontSize: 9,
      }}
    >
      <span style={{ color: '#2a2f4a', letterSpacing: '0.08em', fontWeight: 700 }}>FILTERS</span>

      {/* Orphans toggle */}
      <FToggle
        active={filters.hideOrphans}
        onChange={(v) => setFilters((f) => ({ ...f, hideOrphans: v }))}
        label="Hide orphans"
        badge={stats.orphanCount}
        activeColor="#f77c6a"
      />

      {/* Refactor candidates */}
      <FToggle
        active={filters.refactorOnly}
        onChange={(v) => setFilters((f) => ({ ...f, refactorOnly: v }))}
        label="Nodes to refactor"
        badge={stats.refactorVisible}
        activeColor="#f97373"
      />

      {/* Score */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        <span style={{ color: '#2a2f4a' }}>Score ≥</span>
        <input
          type="range"
          min={0}
          max={65}
          step={5}
          value={filters.minScore}
          onChange={(e) => setFilters((f) => ({ ...f, minScore: +e.target.value }))}
          style={{ width: 72, accentColor: '#7c6af7' }}
        />
        <span style={{ color: '#7c6af7', minWidth: 16 }}>{filters.minScore}</span>
      </div>

      {/* Top N */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        <span style={{ color: '#2a2f4a' }}>Top</span>
        <select
          value={filters.topN}
          onChange={(e) => setFilters((f) => ({ ...f, topN: +e.target.value }))}
          style={{
            background: '#0d0f22',
            border: '1px solid #1a1f38',
            color: '#c8cde8',
            borderRadius: 4,
            padding: '2px 5px',
            fontSize: 9,
            fontFamily: 'inherit',
          }}
        >
          {[999, 50, 30, 20, 10].map((n) => (
            <option key={n} value={n}>
              {n === 999 ? 'All' : String(n)}
            </option>
          ))}
        </select>
        <span style={{ color: '#2a2f4a' }}>nodes</span>
      </div>

      {/* Cluster */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        <span style={{ color: '#2a2f4a' }}>Cluster</span>
        <select
          value={filters.cluster}
          onChange={(e) => setFilters((f) => ({ ...f, cluster: e.target.value }))}
          style={{
            background: '#0d0f22',
            border: '1px solid #1a1f38',
            color: '#c8cde8',
            borderRadius: 4,
            padding: '2px 5px',
            fontSize: 9,
            fontFamily: 'inherit',
            maxWidth: 130,
          }}
        >
          <option value="">All</option>
          {clusterNames.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </div>

      {hasActive && (
        <button
          onClick={() =>
            setFilters({
              hideOrphans: false,
              minScore: 0,
              topN: 999,
              cluster: '',
              refactorOnly: false,
            })
          }
          style={{
            background: 'none',
            border: '1px solid #2a2f4a',
            borderRadius: 4,
            color: '#3a3f5c',
            padding: '2px 7px',
            cursor: 'pointer',
            fontSize: 9,
            fontFamily: 'inherit',
          }}
        >
          reset
        </button>
      )}

      <div style={{ marginLeft: 'auto', color: '#2a2f4a', display: 'flex', gap: 8 }}>
        <span>
          <span style={{ color: '#7c6af7' }}>{stats.visible}</span>/
          <span style={{ color: '#3a4060' }}>{stats.total}</span> nodes
        </span>
        <span>
          <span style={{ color: '#3ecfcf' }}>{stats.visibleEdges}</span> edges
        </span>
        {stats.orphanCount > 0 && !filters.hideOrphans && (
          <span style={{ color: '#f77c6a66' }}>{stats.orphanCount} orphans</span>
        )}
      </div>
    </div>
  );
}

function FToggle({ active, onChange, label, badge, activeColor = '#7c6af7' }) {
  return (
    <button
      onClick={() => onChange(!active)}
      style={{
        background: active ? `${activeColor}1a` : 'transparent',
        border: `1px solid ${active ? activeColor : '#1a1f38'}`,
        borderRadius: 4,
        color: active ? activeColor : '#3a3f5c',
        padding: '2px 8px',
        cursor: 'pointer',
        fontSize: 9,
        fontFamily: 'inherit',
        display: 'flex',
        alignItems: 'center',
        gap: 4,
      }}
    >
      {label}
      {badge !== undefined && (
        <span
          style={{
            background: '#0d0f22',
            borderRadius: 3,
            padding: '0 4px',
            color: '#3a3f5c',
            fontSize: 8,
          }}
        >
          {badge}
        </span>
      )}
    </button>
  );
}

// ─── Architecture helpers ──────────────────────────────────────────────────────

const ROLE_COLOR = {
  entry_layer:    '#4ade80',
  orchestrator:   '#7c6af7',
  core_utilities: '#f97316',
  api_layer:      '#3ecfcf',
  internal:       '#475569',
};
const ROLE_LABEL = {
  entry_layer:    'entry layer',
  orchestrator:   'orchestrator',
  core_utilities: 'core utilities',
  api_layer:      'API layer',
  internal:       'internal',
};

function inferClusterRole(entryCount, hubCount, fileCount) {
  if (entryCount > fileCount * 0.5) return 'entry_layer';
  if (hubCount > 0 && entryCount > 0) return 'orchestrator';
  if (hubCount > 0) return 'core_utilities';
  if (entryCount > 0) return 'api_layer';
  return 'internal';
}

/** Build architecture overview from parsed graph + llmCtx (both can be null). */
function computeArchOverview(graph, llmCtx) {
  if (!graph) return null;

  // hub / entry file sets (relative paths from call graph)
  const hubFiles = new Set((llmCtx?.callGraph?.hubFunctions ?? []).map(h => h.filePath));
  const entryFiles = new Set((llmCtx?.callGraph?.entryPoints ?? []).map(e => e.filePath));

  // cluster id → cluster info
  const clusterById = {};
  (graph.clusters ?? []).forEach(cl => { clusterById[cl.id] = cl; });

  // file path → cluster id (graph nodes use absolute paths as ids)
  const clusterOfNode = {};
  (graph.nodes ?? []).forEach(n => {
    if (n.cluster?.id) clusterOfNode[n.id] = n.cluster.id;
    // also index by relative path (strip leading '/')
    const rel = n.path?.replace(/^\/+/, '') ?? '';
    if (rel && n.cluster?.id) clusterOfNode[rel] = n.cluster.id;
  });

  // inter-cluster edges
  const clusterEdges = {};
  (graph.edges ?? []).forEach(e => {
    const from = clusterOfNode[e.source];
    const to = clusterOfNode[e.target];
    if (from && to && from !== to) {
      if (!clusterEdges[from]) clusterEdges[from] = new Set();
      clusterEdges[from].add(to);
    }
  });

  // per-cluster: count hubs / entries by matching relative paths
  const clusters = (graph.clusters ?? []).map(cl => {
    // cl.files are absolute paths in dep graph; graph.nodes have paths too
    const clNodes = (graph.nodes ?? []).filter(n => n.cluster?.id === cl.id);
    const relPaths = clNodes.map(n => n.path?.replace(/^\/+/, '') ?? '');
    const hubCount = relPaths.filter(p => hubFiles.has(p)).length;
    const entryCount = relPaths.filter(p => entryFiles.has(p)).length;
    const role = inferClusterRole(entryCount, hubCount, clNodes.length || cl.files?.length || 1);
    const dependsOn = [...(clusterEdges[cl.id] ?? [])];
    const keyFiles = relPaths.filter(p => hubFiles.has(p) || entryFiles.has(p)).slice(0, 5);
    return { id: cl.id, name: cl.name ?? cl.id, fileCount: clNodes.length || cl.files?.length || 0, role, entryPointCount: entryCount, hubCount, dependsOn, keyFiles, color: cl.color };
  }).sort((a, b) => b.fileCount - a.fileCount);

  const globalEntryPoints = (llmCtx?.callGraph?.entryPoints ?? []).slice(0, 20).map(n => ({ name: n.name, file: n.filePath, language: n.language }));
  const criticalHubs = (llmCtx?.callGraph?.hubFunctions ?? []).slice(0, 10).map(n => ({ name: n.name, file: n.filePath, fanIn: n.fanIn, fanOut: n.fanOut }));

  return {
    summary: {
      totalFiles: graph.statistics?.nodeCount ?? (graph.nodes?.length ?? 0),
      totalClusters: clusters.length,
      totalEdges: graph.statistics?.edgeCount ?? (graph.edges?.length ?? 0),
      cycles: graph.statistics?.cycleCount ?? 0,
      layerViolations: llmCtx?.callGraph?.layerViolations?.length ?? 0,
    },
    clusters,
    globalEntryPoints,
    criticalHubs,
  };
}

/** Simple SVG cluster-map: boxes in a grid with arrows for dependsOn. */
function ArchitectureView({ graph, llmCtx }) {
  const overview = useMemo(() => computeArchOverview(graph, llmCtx), [graph, llmCtx]);
  const [hovered, setHovered] = useState(null);

  if (!overview) return <div style={{ color: '#3a3f5c', padding: 24, fontSize: 11 }}>No graph loaded.</div>;

  const { summary, clusters, globalEntryPoints, criticalHubs } = overview;

  // Layout: arrange clusters in a grid (max 4 cols)
  const COLS = Math.min(4, clusters.length);
  const BOX_W = 140, BOX_H = 64, GAP_X = 30, GAP_Y = 40;
  const ROWS = Math.ceil(clusters.length / COLS);
  const SVG_W = COLS * (BOX_W + GAP_X) + GAP_X;
  const SVG_H = ROWS * (BOX_H + GAP_Y) + GAP_Y;

  // Position map: cluster id → { cx, cy } (center of box)
  const pos = {};
  clusters.forEach((cl, i) => {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    pos[cl.id] = {
      x: GAP_X + col * (BOX_W + GAP_X),
      y: GAP_Y + row * (BOX_H + GAP_Y),
    };
  });

  // Draw arrows for dependsOn
  const arrows = [];
  clusters.forEach(cl => {
    (cl.dependsOn ?? []).forEach(toId => {
      const from = pos[cl.id];
      const to = pos[toId];
      if (!from || !to) return;
      const fx = from.x + BOX_W / 2, fy = from.y + BOX_H / 2;
      const tx = to.x + BOX_W / 2, ty = to.y + BOX_H / 2;
      // shorten arrow to box edge
      const dx = tx - fx, dy = ty - fy;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const sx = fx + (dx / len) * (BOX_W / 2 + 4);
      const sy = fy + (dy / len) * (BOX_H / 2 + 4);
      const ex = tx - (dx / len) * (BOX_W / 2 + 4);
      const ey = ty - (dy / len) * (BOX_H / 2 + 4);
      const isHov = hovered === cl.id || hovered === toId;
      arrows.push(
        <line
          key={`${cl.id}→${toId}`}
          x1={sx} y1={sy} x2={ex} y2={ey}
          stroke={isHov ? '#7c6af7' : '#1e2240'}
          strokeWidth={isHov ? 1.5 : 1}
          markerEnd="url(#arrowhead)"
          opacity={isHov ? 1 : 0.6}
        />
      );
    });
  });

  const S = { fontSize: 9, fontFamily: 'inherit' };

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      {/* SVG cluster map */}
      <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
        {/* Summary bar */}
        <div style={{ display: 'flex', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
          {[
            ['files', summary.totalFiles],
            ['clusters', summary.totalClusters],
            ['edges', summary.totalEdges],
            summary.cycles > 0 ? ['⚠ cycles', summary.cycles] : null,
            summary.layerViolations > 0 ? ['⚠ violations', summary.layerViolations] : null,
          ].filter(Boolean).map(([l, v]) => (
            <div key={l} style={{ fontSize: 9, color: '#6a70a0', background: '#0e1028', borderRadius: 4, padding: '2px 8px', border: '1px solid #141830' }}>
              <span style={{ color: l.startsWith('⚠') ? '#f97316' : '#c8cde8' }}>{v}</span> {l}
            </div>
          ))}
        </div>

        <svg width={SVG_W} height={SVG_H} style={{ display: 'block', minWidth: SVG_W }}>
          <defs>
            <marker id="arrowhead" markerWidth="6" markerHeight="6" refX="3" refY="3" orient="auto">
              <path d="M0,0 L0,6 L6,3 z" fill="#3a3f6c" />
            </marker>
          </defs>

          {/* Arrows below boxes */}
          {arrows}

          {/* Cluster boxes */}
          {clusters.map(cl => {
            const { x, y } = pos[cl.id] ?? { x: 0, y: 0 };
            const color = ROLE_COLOR[cl.role] ?? '#475569';
            const isHov = hovered === cl.id;
            return (
              <g
                key={cl.id}
                onMouseEnter={() => setHovered(cl.id)}
                onMouseLeave={() => setHovered(null)}
                style={{ cursor: 'default' }}
              >
                <rect
                  x={x} y={y} width={BOX_W} height={BOX_H}
                  rx={6} ry={6}
                  fill={isHov ? '#12163a' : '#0b0e28'}
                  stroke={isHov ? color : '#1e2240'}
                  strokeWidth={isHov ? 1.5 : 1}
                />
                {/* Role color strip */}
                <rect x={x} y={y} width={4} height={BOX_H} rx={3} ry={3} fill={color} opacity={0.8} />
                {/* Name */}
                <text x={x + 12} y={y + 18} fill="#c8cde8" fontSize={10} fontWeight="600" fontFamily="inherit">
                  {cl.name.length > 18 ? cl.name.slice(0, 17) + '…' : cl.name}
                </text>
                {/* Role label */}
                <text x={x + 12} y={y + 31} fill={color} fontSize={8} fontFamily="inherit" opacity={0.9}>
                  {ROLE_LABEL[cl.role] ?? cl.role}
                </text>
                {/* File count */}
                <text x={x + 12} y={y + 44} fill="#3a4060" fontSize={8} fontFamily="inherit">
                  {cl.fileCount} files
                  {cl.hubCount > 0 ? `  ·  ${cl.hubCount} hub${cl.hubCount > 1 ? 's' : ''}` : ''}
                  {cl.entryPointCount > 0 ? `  ·  ${cl.entryPointCount} entry` : ''}
                </text>
                {/* dependsOn count badge */}
                {cl.dependsOn.length > 0 && (
                  <text x={x + BOX_W - 6} y={y + 18} fill="#3a4060" fontSize={7} fontFamily="inherit" textAnchor="end">
                    →{cl.dependsOn.length}
                  </text>
                )}
              </g>
            );
          })}
        </svg>

        {/* Legend */}
        <div style={{ display: 'flex', gap: 12, marginTop: 12, flexWrap: 'wrap' }}>
          {Object.entries(ROLE_LABEL).map(([role, label]) => (
            <div key={role} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 8, color: '#3a4060' }}>
              <div style={{ width: 8, height: 8, borderRadius: 2, background: ROLE_COLOR[role] }} />
              {label}
            </div>
          ))}
        </div>
      </div>

      {/* Side panel: entry points + hubs */}
      <div style={{ width: 220, borderLeft: '1px solid #0f1224', overflow: 'auto', padding: '12px 10px', flexShrink: 0 }}>
        {globalEntryPoints.length > 0 && (
          <>
            <div style={{ ...S, color: '#4ade80', fontWeight: 600, marginBottom: 6, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
              Entry Points
            </div>
            {globalEntryPoints.map((ep, i) => (
              <div key={i} style={{ marginBottom: 6 }}>
                <div style={{ ...S, color: '#c8cde8', fontWeight: 600 }}>{ep.name}</div>
                <div style={{ ...S, color: '#3a4060', wordBreak: 'break-all' }}>{ep.file}</div>
              </div>
            ))}
          </>
        )}

        {criticalHubs.length > 0 && (
          <>
            <div style={{ ...S, color: '#f97316', fontWeight: 600, marginBottom: 6, marginTop: 16, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
              Critical Hubs
            </div>
            {criticalHubs.map((hub, i) => (
              <div key={i} style={{ marginBottom: 6 }}>
                <div style={{ ...S, color: '#c8cde8', fontWeight: 600 }}>{hub.name}</div>
                <div style={{ ...S, color: '#3a4060', wordBreak: 'break-all' }}>{hub.file}</div>
                <div style={{ ...S, color: '#f97316', opacity: 0.7 }}>fanIn {hub.fanIn}  ·  fanOut {hub.fanOut}</div>
              </div>
            ))}
          </>
        )}

        {globalEntryPoints.length === 0 && criticalHubs.length === 0 && (
          <div style={{ ...S, color: '#3a3f5c' }}>Run <code style={{ color: '#7c6af7' }}>spec-gen analyze</code> to populate call graph data.</div>
        )}
      </div>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App({ graphUrl, mappingUrl = '/api/mapping', specUrl = '/api/spec' }) {
  const [graph, setGraph] = useState(null);
  const [llmCtx, setLlmCtx] = useState(null);
  const [refReport, setRefReport] = useState(null);
  const [mapping, setMapping] = useState(null); // parsed mapping index
  const [specReqs, setSpecReqs] = useState({}); // requirementId → {title, body}
  const [selectedId, setSelectedId] = useState(null);
  const [affectedIds, setAffectedIds] = useState([]);
  const [focusedIds, setFocusedIds] = useState([]);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState('node');
  const [viewMode, setViewMode] = useState('clusters');
  const [expandedClusters, setExpandedClusters] = useState(new Set());
  const [filters, setFilters] = useState({
    hideOrphans: false,
    minScore: 0,
    topN: 999,
    cluster: '',
    refactorOnly: false,
  });
  const [loaded, setLoaded] = useState(false);
  const fileRef = useRef();
  const hasAutoLoadedRef = useRef(false);

  useEffect(() => {
    setTimeout(() => setLoaded(true), 80);
  }, []);

  const loadGraph = useCallback(
    (jsonStr) => {
      try {
        const g = parseGraph(JSON.parse(jsonStr));
        setGraph(refReport ? enrichGraphWithRefactors(g, refReport) : g);
        setSelectedId(null);
        setAffectedIds([]);
        setFocusedIds([]);
        setSearch('');
        setFilters({
          hideOrphans: false,
          minScore: 0,
          topN: 999,
          cluster: '',
          refactorOnly: false,
        });
        setExpandedClusters(new Set());
      } catch (e) {
        alert('Invalid JSON: ' + e.message);
      }
    },
    [refReport]
  );

  const loadMapping = useCallback((jsonStr) => {
    try {
      const m = JSON.parse(jsonStr);
      setMapping(buildMappingIndex(m));
    } catch (e) {
      console.error('Invalid mapping JSON', e);
    }
  }, []);

  const loadSpec = useCallback((mdStr) => {
    setSpecReqs(parseSpecRequirements(mdStr));
  }, []);

  const mappingRef = useRef();
  const specRef = useRef();

  useEffect(() => {
    if (!graphUrl || hasAutoLoadedRef.current) return;
    hasAutoLoadedRef.current = true;
    (async () => {
      try {
        const res = await fetch(graphUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        loadGraph(text);

        // Best-effort: load llm-context (call graph for architecture view)
        try {
          const ctxRes = await fetch('/api/llm-context');
          if (ctxRes.ok) setLlmCtx(await ctxRes.json());
        } catch {
          /* ignore */
        }

        // Best-effort: load refactor priorities if available
        try {
          const refRes = await fetch('/api/refactor-priorities');
          if (refRes.ok) {
            const report = await refRes.json();
            setRefReport(report);
            setGraph((g) => (g ? enrichGraphWithRefactors(g, report) : g));
          }
        } catch {
          /* ignore */
        }

        // Best-effort: load mapping and spec
        try {
          const mRes = await fetch('/api/mapping');
          if (mRes.ok) loadMapping(await mRes.text());
        } catch {
          /* ignore */
        }
        try {
          const srRes = await fetch('/api/spec-requirements');
          if (srRes.ok) {
            const reqsJson = await srRes.json();
            // spec-requirements returns an object keyed by the mapping.requirement
            // e.g. { "mergeOpenSpecConfig": { title, body, specFile, domain, service }, ... }
            setSpecReqs(reqsJson);
          } else {
            // Fallback: legacy raw markdown endpoint (keeps backward compatibility)
            try {
              const sRes = await fetch('/api/spec');
              if (sRes.ok) loadSpec(await sRes.text());
            } catch {
              /* ignore */
            }
          }
        } catch {
          /* ignore */
        }
      } catch (e) {
        // Fall back to manual upload UI; errors are shown in console.
        console.error('Failed to load graph from', graphUrl, e);
      }
    })();
  }, [graphUrl, mappingUrl, specUrl, loadGraph]);

  const handleFile = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = (ev) => loadGraph(ev.target.result);
    r.readAsText(f);
  };

  // ── Filtered nodes/edges ──────────────────────────────────────────────────
  const { visibleNodes, visibleEdges, filterStats } = useMemo(() => {
    if (!graph) return { visibleNodes: [], visibleEdges: [], filterStats: {} };

    const connectedIds = new Set();
    graph.edges.forEach((e) => {
      connectedIds.add(e.source);
      connectedIds.add(e.target);
    });
    const orphanCount = graph.nodes.filter((n) => !connectedIds.has(n.id)).length;

    let nodes = filters.cluster
      ? graph.nodes.filter((n) => n.cluster.name === filters.cluster)
      : graph.nodes;

    if (filters.refactorOnly) {
      nodes = nodes.filter((n) => n.refactor);
    }

    if (filters.hideOrphans) nodes = nodes.filter((n) => connectedIds.has(n.id));
    if (filters.minScore > 0) nodes = nodes.filter((n) => n.score >= filters.minScore);

    if (filters.topN < 999) {
      const ranked = graph.rankings.byImportance || graph.nodes.map((n) => n.id);
      const topSet = new Set(ranked.slice(0, filters.topN));
      nodes = nodes.filter((n) => topSet.has(n.id));
    }

    const vset = new Set(nodes.map((n) => n.id));
    const edges = graph.edges.filter((e) => vset.has(e.source) && vset.has(e.target));

    const refactorTotal =
      graph.refactorStats?.withIssues ?? graph.nodes.filter((n) => n.refactor).length;
    const refactorVisible = nodes.filter((n) => n.refactor).length;

    return {
      visibleNodes: nodes,
      visibleEdges: edges,
      filterStats: {
        total: graph.nodes.length,
        visible: nodes.length,
        visibleEdges: edges.length,
        orphanCount,
        refactorTotal,
        refactorVisible,
      },
    };
  }, [graph, filters]);

  const handleSearch = (q) => {
    setSearch(q);
    if (!q.trim()) {
      setFocusedIds([]);
      return;
    }
    const lo = q.toLowerCase();
    setFocusedIds(
      visibleNodes
        .filter(
          (n) =>
            n.label.toLowerCase().includes(lo) ||
            n.path.toLowerCase().includes(lo) ||
            n.ext.includes(lo) ||
            n.tags.some((t) => t.toLowerCase().includes(lo)) ||
            n.exports.some((ex) => ex.name.toLowerCase().includes(lo))
        )
        .map((n) => n.id)
    );
  };

  const handleSelect = useCallback(
    (id) => {
      if (selectedId === id) {
        setSelectedId(null);
        setAffectedIds([]);
        return;
      }
      setSelectedId(id);
      setAffectedIds(computeBlast(visibleEdges, id));
      setTab(mapping ? 'spec' : 'node');
    },
    [selectedId, visibleEdges, mapping]
  );

  const toggleCluster = useCallback((cid) => {
    setExpandedClusters((prev) => {
      const next = new Set(prev);
      next.has(cid) ? next.delete(cid) : next.add(cid);
      return next;
    });
  }, []);

  const selectedNode = graph?.nodes.find((n) => n.id === selectedId);
  const selectedEdges = useMemo(() => {
    if (!selectedId) return [];
    return visibleEdges.filter((e) => e.source === selectedId || e.target === selectedId);
  }, [selectedId, visibleEdges]);

  // All nodes that should be "lit" when a node is selected (direct neighbors + blast radius)
  const linkedIds = useMemo(() => {
    if (!selectedId) return new Set();
    const set = new Set([selectedId, ...affectedIds]);
    visibleEdges.forEach((e) => {
      if (e.source === selectedId) set.add(e.target);
      if (e.target === selectedId) set.add(e.source);
    });
    return set;
  }, [selectedId, affectedIds, visibleEdges]);
  const stats = graph?.statistics || {};
  const clusterNames = graph?.clusters.map((c) => c.name) || [];

  // ── Upload screen ─────────────────────────────────────────────────────────
  if (!graph)
    return (
      <div
        style={{
          width: '100%',
          height: '100vh',
          background: '#07091a',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: "'JetBrains Mono',monospace",
          color: '#c8cde8',
          opacity: loaded ? 1 : 0,
          transition: 'opacity 0.3s',
        }}
      >
        <div style={{ fontSize: 10, letterSpacing: '0.18em', color: '#2a2f4a', marginBottom: 28 }}>
          INTERACTIVE GRAPH VIEWER
        </div>
        <div
          style={{
            border: '1px dashed #252a45',
            borderRadius: 12,
            padding: '44px 64px',
            textAlign: 'center',
            cursor: 'pointer',
          }}
          onClick={() => fileRef.current.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const f = e.dataTransfer.files[0];
            if (f) {
              const r = new FileReader();
              r.onload = (ev) => loadGraph(ev.target.result);
              r.readAsText(f);
            }
          }}
        >
          <div style={{ fontSize: 32, marginBottom: 14, color: '#7c6af7' }}>⬡</div>
          <div style={{ fontSize: 12, color: '#8890b0', marginBottom: 6 }}>
            Drop a <code style={{ color: '#7c6af7' }}>dependency-graph.json</code>
          </div>
          <div style={{ fontSize: 10, color: '#3a3f5c' }}>or click to browse</div>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".json"
          style={{ display: 'none' }}
          onChange={handleFile}
        />
        <input
          ref={mappingRef}
          type="file"
          accept=".json"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files[0];
            if (f) {
              const r = new FileReader();
              r.onload = (ev) => loadMapping(ev.target.result);
              r.readAsText(f);
            }
          }}
        />
        <input
          ref={specRef}
          type="file"
          accept=".md"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files[0];
            if (f) {
              const r = new FileReader();
              r.onload = (ev) => loadSpec(ev.target.result);
              r.readAsText(f);
            }
          }}
        />
      </div>
    );

  // ── Main UI ───────────────────────────────────────────────────────────────
  return (
    <div
      style={{
        width: '100%',
        height: '100vh',
        background: '#07091a',
        fontFamily: "'JetBrains Mono',monospace",
        color: '#c8cde8',
        display: 'flex',
        flexDirection: 'column',
        opacity: loaded ? 1 : 0,
        transition: 'opacity 0.3s',
      }}
    >
      {/* Top bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '8px 18px',
          borderBottom: '1px solid #0f1224',
          background: '#080a1c',
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <div
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: '#7c6af7',
              boxShadow: '0 0 8px #7c6af7',
            }}
          />
          <span
            style={{ fontSize: 10, fontWeight: 700, color: '#e0e4f0', letterSpacing: '0.09em' }}
          >
            GRAPH VIEWER
          </span>
        </div>
        {[
          ['nodes', stats.nodeCount],
          ['edges', stats.edgeCount],
          ['clusters', stats.clusterCount],
        ].map(([l, v]) => (
          <div
            key={l}
            style={{
              fontSize: 9,
              color: '#3a4060',
              background: '#0e1028',
              borderRadius: 4,
              padding: '2px 7px',
              border: '1px solid #141830',
            }}
          >
            <span style={{ color: '#6a70a0' }}>{v}</span> {l}
          </div>
        ))}
        <div style={{ display: 'flex', gap: 2, marginLeft: 8 }}>
          {[
            ['clusters', '⬡ clusters'],
            ['flat', '⊙ flat'],
            ['architecture', '⬛ architecture'],
          ].map(([v, lbl]) => (
            <button
              key={v}
              onClick={() => {
                setViewMode(v);
                setSelectedId(null);
                setAffectedIds([]);
              }}
              style={{
                padding: '3px 10px',
                fontSize: 9,
                background: viewMode === v ? '#181b38' : 'transparent',
                border: `1px solid ${viewMode === v ? '#7c6af7' : '#141830'}`,
                borderRadius: 4,
                color: viewMode === v ? '#c8cde8' : '#3a3f5c',
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              {lbl}
            </button>
          ))}
        </div>
        <div style={{ marginLeft: 'auto', position: 'relative' }}>
          <input
            value={search}
            onChange={(e) => handleSearch(e.target.value)}
            placeholder="search name, path, export, tag…"
            style={{
              background: '#0c0e22',
              border: '1px solid #141830',
              color: '#c8cde8',
              padding: '5px 12px 5px 26px',
              borderRadius: 5,
              fontSize: 9,
              width: 230,
              outline: 'none',
              fontFamily: 'inherit',
            }}
          />
          <span
            style={{
              position: 'absolute',
              left: 8,
              top: '50%',
              transform: 'translateY(-50%)',
              fontSize: 11,
              color: '#3a3f5c',
            }}
          >
            ⌕
          </span>
          {focusedIds.length > 0 && (
            <span
              style={{
                position: 'absolute',
                right: 8,
                top: '50%',
                transform: 'translateY(-50%)',
                fontSize: 9,
                color: '#7c6af7',
              }}
            >
              {focusedIds.length}
            </span>
          )}
        </div>
        <button
          onClick={() => {
            setGraph(null);
            setSelectedId(null);
          }}
          style={{
            background: 'none',
            border: '1px solid #1a1f38',
            borderRadius: 4,
            color: '#3a3f5c',
            fontSize: 8,
            padding: '3px 8px',
            cursor: 'pointer',
            fontFamily: 'inherit',
            letterSpacing: '0.06em',
          }}
        >
          LOAD
        </button>
        <button
          onClick={() => mappingRef.current.click()}
          style={{
            background: mapping ? '#0a1a0a' : 'none',
            border: `1px solid ${mapping ? '#4ade80' : '#1a1f38'}`,
            borderRadius: 4,
            color: mapping ? '#4ade80' : '#3a3f5c',
            fontSize: 8,
            padding: '3px 8px',
            cursor: 'pointer',
            fontFamily: 'inherit',
            letterSpacing: '0.06em',
          }}
          title="Load mapping.json"
        >
          {mapping ? '✓ MAP' : 'MAP'}
        </button>
        <button
          onClick={() => specRef.current.click()}
          style={{
            background: Object.keys(specReqs).length ? '#0a0a1a' : 'none',
            border: `1px solid ${Object.keys(specReqs).length ? '#7c6af7' : '#1a1f38'}`,
            borderRadius: 4,
            color: Object.keys(specReqs).length ? '#7c6af7' : '#3a3f5c',
            fontSize: 8,
            padding: '3px 8px',
            cursor: 'pointer',
            fontFamily: 'inherit',
            letterSpacing: '0.06em',
          }}
          title="Load spec.md"
        >
          {Object.keys(specReqs).length ? '✓ SPEC' : 'SPEC'}
        </button>
        <input
          ref={mappingRef}
          type="file"
          accept=".json"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files[0];
            if (f) {
              const r = new FileReader();
              r.onload = (ev) => loadMapping(ev.target.result);
              r.readAsText(f);
            }
          }}
        />
        <input
          ref={specRef}
          type="file"
          accept=".md"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files[0];
            if (f) {
              const r = new FileReader();
              r.onload = (ev) => loadSpec(ev.target.result);
              r.readAsText(f);
            }
          }}
        />
      </div>

      {/* Filter bar */}
      <FilterBar
        filters={filters}
        setFilters={setFilters}
        stats={filterStats}
        clusterNames={clusterNames}
      />

      {/* Body */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Canvas */}
        <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
          {viewMode === 'architecture' ? (
            <ArchitectureView graph={graph} llmCtx={llmCtx} />
          ) : viewMode === 'clusters' ? (
            <ClusterGraph
              clusters={graph.clusters.filter(
                (cl) => !filters.cluster || cl.name === filters.cluster
              )}
              edges={visibleEdges}
              nodes={visibleNodes}
              allNodes={graph.nodes.filter(
                (n) => !filters.cluster || n.cluster.name === filters.cluster
              )}
              expandedClusters={expandedClusters}
              onToggle={toggleCluster}
              onSelectNode={handleSelect}
              selectedId={selectedId}
              affectedIds={affectedIds}
              linkedIds={linkedIds}
            />
          ) : (
            <FlatGraph
              nodes={visibleNodes}
              edges={visibleEdges}
              selectedId={selectedId}
              affectedIds={affectedIds}
              focusedIds={focusedIds}
              onSelect={handleSelect}
              refactorOnly={filters.refactorOnly}
              linkedIds={linkedIds}
            />
          )}
          {!selectedId && (
            <div
              style={{
                position: 'absolute',
                bottom: 12,
                left: '50%',
                transform: 'translateX(-50%)',
                fontSize: 9,
                color: '#181c38',
                letterSpacing: '0.1em',
                pointerEvents: 'none',
                whiteSpace: 'nowrap',
              }}
            >
              {viewMode === 'clusters'
                ? 'CLICK CLUSTER → EXPAND  ·  CLICK NODE → INSPECT'
                : 'CLICK NODE → INSPECT'}
            </div>
          )}
        </div>

        {/* Side panel */}
        <div
          style={{
            width: 282,
            borderLeft: '1px solid #0f1224',
            background: '#080b1e',
            display: viewMode === 'architecture' ? 'none' : 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            flexShrink: 0,
          }}
        >
          <div style={{ display: 'flex', borderBottom: '1px solid #0f1224', flexShrink: 0 }}>
            {['node', 'links', 'blast', 'spec', 'info'].map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                style={{
                  flex: 1,
                  padding: '7px 0',
                  background: 'none',
                  border: 'none',
                  borderBottom: tab === t ? '2px solid #7c6af7' : '2px solid transparent',
                  color: tab === t ? '#c8cde8' : '#3a3f5c',
                  fontSize: 8,
                  letterSpacing: '0.06em',
                  fontWeight: 700,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  textTransform: 'uppercase',
                }}
              >
                {t}
              </button>
            ))}
          </div>

          <div style={{ flex: 1, overflow: 'auto', padding: 13 }}>
            {/* NODE */}
            {tab === 'node' && !selectedNode && <Hint>Select a node to inspect it.</Hint>}
            {tab === 'node' && selectedNode && (
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#e0e4f0', marginBottom: 2 }}>
                  {selectedNode.label}
                </div>
                <div
                  style={{
                    fontSize: 8,
                    color: '#3a3f5c',
                    marginBottom: 9,
                    wordBreak: 'break-all',
                    lineHeight: 1.7,
                  }}
                >
                  {selectedNode.path}
                </div>
                <Row
                  label="ext"
                  value={<Chip color={extColor(selectedNode.ext)}>{selectedNode.ext || '—'}</Chip>}
                />
                <Row label="lines" value={selectedNode.lines} />
                <Row label="size" value={`${(selectedNode.size / 1024).toFixed(1)} KB`} />
                <Row
                  label="score"
                  value={
                    <span style={{ color: '#7c6af7', fontWeight: 700 }}>{selectedNode.score}</span>
                  }
                />
                <Row
                  label="cluster"
                  value={
                    <Chip color={selectedNode.cluster.color}>{selectedNode.cluster.name}</Chip>
                  }
                />
                <div style={{ display: 'flex', gap: 4, marginTop: 8, flexWrap: 'wrap' }}>
                  {selectedNode.isEntry && <Chip color="#f77c6a">entry-point</Chip>}
                  {selectedNode.isConfig && <Chip color="#f5c518">config</Chip>}
                  {selectedNode.isTest && <Chip color="#3ecfcf">test</Chip>}
                  {selectedNode.tags.map((t) => (
                    <Chip key={t} color="#4a5070">
                      {t}
                    </Chip>
                  ))}
                </div>
                {selectedNode.exports.length > 0 && (
                  <>
                    <SL>Exports ({selectedNode.exports.length})</SL>
                    {selectedNode.exports.map((ex, i) => (
                      <div
                        key={i}
                        style={{
                          display: 'flex',
                          gap: 5,
                          alignItems: 'center',
                          padding: '3px 0',
                          borderBottom: '1px solid #0f1228',
                        }}
                      >
                        <KindBadge kind={ex.kind} />
                        <span style={{ fontSize: 9, color: '#8890b0' }}>{ex.name}</span>
                        <span style={{ marginLeft: 'auto', fontSize: 8, color: '#2a2f4a' }}>
                          L{ex.line}
                        </span>
                      </div>
                    ))}
                  </>
                )}
                <SL>Metrics</SL>
                {[
                  ['inDegree', '↙'],
                  ['outDegree', '↗'],
                  ['pageRank', 'PR'],
                  ['betweenness', '⋈'],
                ].map(([k, s]) => (
                  <Row
                    key={k}
                    label={`${s} ${k}`}
                    value={
                      typeof selectedNode.metrics[k] === 'number'
                        ? selectedNode.metrics[k].toFixed(3)
                        : '-'
                    }
                  />
                ))}
                {selectedNode.refactor && (
                  <>
                    <SL>Refactor</SL>
                    <Row label="Functions affected" value={selectedNode.refactor.functions} />
                    <Row
                      label="Max priority"
                      value={
                        <span
                          style={{
                            color: selectedNode.refactor.maxPriority >= 5 ? '#f97373' : '#fbbf24',
                            fontWeight: 700,
                          }}
                        >
                          {selectedNode.refactor.maxPriority.toFixed(1)}
                        </span>
                      }
                    />
                    <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {selectedNode.refactor.issues.map((iss) => (
                        <Chip key={iss} color="#f97373">
                          {iss.replace(/_/g, ' ')}
                        </Chip>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}

            {/* LINKS */}
            {tab === 'links' && !selectedId && (
              <Hint>Select a node to see its direct imports/exports.</Hint>
            )}
            {tab === 'links' && selectedId && (
              <div>
                {/* imports (edges where this node is source) */}
                {(() => {
                  const outEdges = selectedEdges.filter((e) => e.source === selectedId);
                  const inEdges = selectedEdges.filter((e) => e.target === selectedId);
                  return (
                    <>
                      <SL>Imports ({outEdges.length})</SL>
                      {outEdges.length === 0 && (
                        <div style={{ color: '#2a2f4a', fontSize: 9 }}>No imports.</div>
                      )}
                      {outEdges.map((e, i) => {
                        const tn = graph.nodes.find((n) => n.id === e.target);
                        return (
                          <div
                            key={i}
                            onClick={() => handleSelect(e.target)}
                            style={{
                              padding: '5px 7px',
                              marginBottom: 3,
                              background: '#0c0e20',
                              borderRadius: 4,
                              border: `1px solid ${tn?.cluster.color || '#141830'}22`,
                              cursor: 'pointer',
                            }}
                          >
                            <div
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 5,
                                marginBottom: e.importedNames.length ? 3 : 0,
                              }}
                            >
                              <span style={{ fontSize: 8, color: extColor(tn?.ext || '') }}>↗</span>
                              <span style={{ fontSize: 9, color: '#c8cde8' }}>
                                {tn?.label || e.target}
                              </span>
                              {e.isType && (
                                <span style={{ fontSize: 7, color: '#3a3f6a', marginLeft: 'auto' }}>
                                  type
                                </span>
                              )}
                            </div>
                            {e.importedNames.length > 0 && (
                              <div style={{ fontSize: 7.5, color: '#3a4060', paddingLeft: 12 }}>
                                {e.importedNames.join(', ')}
                              </div>
                            )}
                          </div>
                        );
                      })}
                      <SL>Imported by ({inEdges.length})</SL>
                      {inEdges.length === 0 && (
                        <div style={{ color: '#2a2f4a', fontSize: 9 }}>
                          Not imported by any visible files.
                        </div>
                      )}
                      {inEdges.map((e, i) => {
                        const sn = graph.nodes.find((n) => n.id === e.source);
                        return (
                          <div
                            key={i}
                            onClick={() => handleSelect(e.source)}
                            style={{
                              padding: '5px 7px',
                              marginBottom: 3,
                              background: '#0c0e20',
                              borderRadius: 4,
                              border: `1px solid ${sn?.cluster.color || '#141830'}22`,
                              cursor: 'pointer',
                            }}
                          >
                            <div
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 5,
                                marginBottom: e.importedNames.length ? 3 : 0,
                              }}
                            >
                              <span style={{ fontSize: 8, color: '#7c6af7' }}>↙</span>
                              <span style={{ fontSize: 9, color: '#c8cde8' }}>
                                {sn?.label || e.source}
                              </span>
                              {e.isType && (
                                <span style={{ fontSize: 7, color: '#3a3f6a', marginLeft: 'auto' }}>
                                  type
                                </span>
                              )}
                            </div>
                            {e.importedNames.length > 0 && (
                              <div style={{ fontSize: 7.5, color: '#3a4060', paddingLeft: 12 }}>
                                {e.importedNames.join(', ')}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </>
                  );
                })()}
              </div>
            )}

            {/* BLAST */}
            {tab === 'blast' && !selectedId && (
              <Hint>Select a node to compute downstream impact.</Hint>
            )}
            {tab === 'blast' && selectedId && (
              <div>
                <div style={{ fontSize: 9, color: '#8890b0', marginBottom: 10 }}>
                  Modifying <span style={{ color: '#7c6af7' }}>{selectedNode?.label}</span> impacts:
                </div>
                {affectedIds.length === 0 ? (
                  <div style={{ color: '#2a2f4a', fontSize: 9 }}>No visible downstream nodes.</div>
                ) : (
                  affectedIds.map((id) => {
                    const n = graph.nodes.find((x) => x.id === id);
                    return (
                      <div
                        key={id}
                        onClick={() => handleSelect(id)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          padding: '4px 7px',
                          marginBottom: 3,
                          background: '#0c0e20',
                          borderRadius: 4,
                          border: '1px solid #141830',
                          cursor: 'pointer',
                        }}
                      >
                        <span style={{ fontSize: 8, color: extColor(n?.ext || '') }}>
                          {n?.ext || '?'}
                        </span>
                        <span
                          style={{
                            fontSize: 9,
                            color: '#c8cde8',
                            flex: 1,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {n?.label || id}
                        </span>
                        <span style={{ fontSize: 7, color: `${n?.cluster.color || '#3a3f5c'}80` }}>
                          {n?.cluster.name.split('/').pop()}
                        </span>
                      </div>
                    );
                  })
                )}
                <div
                  style={{
                    marginTop: 10,
                    padding: '8px 10px',
                    background: '#0c0e20',
                    borderRadius: 5,
                    border: '1px solid #1a1f38',
                  }}
                >
                  <div style={{ fontSize: 8, color: '#3a3f5c', marginBottom: 2 }}>BLAST RADIUS</div>
                  <div
                    style={{
                      fontSize: 22,
                      fontWeight: 700,
                      color:
                        affectedIds.length > 8
                          ? '#f77c6a'
                          : affectedIds.length > 3
                            ? '#f7c76a'
                            : '#7c6af7',
                    }}
                  >
                    {affectedIds.length}{' '}
                    <span style={{ fontSize: 10, fontWeight: 400, color: '#3a3f5c' }}>nodes</span>
                  </div>
                </div>
              </div>
            )}

            {/* SPEC */}
            {tab === 'spec' && !mapping && (
              <Hint>
                Load a <code style={{ color: '#7c6af7' }}>mapping.json</code> and{' '}
                <code style={{ color: '#7c6af7' }}>spec.md</code> using the MAP / SPEC buttons in
                the top bar.
              </Hint>
            )}
            {tab === 'spec' && mapping && !selectedId && (
              <Hint>Select a node to see its linked spec requirements.</Hint>
            )}
            {tab === 'spec' &&
              mapping &&
              selectedId &&
              (() => {
                // Find all matching entries for this node's path
                const nodePath = normalizePath(selectedNode?.path || selectedId);
                // Collect all unique requirements for this file
                const entries = [];
                for (const [k, list] of Object.entries(mapping)) {
                  if (nodePath.endsWith(k) || k.endsWith(nodePath) || nodePath === k) {
                    entries.push(...list);
                  }
                }
                // Deduplicate by requirement name
                const seen = new Set();
                const unique = entries.filter((e) => {
                  const key = e.requirement;
                  if (seen.has(key)) return false;
                  seen.add(key);
                  return true;
                });

                if (unique.length === 0)
                  return <Hint>No spec requirements mapped to this file.</Hint>;

                const confidenceColor = (c) => (c === 'llm' ? '#4ade80' : '#3a3f5c');

                return (
                  <div>
                    <div style={{ fontSize: 8, color: '#3a3f5c', marginBottom: 8 }}>
                      {unique.length} requirement{unique.length > 1 ? 's' : ''} linked
                    </div>
                    {unique.map((entry, i) => {
                      const req = specReqs ? specReqs[entry.requirement] : null;
                      const domainColor =
                        {
                          llm: '#3ecfcf',
                          task: '#f7c76a',
                          project: '#6af7a0',
                          openspec: '#7c6af7',
                        }[entry.domain] || '#64748b';
                      return (
                        <div
                          key={i}
                          style={{
                            marginBottom: 10,
                            background: '#0b0d1f',
                            borderRadius: 5,
                            border: '1px solid #141830',
                            overflow: 'hidden',
                          }}
                        >
                          {/* Header */}
                          <div
                            style={{
                              padding: '6px 9px',
                              borderBottom: '1px solid #0f1224',
                              display: 'flex',
                              alignItems: 'center',
                              gap: 5,
                              flexWrap: 'wrap',
                            }}
                          >
                            <span
                              style={{ fontSize: 9, fontWeight: 700, color: '#c8cde8', flex: 1 }}
                            >
                              {entry.requirement}
                            </span>
                            <span
                              style={{
                                fontSize: 7,
                                padding: '1px 5px',
                                borderRadius: 3,
                                background: `${domainColor}18`,
                                color: domainColor,
                                border: `1px solid ${domainColor}30`,
                              }}
                            >
                              {entry.domain}
                            </span>
                            <span
                              style={{ fontSize: 7, color: confidenceColor(entry.confidence) }}
                              title={`confidence: ${entry.confidence}`}
                            >
                              {entry.confidence === 'llm' ? '● llm' : '◌ heuristic'}
                            </span>
                          </div>
                          {/* Spec body */}
                          {req?.body ? (
                            <div
                              style={{
                                padding: '7px 9px',
                                fontSize: 8.5,
                                color: '#8890b0',
                                lineHeight: 1.7,
                                maxHeight: 200,
                                overflow: 'auto',
                              }}
                            >
                              {req.body.split('\n').map((line, li) => {
                                // Bold scenario lines
                                if (line.startsWith('####'))
                                  return (
                                    <div
                                      key={li}
                                      style={{
                                        color: '#5a6090',
                                        fontWeight: 700,
                                        marginTop: 6,
                                        fontSize: 8,
                                      }}
                                    >
                                      {line.replace(/^#+\s*/, '')}
                                    </div>
                                  );
                                if (line.startsWith('- **'))
                                  return (
                                    <div key={li} style={{ paddingLeft: 6, color: '#6a709a' }}>
                                      {line.replace(/\*\*/g, '')}
                                    </div>
                                  );
                                if (line.trim() === '')
                                  return <div key={li} style={{ height: 4 }} />;
                                return <div key={li}>{line}</div>;
                              })}
                            </div>
                          ) : (
                            <div style={{ padding: '7px 9px', fontSize: 8, color: '#2a2f4a' }}>
                              {req
                                ? 'Requirement title mismatch — spec section not found in the spec file.'
                                : <>Spec not loaded — run <code style={{ color: '#7c6af7' }}>spec-gen view</code> or load <code style={{ color: '#7c6af7' }}>spec.md</code> manually.</>}
                            </div>
                          )}
                          {/* Service */}
                          <div
                            style={{
                              padding: '4px 9px',
                              borderTop: '1px solid #0f1224',
                              fontSize: 7.5,
                              color: '#2a3060',
                            }}
                          >
                            service: <span style={{ color: '#3a4080' }}>{entry.service}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}

            {/* INFO */}
            {tab === 'info' && (
              <div>
                <SL>Statistics</SL>
                {[
                  ['Nodes', stats.nodeCount],
                  ['Edges', stats.edgeCount],
                  ['Clusters', stats.clusterCount],
                  ['Cycles', stats.cycleCount],
                  ['Avg degree', stats.avgDegree?.toFixed(2)],
                  ['Density', stats.density?.toFixed(4)],
                ].map(([l, v]) => (
                  <Row key={l} label={l} value={v ?? '-'} />
                ))}
                <SL>Active filters</SL>
                <Row
                  label="Visible nodes"
                  value={<span style={{ color: '#7c6af7' }}>{filterStats.visible}</span>}
                />
                <Row
                  label="Visible edges"
                  value={<span style={{ color: '#3ecfcf' }}>{filterStats.visibleEdges}</span>}
                />
                <Row label="Orphans" value={filterStats.orphanCount} />
                <SL>Top 10 by score</SL>
                {(graph.rankings.byImportance || []).slice(0, 10).map((fid, i) => {
                  const n = graph.nodes.find((x) => x.id === fid);
                  if (!n) return null;
                  return (
                    <div
                      key={fid}
                      onClick={() => handleSelect(fid)}
                      style={{
                        display: 'flex',
                        gap: 5,
                        alignItems: 'center',
                        padding: '3px 0',
                        cursor: 'pointer',
                      }}
                    >
                      <span style={{ fontSize: 8, color: '#2a2f4a', minWidth: 12 }}>{i + 1}</span>
                      <span style={{ fontSize: 8, color: extColor(n.ext) }}>{n.ext || '—'}</span>
                      <span
                        style={{
                          fontSize: 9,
                          color: '#8890b0',
                          flex: 1,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {n.label}
                      </span>
                      <span style={{ fontSize: 9, color: '#7c6af7' }}>{n.score}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Cluster legend — clickable to filter */}
          <div style={{ padding: '9px 13px', borderTop: '1px solid #0f1224', flexShrink: 0 }}>
            {/* Edge type legend */}
            <div style={{ display: 'flex', gap: 12, marginBottom: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <svg width="24" height="8" style={{ overflow: 'visible' }}>
                  <line
                    x1="0"
                    y1="4"
                    x2="18"
                    y2="4"
                    stroke="#5a6090"
                    strokeWidth="1.5"
                    markerEnd="url(#arr-legend)"
                  />
                  <defs>
                    <marker
                      id="arr-legend"
                      markerWidth="5"
                      markerHeight="5"
                      refX="4"
                      refY="2.5"
                      orient="auto"
                    >
                      <path d="M0,0 L0,5 L5,2.5z" fill="#5a6090" />
                    </marker>
                  </defs>
                </svg>
                <span style={{ fontSize: 7.5, color: '#3a3f5c' }}>runtime import</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <svg width="24" height="8" style={{ overflow: 'visible' }}>
                  <line
                    x1="0"
                    y1="4"
                    x2="18"
                    y2="4"
                    stroke="#3a3f5c"
                    strokeWidth="1.2"
                    strokeDasharray="3 2"
                    markerEnd="url(#arr-legend-type)"
                  />
                  <defs>
                    <marker
                      id="arr-legend-type"
                      markerWidth="5"
                      markerHeight="5"
                      refX="4"
                      refY="2.5"
                      orient="auto"
                    >
                      <path d="M0,0 L0,5 L5,2.5z" fill="#3a3f5c" />
                    </marker>
                  </defs>
                </svg>
                <span style={{ fontSize: 7.5, color: '#3a3f5c' }}>type-only</span>
              </div>
            </div>
            <div
              style={{ fontSize: 8, color: '#1e2240', letterSpacing: '0.08em', marginBottom: 5 }}
            >
              CLUSTERS · click to filter
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
              {graph.clusters.map((cl) => (
                <div
                  key={cl.id}
                  onClick={() =>
                    setFilters((f) => ({ ...f, cluster: f.cluster === cl.name ? '' : cl.name }))
                  }
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 3,
                    cursor: 'pointer',
                    opacity: filters.cluster && filters.cluster !== cl.name ? 0.25 : 1,
                    transition: 'opacity 0.15s',
                  }}
                >
                  <div
                    style={{
                      width: 5,
                      height: 5,
                      borderRadius: '50%',
                      background: cl.color,
                      boxShadow: filters.cluster === cl.name ? `0 0 5px ${cl.color}` : 'none',
                    }}
                  />
                  <span
                    style={{
                      fontSize: 7.5,
                      color: filters.cluster === cl.name ? cl.color : '#3a3f5c',
                    }}
                  >
                    {cl.name}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Micro-components ─────────────────────────────────────────────────────────
function Hint({ children }) {
  return (
    <div style={{ fontSize: 10, color: '#2a2f4a', lineHeight: 1.8, marginTop: 4 }}>{children}</div>
  );
}
function SL({ children }) {
  return (
    <div
      style={{
        fontSize: 8,
        color: '#3a3f5c',
        letterSpacing: '0.08em',
        marginTop: 12,
        marginBottom: 5,
        textTransform: 'uppercase',
      }}
    >
      {children}
    </div>
  );
}
function Row({ label, value }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '3px 0',
        borderBottom: '1px solid #0e1025',
      }}
    >
      <span style={{ fontSize: 9, color: '#3a4070' }}>{label}</span>
      <span style={{ fontSize: 9, color: '#8890b0' }}>{value}</span>
    </div>
  );
}
function Chip({ color, children }) {
  return (
    <span
      style={{
        fontSize: 8,
        padding: '2px 6px',
        borderRadius: 3,
        background: `${color}1a`,
        border: `1px solid ${color}45`,
        color,
        letterSpacing: '0.02em',
      }}
    >
      {children}
    </span>
  );
}
function KindBadge({ kind }) {
  const map = {
    class: ['#a78bfa', '#1a1060'],
    function: ['#4ecdc4', '#00301a'],
    interface: ['#60a5fa', '#001a30'],
    type: ['#f472b6', '#2a0a20'],
    enum: ['#f5c518', '#2a1a00'],
  };
  const [c, bg] = map[kind] || ['#64748b', '#1a1a2a'];
  return (
    <span
      style={{
        fontSize: 7,
        padding: '1px 5px',
        borderRadius: 3,
        background: bg,
        color: c,
        minWidth: 44,
        textAlign: 'center',
      }}
    >
      {kind || '—'}
    </span>
  );
}
