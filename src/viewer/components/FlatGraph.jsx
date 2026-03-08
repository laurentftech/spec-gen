import { useRef, useState, useEffect } from 'react';
import { usePanZoom } from '../hooks/usePanZoom.js';
import { extColor } from '../utils/constants.js';
import { computeLayout } from '../utils/graph-helpers.js';

export function FlatGraph({
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
          <path d="M0,0 L0,5 L6,2.5z" style={{ fill: 'var(--ac-arrow)' }} />
        </marker>
        <marker id="arr-sel" markerWidth="6" markerHeight="6" refX="5" refY="2.5" orient="auto">
          <path d="M0,0 L0,5 L6,2.5z" style={{ fill: 'var(--ac-primary)' }} />
        </marker>
        <marker id="arr-aff" markerWidth="6" markerHeight="6" refX="5" refY="2.5" orient="auto">
          <path d="M0,0 L0,5 L6,2.5z" fill="#f77c6a" />
        </marker>
        <marker id="arr-type" markerWidth="6" markerHeight="6" refX="5" refY="2.5" orient="auto">
          <path d="M0,0 L0,5 L6,2.5z" style={{ fill: 'var(--ac-edge-type)' }} />
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
              stroke={isSel ? 'var(--ac-primary)' : isAff ? '#f77c6a' : e.isType ? 'var(--ac-edge-type)' : 'var(--bd-edge)'}
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
                fill={isSel ? `${col}1a` : isAff ? `${col}0d` : 'var(--bg-node)'}
                stroke={isSel ? col : isAff ? col : 'var(--bd-edge)'}
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
                fill={isSel ? 'var(--tx-node-sel)' : isAff ? col : 'var(--tx-node)'}
                fontFamily="'JetBrains Mono',monospace"
                style={{ pointerEvents: 'none' }}
              >
                {n.label.length > 13 ? n.label.slice(0, 12) + '...' : n.label}
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
      <foreignObject x="8" y="8" width="52" height="20" style={{ pointerEvents: 'all' }}>
        <button
          onClick={reset}
          title="Reset pan/zoom (or double-click background)"
          style={{
            fontSize: 8,
            padding: '2px 6px',
            background: 'var(--bg-input)',
            border: `1px solid ${transform.x !== 0 || transform.y !== 0 || transform.k !== 1 ? 'var(--ac-primary)' : 'var(--bd-muted)'}`,
            borderRadius: 4,
            color:
              transform.x !== 0 || transform.y !== 0 || transform.k !== 1 ? 'var(--ac-primary)' : 'var(--tx-faint)',
            cursor: 'pointer',
            fontFamily: "'JetBrains Mono',monospace",
            letterSpacing: '0.05em',
          }}
        >
          ⌖ reset view
        </button>
      </foreignObject>
    </svg>
  );
}
