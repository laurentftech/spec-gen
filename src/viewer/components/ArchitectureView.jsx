import { useState, useMemo } from 'react';
import { ROLE_COLOR, ROLE_LABEL } from '../utils/constants.js';
import { computeArchOverview } from '../utils/graph-helpers.js';

export function ArchitectureView({ graph, llmCtx, focusedIds }) {
  const overview = useMemo(() => computeArchOverview(graph, llmCtx), [graph, llmCtx]);
  const [hovered, setHovered] = useState(null);
  const focusedClusterIds = useMemo(() => {
    if (!focusedIds?.length || !graph) return null;
    return new Set(graph.nodes.filter(n => focusedIds.includes(n.id)).map(n => n.cluster.id));
  }, [focusedIds, graph]);

  if (!overview) return <div style={{ color: 'var(--tx-ghost)', padding: 24, fontSize: 11 }}>No graph loaded.</div>;

  const { summary, clusters, globalEntryPoints, criticalHubs } = overview;

  const COLS = Math.min(4, clusters.length);
  const BOX_W = 140, BOX_H = 64, GAP_X = 30, GAP_Y = 40;
  const ROWS = Math.ceil(clusters.length / COLS);
  const SVG_W = COLS * (BOX_W + GAP_X) + GAP_X;
  const SVG_H = ROWS * (BOX_H + GAP_Y) + GAP_Y;

  const pos = {};
  clusters.forEach((cl, i) => {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    pos[cl.id] = {
      x: GAP_X + col * (BOX_W + GAP_X),
      y: GAP_Y + row * (BOX_H + GAP_Y),
    };
  });

  const arrows = [];
  clusters.forEach(cl => {
    (cl.dependsOn ?? []).forEach(toId => {
      const from = pos[cl.id];
      const to = pos[toId];
      if (!from || !to) return;
      const fx = from.x + BOX_W / 2, fy = from.y + BOX_H / 2;
      const tx = to.x + BOX_W / 2, ty = to.y + BOX_H / 2;
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
          stroke={isHov ? 'var(--ac-primary)' : 'var(--ac-arrow)'}
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
      <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
        <div style={{ display: 'flex', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
          {[
            ['files', summary.totalFiles],
            ['clusters', summary.totalClusters],
            ['edges', summary.totalEdges],
            summary.cycles > 0 ? ['⚠ cycles', summary.cycles] : null,
            summary.layerViolations > 0 ? ['⚠ violations', summary.layerViolations] : null,
          ].filter(Boolean).map(([l, v]) => (
            <div key={l} style={{ fontSize: 9, color: 'var(--tx-muted)', background: 'var(--bg-raised)', borderRadius: 4, padding: '2px 8px', border: '1px solid var(--bd-muted)' }}>
              <span style={{ color: l.startsWith('⚠') ? '#f97316' : 'var(--tx-primary)' }}>{v}</span> {l}
            </div>
          ))}
        </div>

        <svg width={SVG_W} height={SVG_H} style={{ display: 'block', minWidth: SVG_W }}>
          <defs>
            <marker id="arrowhead" markerWidth="6" markerHeight="6" refX="3" refY="3" orient="auto">
              <path d="M0,0 L0,6 L6,3 z" style={{ fill: 'var(--ac-cluster-arr)' }} />
            </marker>
          </defs>

          {arrows}

          {clusters.map(cl => {
            const { x, y } = pos[cl.id] ?? { x: 0, y: 0 };
            const color = ROLE_COLOR[cl.role] ?? '#475569';
            const isHov = hovered === cl.id;
            const isDimmed = focusedClusterIds && !focusedClusterIds.has(cl.id);
            return (
              <g
                key={cl.id}
                onMouseEnter={() => setHovered(cl.id)}
                onMouseLeave={() => setHovered(null)}
                style={{ cursor: 'default' }}
                opacity={isDimmed ? 0.15 : 1}
              >
                <rect
                  x={x} y={y} width={BOX_W} height={BOX_H}
                  rx={6} ry={6}
                  style={{ fill: isHov ? 'var(--bg-hover)' : 'var(--bg-node)' }}
                  stroke={isHov ? color : isDimmed ? 'var(--bg-raised)' : 'var(--ac-arrow)'}
                  strokeWidth={isHov ? 1.5 : 1}
                />
                <rect x={x} y={y} width={4} height={BOX_H} rx={3} ry={3} fill={color} opacity={0.8} />
                <text x={x + 12} y={y + 18} style={{ fill: 'var(--tx-primary)' }} fontSize={10} fontWeight="600" fontFamily="inherit">
                  {cl.name.length > 18 ? cl.name.slice(0, 17) + '…' : cl.name}
                </text>
                <text x={x + 12} y={y + 31} fill={color} fontSize={8} fontFamily="inherit" opacity={0.9}>
                  {ROLE_LABEL[cl.role] ?? cl.role}
                </text>
                <text x={x + 12} y={y + 44} style={{ fill: 'var(--tx-dim)' }} fontSize={8} fontFamily="inherit">
                  {cl.fileCount} files
                  {cl.hubCount > 0 ? `  ·  ${cl.hubCount} hub${cl.hubCount > 1 ? 's' : ''}` : ''}
                  {cl.entryPointCount > 0 ? `  ·  ${cl.entryPointCount} entry` : ''}
                </text>
                {cl.dependsOn.length > 0 && (
                  <text x={x + BOX_W - 6} y={y + 18} style={{ fill: 'var(--tx-dim)' }} fontSize={7} fontFamily="inherit" textAnchor="end">
                    →{cl.dependsOn.length}
                  </text>
                )}
              </g>
            );
          })}
        </svg>

        <div style={{ display: 'flex', gap: 12, marginTop: 12, flexWrap: 'wrap' }}>
          {Object.entries(ROLE_LABEL).map(([role, label]) => (
            <div key={role} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 8, color: 'var(--tx-dim)' }}>
              <div style={{ width: 8, height: 8, borderRadius: 2, background: ROLE_COLOR[role] }} />
              {label}
            </div>
          ))}
        </div>
      </div>

      <div style={{ width: 220, borderLeft: '1px solid var(--bd-faint)', overflow: 'auto', padding: '12px 10px', flexShrink: 0 }}>
        {globalEntryPoints.length > 0 && (
          <>
            <div style={{ ...S, color: '#4ade80', fontWeight: 600, marginBottom: 6, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
              Entry Points
            </div>
            {globalEntryPoints.map((ep, i) => (
              <div key={i} style={{ marginBottom: 6 }}>
                <div style={{ ...S, color: 'var(--tx-primary)', fontWeight: 600 }}>{ep.name}</div>
                <div style={{ ...S, color: 'var(--tx-dim)', wordBreak: 'break-all' }}>{ep.file}</div>
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
                <div style={{ ...S, color: 'var(--tx-primary)', fontWeight: 600 }}>{hub.name}</div>
                <div style={{ ...S, color: 'var(--tx-dim)', wordBreak: 'break-all' }}>{hub.file}</div>
                <div style={{ ...S, color: '#f97316', opacity: 0.7 }}>fanIn {hub.fanIn}  ·  fanOut {hub.fanOut}</div>
              </div>
            ))}
          </>
        )}

        {globalEntryPoints.length === 0 && criticalHubs.length === 0 && (
          <div style={{ ...S, color: 'var(--tx-ghost)' }}>Run <code style={{ color: 'var(--ac-primary)' }}>spec-gen analyze</code> to populate call graph data.</div>
        )}
      </div>
    </div>
  );
}
