import { useState, useEffect, useMemo, useRef } from 'react';

const ROLE_COLOR = {
  service: '#4ade80',
  orchestrator: '#fbbf24',
  entrypoint: '#f77c6a',
  controller: '#7c6af7',
  'domain-model': '#3ecfcf',
  adapter: '#f5c518',
  utility: '#64748b',
  unknown: '#475569',
};

// Heuristic role fallback when graph hasn't been enriched yet
function clusterRole(clusterName) {
  const n = clusterName.toLowerCase();
  if (/route|controller|api|endpoint/.test(n)) return 'controller';
  if (/service|manager|processor/.test(n)) return 'service';
  if (/model|entity|schema|domain/.test(n)) return 'domain-model';
  if (/adapter|gateway|client|infra/.test(n)) return 'adapter';
  if (/util|helper|common|shared/.test(n)) return 'utility';
  if (/index|main|app|server|entry/.test(n)) return 'entrypoint';
  return 'unknown';
}

export function SimplifiedArchitectureView({ graph, focusedIds, onDrillDown }) {
  const [selectedClusterId, setSelectedClusterId] = useState(null);
  const [positions, setPositions] = useState({});
  const svgRef = useRef(null);
  const animFrameRef = useRef(null);
  const dragRef = useRef(null); // { id, startX, startY, origX, origY }

  // Build cluster-level nodes from graph.nodes
  const clusterNodes = useMemo(() => {
    if (!graph?.nodes) return [];
    const map = new Map();
    for (const n of graph.nodes) {
      const c = n.cluster;
      if (!c?.id) continue;
      if (!map.has(c.id)) {
        map.set(c.id, {
          id: c.id,
          name: c.name,
          color: c.color,
          fileCount: 0,
          nodeIds: [],
        });
      }
      const entry = map.get(c.id);
      entry.fileCount++;
      entry.nodeIds.push(n.id);
    }
    return Array.from(map.values()).map(c => ({
      ...c,
      role: c.role ?? clusterRole(c.name), // c.role set by enrichGraphWithArchNodes if pipeline has run
    }));
  }, [graph]);

  // Inter-cluster edges, deduplicated, no self-loops
  const clusterEdges = useMemo(() => {
    if (!graph?.edges || !graph?.nodes) return [];
    const nodeToCluster = new Map();
    for (const n of graph.nodes) {
      if (n.cluster?.id) nodeToCluster.set(n.id, n.cluster.id);
    }
    const seen = new Set();
    const result = [];
    for (const e of graph.edges) {
      const src = nodeToCluster.get(e.source);
      const tgt = nodeToCluster.get(e.target);
      if (!src || !tgt || src === tgt) continue;
      const key = `${src}=>${tgt}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ source: src, target: tgt });
    }
    return result;
  }, [graph]);

  // Map node id -> cluster id (for focusedIds resolution)
  const nodeToCluster = useMemo(() => {
    const map = new Map();
    if (graph?.nodes) {
      for (const n of graph.nodes) {
        if (n.cluster?.id) map.set(n.id, n.cluster.id);
      }
    }
    return map;
  }, [graph]);

  // Force-directed layout
  useEffect(() => {
    if (clusterNodes.length === 0) return;
    const W = 900, H = 540;
    const cx = W / 2, cy = H / 2;
    const n = clusterNodes.length;

    // Init on a circle
    const pos = {};
    clusterNodes.forEach((c, i) => {
      const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
      const r = Math.min(W, H) * 0.32;
      pos[c.id] = {
        x: cx + Math.cos(angle) * r + (Math.random() - 0.5) * 20,
        y: cy + Math.sin(angle) * r + (Math.random() - 0.5) * 20,
      };
    });

    setPositions({ ...pos });

    const ids = clusterNodes.map(c => c.id);
    let current = { ...pos };
    let iter = 0;
    const MAX_ITER = 300;
    const MIN_DIST = 90;
    const LINK_DIST = 180;

    const tick = () => {
      if (iter++ >= MAX_ITER) { setPositions({ ...current }); return; }
      const next = {};
      for (const id of ids) {
        let fx = 0, fy = 0;
        const p = current[id];

        // Repulsion
        for (const other of ids) {
          if (other === id) continue;
          const q = current[other];
          const dx = p.x - q.x, dy = p.y - q.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 0.1;
          if (dist < MIN_DIST * 3) {
            const force = (MIN_DIST * MIN_DIST) / (dist * dist);
            fx += (dx / dist) * force * 2;
            fy += (dy / dist) * force * 2;
          }
        }

        // Attraction along edges
        for (const e of clusterEdges) {
          const otherId = e.source === id ? e.target : e.target === id ? e.source : null;
          if (!otherId || !current[otherId]) continue;
          const q = current[otherId];
          const dx = q.x - p.x, dy = q.y - p.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 0.1;
          if (dist > LINK_DIST) {
            fx += (dx / dist) * (dist - LINK_DIST) * 0.04;
            fy += (dy / dist) * (dist - LINK_DIST) * 0.04;
          }
        }

        // Gravity toward center
        fx += (cx - p.x) * 0.008;
        fy += (cy - p.y) * 0.008;

        const damping = 0.82;
        next[id] = {
          x: Math.max(40, Math.min(W - 40, p.x + fx * damping)),
          y: Math.max(40, Math.min(H - 40, p.y + fy * damping)),
        };
      }
      current = next;
      setPositions({ ...current });
      animFrameRef.current = requestAnimationFrame(tick);
    };

    animFrameRef.current = requestAnimationFrame(tick);
    return () => { if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current); };
  }, [clusterNodes, clusterEdges]);

  // Auto-center on focused nodes (map fn ids -> cluster ids)
  useEffect(() => {
    if (!focusedIds?.length || !svgRef.current || Object.keys(positions).length === 0) return;
    const focusedClusterIds = [...new Set(focusedIds.map(id => nodeToCluster.get(id)).filter(Boolean))];
    if (focusedClusterIds.length === 0) return;
    setSelectedClusterId(focusedClusterIds[0]);
    const pts = focusedClusterIds.map(id => positions[id]).filter(Boolean);
    if (pts.length === 0) return;
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    const midX = (Math.min(...xs) + Math.max(...xs)) / 2;
    const midY = (Math.min(...ys) + Math.max(...ys)) / 2;
    svgRef.current.setAttribute('viewBox', `${midX - 220} ${midY - 160} 440 320`);
  }, [focusedIds, positions, nodeToCluster]);

  useEffect(() => {
    if (!focusedIds?.length && svgRef.current) {
      svgRef.current.setAttribute('viewBox', '0 0 900 540');
    }
  }, [focusedIds]);

  const selectedCluster = selectedClusterId ? clusterNodes.find(c => c.id === selectedClusterId) : null;


  const getSVGPoint = (e) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    return pt.matrixTransform(svg.getScreenCTM().inverse());
  };

  const onMouseDown = (e, id) => {
    e.stopPropagation();
    // Kill the sim so dragging isn't fought by physics
    if (animFrameRef.current) { cancelAnimationFrame(animFrameRef.current); animFrameRef.current = null; }
    const { x, y } = getSVGPoint(e);
    dragRef.current = { id, startX: x, startY: y, origX: positions[id].x, origY: positions[id].y };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  const onMouseMove = (e) => {
    if (!dragRef.current) return;
    const { id, startX, startY, origX, origY } = dragRef.current;
    const { x, y } = getSVGPoint(e);
    setPositions(prev => ({
      ...prev,
      [id]: { x: origX + (x - startX), y: origY + (y - startY) },
    }));
  };

  const onMouseUp = () => {
    dragRef.current = null;
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
  };

  // Radius scaled by file count
  const radius = (c) => Math.max(18, Math.min(36, 14 + Math.sqrt(c.fileCount) * 4));

  if (!graph) return <div style={{ color: '#3a3f5c', padding: 24 }}>No graph data.</div>;

  const W = 900, H = 540;

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      <div style={{ flex: 1, position: 'relative', background: '#07091a' }}>
        <svg ref={svgRef} width={W} height={H} viewBox={`0 0 ${W} ${H}`}
          style={{ display: 'block', width: '100%', height: '100%' }}>
          <defs>
            <marker id="arr-s" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
              <path d="M0,0 L0,6 L6,3 z" fill="#2a2f5a" />
            </marker>
          </defs>

          {/* Inter-cluster edges */}
          {clusterEdges.map(e => {
            const src = positions[e.source];
            const tgt = positions[e.target];
            if (!src || !tgt) return null;
            const cSrc = clusterNodes.find(c => c.id === e.source);
            const cTgt = clusterNodes.find(c => c.id === e.target);
            if (!cSrc || !cTgt) return null;
            const dx = tgt.x - src.x, dy = tgt.y - src.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            const rSrc = radius(cSrc), rTgt = radius(cTgt);
            return (
              <line key={`${e.source}=>${e.target}`}
                x1={src.x + (dx / dist) * rSrc} y1={src.y + (dy / dist) * rSrc}
                x2={tgt.x - (dx / dist) * (rTgt + 5)} y2={tgt.y - (dy / dist) * (rTgt + 5)}
                stroke="#1e2450" strokeWidth={1.5} markerEnd="url(#arr-s)" opacity={0.6}
              />
            );
          })}

          {/* Cluster nodes */}
          {clusterNodes.map(c => {
            const p = positions[c.id];
            if (!p) return null;
            const isSelected = selectedClusterId === c.id;
            const isFocused = focusedIds?.some(id => nodeToCluster.get(id) === c.id);
            const roleColor = ROLE_COLOR[c.role] || '#475569';
            const borderColor = isFocused ? '#7c6af7' : (c.color || roleColor);
            const r = radius(c);
            const label = c.name.split('/').pop();
            return (
              <g key={c.id} transform={`translate(${p.x},${p.y})`}
                onMouseDown={(e) => onMouseDown(e, c.id)}
                onClick={() => setSelectedClusterId(isSelected ? null : c.id)}
                onDoubleClick={() => onDrillDown?.(c.nodeIds[0])}
                style={{ cursor: dragRef.current?.id === c.id ? 'grabbing' : 'grab' }}
              >
                {isFocused && (
                  <circle r={r + 6} fill="none" stroke="#7c6af7" strokeWidth={1.5} opacity={0.35} />
                )}
                {/* Cluster circle */}
                <circle r={r}
                  fill={isSelected ? '#12163a' : '#0b0e28'}
                  stroke={borderColor}
                  strokeWidth={isSelected || isFocused ? 2.5 : 1.5}
                />
                {/* Role color ring */}
                <circle r={r - 4} fill="none" stroke={roleColor} strokeWidth={1} opacity={0.3} />
                {/* File count */}
                <text textAnchor="middle" dominantBaseline="middle"
                  fill={roleColor} fontSize={10} fontFamily="inherit" fontWeight={600} opacity={0.9}
                >{c.fileCount}</text>
                {/* Label above */}
                <text y={-r - 7} textAnchor="middle"
                  fill="#c8cde8" fontSize={10} fontFamily="'JetBrains Mono', monospace"
                >{label.slice(0, 16)}{label.length > 16 ? '…' : ''}</text>
                {/* Role below */}
                <text y={r + 12} textAnchor="middle"
                  fill={roleColor} fontSize={7} fontFamily="inherit" opacity={0.8}
                >{c.role}</text>
              </g>
            );
          })}
        </svg>
      </div>

      {/* Side panel */}
      <div style={{ width: 240, borderLeft: '1px solid #0f1224', overflow: 'auto', padding: 12, background: '#080b1e' }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#e0e4f0', marginBottom: 8 }}>Architecture</div>
        <div style={{ fontSize: 9, color: '#8890b0', marginBottom: 12 }}>
          {clusterNodes.length} domains · {clusterEdges.length} deps
          {onDrillDown && <span style={{ color: '#3a3f5c' }}> · dbl-click to expand</span>}
        </div>

        <div style={{ fontSize: 9, color: '#6a70a0', marginBottom: 6, fontWeight: 600 }}>Role</div>
        {Object.entries(ROLE_COLOR).map(([role, color]) => (
          <div key={role} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3, fontSize: 8 }}>
            <div style={{ width: 7, height: 7, borderRadius: '50%', background: color, flexShrink: 0 }} />
            <span style={{ color: '#c8cde8', textTransform: 'capitalize' }}>{role.replace('-', ' ')}</span>
          </div>
        ))}

        {selectedCluster && (
          <>
            <div style={{ marginTop: 16, borderTop: '1px solid #0f1224', paddingTop: 12 }}>
              <div style={{ fontSize: 9, color: '#6a70a0', fontWeight: 600, marginBottom: 6 }}>Selected</div>
              <div style={{ fontSize: 10, color: '#c8cde8', fontWeight: 700 }}>{selectedCluster.name.split('/').pop()}</div>
              <div style={{ fontSize: 8, color: '#3a3f5c', marginTop: 2, wordBreak: 'break-all' }}>{selectedCluster.name}</div>
              <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 7, padding: '2px 5px', borderRadius: 3, background: `${ROLE_COLOR[selectedCluster.role]}18`, color: ROLE_COLOR[selectedCluster.role], border: `1px solid ${ROLE_COLOR[selectedCluster.role]}35` }}>
                  {selectedCluster.role}
                </span>
                <span style={{ fontSize: 7, padding: '2px 5px', borderRadius: 3, background: '#1a1f3a', color: '#6a70a0', border: '1px solid #2a2f5a' }}>
                  {selectedCluster.fileCount} files
                </span>
              </div>
              {onDrillDown && (
                <button
                  onClick={() => onDrillDown(selectedCluster.nodeIds[0])}
                  style={{ marginTop: 10, width: '100%', padding: '4px 0', fontSize: 8, background: '#0f1230', border: '1px solid #2a2f5a', borderRadius: 3, color: '#7c6af7', cursor: 'pointer' }}
                >
                  ⬡ expand cluster
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
