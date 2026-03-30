import { useMemo, useRef, useEffect } from 'react';
import { usePanZoom } from '../hooks/usePanZoom.js';
import { extColor } from '../utils/constants.js';
import { computeClusterLayout } from '../utils/graph-helpers.js';

export function ClusterGraph({
  clusters,
  edges,
  nodes,
  allNodes,
  expandedClusters,
  onToggle,
  onSelectNode,
  onClear,
  hasSelection,
  selectedId,
  affectedIds,
  linkedIds,
  focusedIds,
  noGlow,
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
    panToCenter,
    isDrag,
  } = usePanZoom();

  const clusterKey = clusters.map((c) => c.id).join('|');
  useEffect(() => {
    reset();
  }, [clusterKey]);

  const prevExpandedRef = useRef(new Set());
  useEffect(() => {
    for (const cid of expandedClusters) {
      if (prevExpandedRef.current.has(cid)) continue;
      const cp = clusterPos[cid];
      if (!cp) continue;
      const members = (allNodes || nodes).filter((n) => n.cluster.id === cid);
      const r = 55 + members.length * 9 + 20;
      const { k, x: tx, y: ty } = transform;
      const inView =
        (cp.x - r) * k + tx >= 0 &&
        (cp.x + r) * k + tx <= 900 &&
        (cp.y - r) * k + ty >= 0 &&
        (cp.y + r) * k + ty <= 540;
      if (!inView) {
        panToCenter(cp.x, cp.y);
      }
    }
    prevExpandedRef.current = new Set(expandedClusters);
  }, [expandedClusters]);

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

  const clusterEdges = useMemo(() => {
    const counts = {};
    edges.forEach((e) => {
      const sn = nodes.find((n) => n.id === e.source);
      const tn = nodes.find((n) => n.id === e.target);
      if (!sn || !tn || sn.cluster.id === tn.cluster.id) return;
      const key = `${sn.cluster.id}->${tn.cluster.id}`;
      counts[key] = (counts[key] || 0) + 1;
    });
    return Object.entries(counts).map(([key, count]) => {
      const [sc, tc] = key.split('->');
      return { id: key, source: sc, target: tc, count };
    });
  }, [edges, nodes]);

  // Focused cluster IDs (clusters containing a chat-highlighted node)
  const focusedClusterIds = useMemo(() => {
    if (!focusedIds?.length) return null;
    return new Set(nodes.filter((n) => focusedIds.includes(n.id)).map((n) => n.cluster.id));
  }, [focusedIds, nodes]);

  // Neighbor cluster IDs (non-focused clusters directly connected to a focused cluster)
  const neighborClusterIds = useMemo(() => {
    if (!focusedClusterIds) return null;
    const neighbors = new Set();
    clusterEdges.forEach((e) => {
      if (focusedClusterIds.has(e.source) && !focusedClusterIds.has(e.target))
        neighbors.add(e.target);
      if (focusedClusterIds.has(e.target) && !focusedClusterIds.has(e.source))
        neighbors.add(e.source);
    });
    return neighbors;
  }, [focusedClusterIds, clusterEdges]);

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
          <path d="M0,0 L0,5 L6,2.5z" style={{ fill: 'var(--ac-cluster-arr)' }} />
        </marker>
        <marker id="carr-sel" markerWidth="6" markerHeight="6" refX="5" refY="2.5" orient="auto">
          <path d="M0,0 L0,5 L6,2.5z" style={{ fill: 'var(--ac-primary)' }} />
        </marker>
        <marker id="carr-in" markerWidth="6" markerHeight="6" refX="5" refY="2.5" orient="auto">
          <path d="M0,0 L0,5 L6,2.5z" style={{ fill: 'var(--ac-teal)' }} />
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
        {/* Inter-cluster edges */}
        {!selectedId &&
          (() => {
            return clusterEdges.map((e) => {
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
            // dim edge only when BOTH endpoints are non-focused (OR logic)
            const isDimEdge = focusedClusterIds &&
              !focusedClusterIds.has(e.source) && !focusedClusterIds.has(e.target);
            return (
              <g key={e.id} opacity={isDimEdge ? 0.06 : 0.5}>
                <line
                  x1={s.x + nx * rs}
                  y1={s.y + ny * rs}
                  x2={t.x - nx * (rt + 5)}
                  y2={t.y - ny * (rt + 5)}
                  stroke="var(--ac-arrow)"
                  strokeWidth={w}
                  markerEnd="url(#carr)"
                />
                <text
                  x={(s.x + nx * rs + t.x - nx * (rt + 5)) / 2}
                  y={(s.y + ny * rs + t.y - ny * (rt + 5)) / 2 - 4}
                  textAnchor="middle"
                  fontSize={7}
                  fontFamily="'JetBrains Mono',monospace"
                  style={{ pointerEvents: 'none', fill: 'var(--ac-cluster-arr)' }}
                >
                  {e.count}
                </text>
              </g>
            );
          });
          })()}

        {/* Node-level edges when a node is selected */}
        {selectedId &&
          (() => {
            const getNodePos = (nid) => {
              const n = (allNodes || nodes).find((x) => x.id === nid);
              if (!n) return null;
              const clId = n.cluster.id;
              if (nodeLayouts[clId]?.[nid]) return nodeLayouts[clId][nid];
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
                    stroke={isOut ? 'var(--ac-primary)' : 'var(--ac-teal)'}
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
                const isSel = e.source === selectedId || e.target === selectedId;
                const isDimEdge = focusedIds?.length > 0 && !isSel &&
                  !focusedIds.includes(e.source) && !focusedIds.includes(e.target);
                return (
                  <line
                    key={e.id}
                    x1={s.x + nx * r}
                    y1={s.y + ny * r}
                    x2={t.x - nx * (r + 4)}
                    y2={t.y - ny * (r + 4)}
                    stroke={cl.color}
                    strokeWidth={0.8}
                    strokeOpacity={isDimEdge ? 0.06 : 0.45}
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
              {(() => {
                 const clusterLinked =
                   linkedIds.size > 0 && allMembers.some((n) => linkedIds.has(n.id));
                 const hasFocused = focusedIds?.length > 0;
                 const clusterFocused = hasFocused && allMembers.some((n) => focusedIds.includes(n.id));
                 const isClusterGreyed =
                   (hasFocused && !clusterFocused && !clusterLinked) ||
                   (!hasFocused && visibleMembers.length === 0 && !clusterLinked);
                const isLinkedCollapsed = clusterLinked && !isExpanded;
                return (
                  <g
                    transform={`translate(${p.x},${p.y})`}
                    onClick={() => {
                      if (!isDrag()) onToggle(cl.id);
                    }}
                    style={{ cursor: 'pointer' }}
                    filter={
                      noGlow ? undefined : isExpanded ? 'url(#cglow)' : isLinkedCollapsed ? 'url(#cglow)' : undefined
                    }
                    opacity={isClusterGreyed ? (neighborClusterIds?.has(cl.id) ? 0.4 : 0.18) : 1}
                  >
                    <title>{cl.name} — {allMembers.length} file{allMembers.length !== 1 ? 's' : ''}</title>
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

              {/* Member nodes */}
              {isExpanded &&
                allMembers.map((n) => {
                  const np = nodeLayouts[cl.id]?.[n.id];
                  if (!np) return null;
                   const isSel = n.id === selectedId;
                   const isAff = affectedIds.includes(n.id);
                   const col = extColor(n.ext);
                   const isInFocused = focusedIds?.includes(n.id) || false;
                   const isLinked = linkedIds.has(n.id);
                   const hasFocused = focusedIds?.length > 0;
                   const isVisible = visibleIds.has(n.id);
                   const isGreyed = !isInFocused && (
                     (hasFocused && !isLinked) ||
                     (!hasFocused && !isVisible && !isLinked)
                   );
                  return (
                    <g
                      key={n.id}
                      transform={`translate(${np.x},${np.y})`}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!isDrag()) onSelectNode(n.id);
                      }}
                      style={{ cursor: 'pointer' }}
                      filter={noGlow ? undefined : isSel ? 'url(#nglow)' : undefined}
                      opacity={isGreyed ? 0.18 : 1}
                    >
                      <title>{n.label}{n.path ? `\n${n.path}` : ''}</title>
                      <circle
                        r={13}
                        fill={isSel ? `${col}1a` : 'var(--bg-node)'}
                        stroke={isSel ? col : isAff ? col : cl.color}
                        strokeWidth={isSel ? 2 : 0.8}
                        strokeOpacity={isSel ? 1 : isAff ? 0.9 : 0.45}
                      />
                      <text
                        textAnchor="middle"
                        dominantBaseline="middle"
                        fontSize={6}
                        fill={isSel ? 'var(--tx-node-sel)' : 'var(--tx-node)'}
                        fontFamily="'JetBrains Mono',monospace"
                        style={{ pointerEvents: 'none' }}
                      >
                        {n.label.length > 10 ? n.label.slice(0, 9) + '...' : n.label}
                      </text>
                    </g>
                  );
                })}
            </g>
          );
        })}
      </g>
      <foreignObject x="8" y="8" width="52" height="44" style={{ pointerEvents: 'all' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <button
            onClick={reset}
            title="Reset pan/zoom (or double-click background)"
            style={{
              fontSize: 8,
              padding: '2px 6px',
              background: 'var(--bg-input)',
              border: `1px solid ${transform.x !== 0 || transform.y !== 0 || transform.k !== 1 ? 'var(--ac-primary)' : 'var(--bd-muted)'}`,
              borderRadius: 4,
              color: transform.x !== 0 || transform.y !== 0 || transform.k !== 1 ? 'var(--ac-primary)' : 'var(--tx-faint)',
              cursor: 'pointer',
              fontFamily: "'JetBrains Mono',monospace",
              letterSpacing: '0.05em',
            }}
          >
            ⌖ view
          </button>
          <button
            onClick={onClear}
            title="Clear selection and collapse all clusters (Escape)"
            style={{
              fontSize: 8,
              padding: '2px 6px',
              background: 'var(--bg-input)',
              border: `1px solid ${hasSelection ? 'var(--ac-primary)' : 'var(--bd-muted)'}`,
              borderRadius: 4,
              color: hasSelection ? 'var(--ac-primary)' : 'var(--tx-faint)',
              cursor: hasSelection ? 'pointer' : 'default',
              fontFamily: "'JetBrains Mono',monospace",
              letterSpacing: '0.05em',
            }}
          >
            x clear
          </button>
        </div>
      </foreignObject>
    </svg>
  );
}
