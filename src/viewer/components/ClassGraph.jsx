/**
 * ClassGraph — force-directed graph mixing real class nodes and file-level
 * module nodes (free functions grouped by file).
 *
 * Node types:
 *   - Class node   → circle, colored by language
 *   - Module node  → rounded-rect (hexagonal feel), dimmer fill, name in [brackets]
 *
 * Edge types:
 *   - extends / embeds / implements → solid/dashed UML arrows
 *   - cross-class/module calls      → curved bezier, weight = call count
 *
 * Hover shows a floating tooltip with full details.
 * Click to expand and see individual method sub-nodes.
 */

import { useState, useMemo, useCallback } from 'react';
import { usePanZoom } from '../hooks/usePanZoom.js';

// ============================================================================
// CONSTANTS
// ============================================================================

const W = 1400;
const H = 800;
const CLASS_R  = 28;   // base radius for class nodes
const MODULE_R = 24;   // base radius for module nodes (smaller)
const ITERS    = 240;  // force-layout iterations

const LANG_CSS_VAR = {
  TypeScript:  'var(--lc-cyan)',
  JavaScript:  'var(--lc-yellow)',
  Python:      'var(--lc-green)',
  Java:        'var(--lc-orange)',
  'C++':       'var(--lc-purple)',
  Go:          'var(--lc-cyan)',
  Rust:        'var(--lc-red)',
  Ruby:        'var(--lc-pink)',
  Swift:       'var(--lc-orange)',
};

const COMPONENT_COLORS = [
  'var(--lc-cyan)',
  'var(--lc-orange)',
  'var(--lc-green)',
  'var(--lc-pink)',
  'var(--lc-purple)',
  'var(--lc-yellow)',
  'var(--lc-red)',
  '#7eb8f7',
  '#f7c56a',
  '#a0e8a0',
];

function langColor(lang) {
  return LANG_CSS_VAR[lang] ?? 'var(--ac-primary)';
}

function componentColor(compIndex) {
  return COMPONENT_COLORS[compIndex % COMPONENT_COLORS.length];
}

// ============================================================================
// FORCE LAYOUT
// ============================================================================

// Find connected components (union-find)
function connectedComponents(nodes, edges) {
  const parent = new Map(nodes.map(n => [n.id, n.id]));
  function find(x) {
    if (parent.get(x) !== x) parent.set(x, find(parent.get(x)));
    return parent.get(x);
  }
  function union(a, b) { parent.set(find(a), find(b)); }
  edges.forEach(e => { if (parent.has(e.source) && parent.has(e.target)) union(e.source, e.target); });
  const groups = new Map();
  nodes.forEach(n => {
    const root = find(n.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(n);
  });
  return [...groups.values()].sort((a, b) => b.length - a.length);
}

function forceLayout(nodes, edges) {
  if (!nodes.length) return {};
  const pos = {};
  const angle0 = -Math.PI / 2;

  // Assign each component its own center so components don't overlap
  const components = connectedComponents(nodes, edges);
  const nComp = components.length;
  components.forEach((comp, ci) => {
    const a = angle0 + (ci / nComp) * Math.PI * 2;
    const cx = nComp === 1 ? W / 2 : W / 2 + Math.cos(a) * W * 0.28;
    const cy = nComp === 1 ? H / 2 : H / 2 + Math.sin(a) * H * 0.24;
    const r = Math.min(60, 18 * Math.sqrt(comp.length));
    comp.forEach((n, i) => {
      const a2 = angle0 + (i / Math.max(comp.length, 1)) * Math.PI * 2;
      pos[n.id] = { x: cx + Math.cos(a2) * r, y: cy + Math.sin(a2) * r };
    });
  });

  const k = Math.sqrt((W * H) / Math.max(nodes.length, 1)) * 0.65;

  for (let iter = 0; iter < ITERS; iter++) {
    const disp = {};
    nodes.forEach((n) => { disp[n.id] = { x: 0, y: 0 }; });

    // Repulsion (only within same component to avoid inter-component mixing)
    const compOf = new Map();
    components.forEach((comp, ci) => comp.forEach(n => compOf.set(n.id, ci)));
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        if (compOf.get(a.id) !== compOf.get(b.id)) continue;
        const dx = pos[a.id].x - pos[b.id].x;
        const dy = pos[a.id].y - pos[b.id].y;
        const d = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
        const f = (k * k) / d;
        disp[a.id].x += (dx / d) * f;
        disp[a.id].y += (dy / d) * f;
        disp[b.id].x -= (dx / d) * f;
        disp[b.id].y -= (dy / d) * f;
      }
    }

    // Attraction along edges
    edges.forEach((e) => {
      if (!pos[e.source] || !pos[e.target]) return;
      const dx = pos[e.source].x - pos[e.target].x;
      const dy = pos[e.source].y - pos[e.target].y;
      const d = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
      const f = (d * d) / (k * 2);
      disp[e.source].x -= (dx / d) * f;
      disp[e.source].y -= (dy / d) * f;
      disp[e.target].x  += (dx / d) * f;
      disp[e.target].y  += (dy / d) * f;
    });

    // Gravity toward each component's assigned center
    const compCenters = new Map();
    components.forEach((comp, ci) => {
      const a = angle0 + (ci / nComp) * Math.PI * 2;
      compCenters.set(ci, {
        cx: nComp === 1 ? W / 2 : W / 2 + Math.cos(a) * W * 0.28,
        cy: nComp === 1 ? H / 2 : H / 2 + Math.sin(a) * H * 0.24,
      });
    });
    nodes.forEach((n) => {
      const ci = compOf.get(n.id);
      const { cx, cy } = compCenters.get(ci);
      disp[n.id].x += (cx - pos[n.id].x) * 0.06;
      disp[n.id].y += (cy - pos[n.id].y) * 0.06;
    });

    const temp = k * Math.max(0.01, 1 - iter / ITERS) * 0.7;
    nodes.forEach((n) => {
      const d = Math.sqrt(disp[n.id].x ** 2 + disp[n.id].y ** 2);
      if (d > 0) {
        pos[n.id].x += (disp[n.id].x / d) * Math.min(d, temp);
        pos[n.id].y += (disp[n.id].y / d) * Math.min(d, temp);
      }
      pos[n.id].x = Math.max(70, Math.min(W - 70, pos[n.id].x));
      pos[n.id].y = Math.max(70, Math.min(H - 70, pos[n.id].y));
    });
  }
  return pos;
}

// ============================================================================
// CURVED PATH HELPER
// ============================================================================

function curvePath(x1, y1, x2, y2, bend = 0.18) {
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const dx = x2 - x1;
  const dy = y2 - y1;
  // Perpendicular offset for bezier control point
  const cpx = mx - dy * bend;
  const cpy = my + dx * bend;
  return `M ${x1} ${y1} Q ${cpx} ${cpy} ${x2} ${y2}`;
}

// ============================================================================
// SVG DEFS
// ============================================================================

function Defs() {
  return (
    <defs>
      <marker id="cg-inherit" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto">
        <polygon points="0 0, 9 4, 0 8" fill="none" stroke="var(--lc-purple)" strokeWidth="1.3" />
      </marker>
      <marker id="cg-impl" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto">
        <polygon points="0 0, 9 4, 0 8" fill="none" stroke="var(--lc-cyan)" strokeWidth="1.3" />
      </marker>
      <marker id="cg-embeds" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto">
        <polygon points="0 4, 5 0, 10 4, 5 8" fill="none" stroke="var(--lc-green)" strokeWidth="1.3" />
      </marker>
      <marker id="cg-call" markerWidth="7" markerHeight="6" refX="6" refY="3" orient="auto">
        <polygon points="0 0, 6 3, 0 6" fill="var(--tx-secondary)" />
      </marker>
    </defs>
  );
}

// ============================================================================
// EXPANDED CLASS — method grid inside a dashed rectangle
// ============================================================================

function ExpandedClass({ cls, cx, cy, methods, color, onMethodHover, onMethodLeave }) {
  const ROW_H   = 14;   // px per function row
  const PAD_X   = 12;
  const PAD_TOP = 22;
  const PAD_BOT = 10;
  const maxLabelLen = Math.max(...methods.map(m => m.name.length), cls.name.length, 8);
  const rw = Math.max(maxLabelLen * 6.2 + PAD_X * 2, 110);
  const rh = PAD_TOP + methods.length * ROW_H + PAD_BOT;

  return (
    <g>
      {/* Card background */}
      <rect
        x={cx - rw / 2} y={cy - rh / 2}
        width={rw} height={rh}
        rx={6}
        fill="var(--bg-raised)"
        stroke={color}
        strokeWidth={1.5}
      />
      {/* Header bar */}
      <rect
        x={cx - rw / 2} y={cy - rh / 2}
        width={rw} height={18}
        rx={6}
        fill={color} fillOpacity={0.18}
        stroke="none"
      />
      <rect
        x={cx - rw / 2} y={cy - rh / 2 + 12}
        width={rw} height={6}
        fill={color} fillOpacity={0.18}
        stroke="none"
      />
      {/* Class / module name */}
      <text x={cx} y={cy - rh / 2 + 13}
        textAnchor="middle" fontSize={9.5} fill={color} fontWeight="700"
        style={{ fontFamily: 'monospace', pointerEvents: 'none' }}>
        {cls.name}
      </text>
      {/* Divider */}
      <line
        x1={cx - rw / 2 + 6} y1={cy - rh / 2 + 19}
        x2={cx + rw / 2 - 6} y2={cy - rh / 2 + 19}
        stroke={color} strokeWidth={0.5} opacity={0.4}
      />
      {/* Function list */}
      {methods.map((m, mi) => {
        const fy = cy - rh / 2 + PAD_TOP + mi * ROW_H + ROW_H / 2;
        const isAsync = m.isAsync;
        return (
          <g key={m.id}
            onMouseEnter={(e) => onMethodHover(e, m)}
            onMouseLeave={onMethodLeave}
            style={{ cursor: 'default' }}>
            {/* Hover band (invisible but interactive) */}
            <rect x={cx - rw / 2 + 2} y={fy - ROW_H / 2 + 1}
              width={rw - 4} height={ROW_H - 1}
              fill="transparent" />
            {/* Async indicator dot */}
            {isAsync && (
              <circle cx={cx - rw / 2 + PAD_X - 4} cy={fy} r={2}
                fill={color} opacity={0.6} />
            )}
            {/* Function name */}
            <text
              x={cx - rw / 2 + PAD_X}
              y={fy + 4}
              fontSize={8.5}
              fill="var(--tx-primary)"
              style={{ fontFamily: 'monospace', pointerEvents: 'none' }}>
              {m.name}
            </text>
            {/* fanIn badge on the right */}
            {m.fanIn > 0 && (
              <text
                x={cx + rw / 2 - PAD_X}
                y={fy + 4}
                textAnchor="end"
                fontSize={7}
                fill="var(--tx-dim)"
                style={{ pointerEvents: 'none' }}>
                ↙{m.fanIn}
              </text>
            )}
          </g>
        );
      })}
    </g>
  );
}

// ============================================================================
// CLASS NODE (collapsed)
// ============================================================================

function ClassNode({ cls, cx, cy, selected, onToggle, onHover, onLeave }) {
  const color = langColor(cls.language);
  const isModule = cls.isModule;
  const r = (isModule ? MODULE_R : CLASS_R) + Math.min(cls.methodIds.length, 16) * 1.2;

  return (
    <g
      onClick={(e) => { e.stopPropagation(); onToggle(cls.id); }}
      onMouseEnter={(e) => onHover(e, cls)}
      onMouseLeave={onLeave}
      style={{ cursor: 'pointer' }}
    >
      {selected && (
        <circle cx={cx} cy={cy} r={r + 6}
          fill="none" stroke="var(--ac-primary)" strokeWidth={2} opacity={0.7} />
      )}
      {isModule
        ? /* Rounded-rect for module nodes */
          <rect
            x={cx - r} y={cy - r * 0.65}
            width={r * 2} height={r * 1.3}
            rx={6}
            fill={color}
            fillOpacity={0.06}
            stroke={color}
            strokeWidth={1.1}
            strokeDasharray="3 2"
            strokeOpacity={0.45}
          />
        : /* Circle for class nodes */
          <circle cx={cx} cy={cy} r={r}
            fill={color}
            fillOpacity={0.09}
            stroke={color}
            strokeWidth={1.5}
            strokeOpacity={0.5}
          />
      }
      {/* Name */}
      <text x={cx} y={cy - (isModule ? 2 : 5)}
        textAnchor="middle" fontSize={isModule ? 8.5 : 10}
        fill="var(--tx-primary)" fontWeight="600"
        style={{ fontFamily: 'monospace', pointerEvents: 'none' }}>
        {cls.name.length > 16 ? cls.name.slice(0, 15) + '…' : cls.name}
      </text>
      {/* Stats */}
      <text x={cx} y={cy + (isModule ? 9 : 8)}
        textAnchor="middle" fontSize={7.5}
        fill="var(--tx-muted)"
        style={{ pointerEvents: 'none' }}>
        {cls.methodIds.length} fn · ↙{cls.fanIn}
      </text>
      {/* Language */}
      <text x={cx} y={cy + (isModule ? 20 : 21)}
        textAnchor="middle" fontSize={6.5}
        fill={color} opacity={0.85}
        style={{ pointerEvents: 'none' }}>
        {cls.language}
      </text>
    </g>
  );
}

// ============================================================================
// TOOLTIP
// ============================================================================

function Tooltip({ tip }) {
  if (!tip) return null;
  const { x, y, lines } = tip;
  return (
    <div style={{
      position: 'fixed',
      left: x + 14,
      top: y - 10,
      background: 'var(--bg-raised)',
      border: '1px solid var(--bd-muted)',
      borderRadius: 6,
      padding: '6px 10px',
      fontSize: 11,
      color: 'var(--tx-primary)',
      pointerEvents: 'none',
      zIndex: 999,
      maxWidth: 320,
      boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
      lineHeight: 1.6,
      fontFamily: 'monospace',
    }}>
      {lines.map((l, i) => (
        <div key={i} style={{ color: l.dim ? 'var(--tx-muted)' : 'var(--tx-primary)', fontSize: l.small ? 10 : 11 }}>
          {l.text}
        </div>
      ))}
    </div>
  );
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export function ClassGraph({ classData, onSelectClass, selectedClassId, focusedPaths = [], onClear }) {
  const { classes: serverClasses = [], inheritanceEdges = [], edges: callEdges = [], nodes: fnNodes = [] } = classData ?? {};

  const [expanded, setExpanded] = useState(new Set());
  const [tooltip, setTooltip] = useState(null);
  const [hoveredEdge, setHoveredEdge] = useState(null);

  const focusedPathSet = useMemo(() => new Set(focusedPaths), [focusedPaths]);

  const { transform, onMouseDown, onMouseMove, onMouseUp, onWheel, onMouseLeave, onDblClick, reset } =
    usePanZoom();

  const fnMap = useMemo(() => {
    const m = new Map();
    for (const n of fnNodes) m.set(n.id, n);
    return m;
  }, [fnNodes]);

  // IDs already covered by server-provided class nodes
  const coveredIds = useMemo(() => {
    const s = new Set();
    for (const cls of serverClasses)
      for (const mid of cls.methodIds) s.add(mid);
    return s;
  }, [serverClasses]);

  // Synthetic module nodes — group uncovered fnNodes by filePath
  const moduleNodes = useMemo(() => {
    const groups = new Map(); // filePath → { methods: FunctionNode[] }
    for (const fn of fnNodes) {
      if (coveredIds.has(fn.id)) continue;
      if (!groups.has(fn.filePath))
        groups.set(fn.filePath, { methods: [] });
      groups.get(fn.filePath).methods.push(fn);
    }
    return Array.from(groups.entries()).map(([fp, g]) => {
      const base = fp.split('/').pop() ?? fp;
      const name = '[' + base.replace(/\.[^.]+$/, '') + ']';
      return {
        id: fp,
        name,
        filePath: fp,
        language: g.methods[0]?.language ?? 'TypeScript',
        parentClasses: [],
        interfaces: [],
        methodIds: g.methods.map(m => m.id),
        fanIn:  g.methods.reduce((s, m) => s + (m.fanIn  ?? 0), 0),
        fanOut: g.methods.reduce((s, m) => s + (m.fanOut ?? 0), 0),
        isModule: true,
      };
    });
  }, [fnNodes, coveredIds]);

  // All nodes used for layout + rendering
  const allClasses = useMemo(() => [...serverClasses, ...moduleNodes], [serverClasses, moduleNodes]);

  const classCallEdges = useMemo(() => {
    // Full methodToClass: server classes + synthetic modules
    const methodToClass = new Map();
    for (const cls of allClasses) {
      for (const mid of cls.methodIds) methodToClass.set(mid, cls.id);
    }
    const counts = new Map();
    const samples = new Map();
    for (const e of callEdges) {
      const src = methodToClass.get(e.callerId);
      const tgt = methodToClass.get(e.calleeId);
      if (!src || !tgt || src === tgt) continue;
      const key = `${src}|||${tgt}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (!samples.has(key)) samples.set(key, []);
      if (samples.get(key).length < 3) {
        const callerFn = fnMap.get(e.callerId);
        const calleeFn = fnMap.get(e.calleeId);
        if (callerFn && calleeFn) samples.get(key).push(`${callerFn.name} → ${calleeFn.name}`);
      }
    }
    return Array.from(counts.entries()).map(([key, count]) => {
      const [source, target] = key.split('|||');
      return { source, target, count, kind: 'call', samples: samples.get(key) ?? [] };
    });
  }, [allClasses, callEdges, fnMap]);

  const layoutEdges = useMemo(() => [
    ...inheritanceEdges.map(e => ({ source: e.childId, target: e.parentId, kind: e.kind })),
    ...classCallEdges,
  ], [inheritanceEdges, classCallEdges]);

  // Only include nodes that participate in at least one edge — isolated nodes
  // flood the canvas and hit the clamping boundary when there are many of them.
  const { connectedClasses, isolatedCount } = useMemo(() => {
    const connected = new Set();
    for (const e of layoutEdges) { connected.add(e.source); connected.add(e.target); }
    const filtered = allClasses.filter(c => connected.has(c.id));
    // Fall back to all nodes if nothing has cross-class edges (avoids blank canvas)
    const connectedClasses = filtered.length > 0 ? filtered : allClasses;
    return { connectedClasses, isolatedCount: allClasses.length - connectedClasses.length };
  }, [allClasses, layoutEdges]);

  const classKey = connectedClasses.map(c => c.id).join('|');
  const edgeCount = layoutEdges.length;

  const compIndexMap = useMemo(() => {
    const map = new Map();
    connectedComponents(connectedClasses, layoutEdges).forEach((comp, ci) => {
      comp.forEach(n => map.set(n.id, ci));
    });
    return map;
  }, [classKey, edgeCount]);

  const pos = useMemo(
    () => forceLayout(connectedClasses, layoutEdges),
    [classKey, edgeCount],
  );

  const showTip = useCallback((e, lines) => {
    setTooltip({ x: e.clientX, y: e.clientY, lines });
  }, []);
  const hideTip = useCallback(() => setTooltip(null), []);

  const handleClassHover = useCallback((e, cls) => {
    const lines = [
      { text: cls.name },
      { text: cls.filePath.split('/').slice(-2).join('/'), dim: true, small: true },
      { text: `${cls.methodIds.length} functions · fanIn ${cls.fanIn} · fanOut ${cls.fanOut}`, dim: true, small: true },
    ];
    if (cls.parentClasses?.length) lines.push({ text: `extends: ${cls.parentClasses.join(', ')}`, dim: true, small: true });
    if (cls.interfaces?.length) lines.push({ text: `implements: ${cls.interfaces.join(', ')}`, dim: true, small: true });
    showTip(e, lines);
  }, [showTip]);

  const handleMethodHover = useCallback((e, fn) => {
    showTip(e, [
      { text: fn.name },
      { text: fn.filePath.split('/').slice(-2).join('/'), dim: true, small: true },
      { text: `fanIn ${fn.fanIn} · fanOut ${fn.fanOut}${fn.isAsync ? ' · async' : ''}`, dim: true, small: true },
    ]);
  }, [showTip]);

  const handleEdgeHover = useCallback((e, edge) => {
    const srcCls = allClasses.find(c => c.id === edge.source);
    const tgtCls = allClasses.find(c => c.id === edge.target);
    const lines = [
      { text: `${srcCls?.name ?? '?'} → ${tgtCls?.name ?? '?'}` },
      { text: `${edge.count} cross-boundary call${edge.count > 1 ? 's' : ''}`, dim: true, small: true },
      ...edge.samples.map(s => ({ text: s, dim: true, small: true })),
    ];
    showTip(e, lines);
    setHoveredEdge(`${edge.source}|||${edge.target}`);
  }, [allClasses, showTip]);

  function toggleExpand(id) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  if (!allClasses.length) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100%', color: 'var(--tx-muted)', fontSize: 13 }}>
        No class data — run <code style={{ margin: '0 6px' }}>openlore analyze</code> to generate the call graph.
      </div>
    );
  }

  const classCount  = serverClasses.length;
  const moduleCount = moduleNodes.length;
  const allLangsSame = new Set(allClasses.map(c => c.language)).size <= 1;

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      {/* Stats bar */}
      <div style={{
        position: 'absolute', top: 8, right: 12, zIndex: 2,
        fontSize: 9, color: 'var(--tx-muted)',
        display: 'flex', gap: 14, pointerEvents: 'none',
      }}>
        {classCount > 0 && <span>{classCount} classes</span>}
        <span>{moduleCount} modules</span>
        {inheritanceEdges.length > 0 && <span>{inheritanceEdges.length} inheritance</span>}
        <span>{classCallEdges.length} cross-module calls</span>
        {isolatedCount > 0 && <span style={{ color: 'var(--tx-dim)' }}>{isolatedCount} isolated hidden</span>}
        <span style={{ color: 'var(--tx-dim)' }}>hover for details · click to expand</span>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%" height="100%"
        style={{ background: 'var(--bg-base)', display: 'block' }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onWheel={onWheel}
        onMouseLeave={(e) => { onMouseLeave(e); hideTip(); setHoveredEdge(null); }}
        onDoubleClick={onDblClick}
        onClick={() => onSelectClass?.(null)}
      >
        <Defs />

        {/* ── View / Clear buttons ────────────────────────────────────────── */}
        <foreignObject x="8" y="8" width="52" height="44" style={{ pointerEvents: 'all' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <button
              onClick={reset}
              title="Reset pan/zoom (or double-click background)"
              style={{
                fontSize: 8, padding: '2px 6px',
                background: 'var(--bg-input)',
                border: `1px solid ${transform.x !== 0 || transform.y !== 0 || transform.k !== 1 ? 'var(--ac-primary)' : 'var(--bd-muted)'}`,
                borderRadius: 4,
                color: transform.x !== 0 || transform.y !== 0 || transform.k !== 1 ? 'var(--ac-primary)' : 'var(--tx-faint)',
                cursor: 'pointer',
                fontFamily: "'JetBrains Mono',monospace",
                letterSpacing: '0.05em',
              }}
            >⌖ view</button>
            <button
              onClick={() => { setExpanded(new Set()); onSelectClass?.(null); onClear?.(); }}
              title="Clear expanded nodes and focus (Escape)"
              style={{
                fontSize: 8, padding: '2px 6px',
                background: 'var(--bg-input)',
                border: `1px solid ${expanded.size > 0 || focusedPaths.length > 0 ? 'var(--ac-primary)' : 'var(--bd-muted)'}`,
                borderRadius: 4,
                color: expanded.size > 0 || focusedPaths.length > 0 ? 'var(--ac-primary)' : 'var(--tx-faint)',
                cursor: expanded.size > 0 || focusedPaths.length > 0 ? 'pointer' : 'default',
                fontFamily: "'JetBrains Mono',monospace",
                letterSpacing: '0.05em',
              }}
            >x clear</button>
          </div>
        </foreignObject>

        <g transform={`translate(${transform.x},${transform.y}) scale(${transform.k})`}>

          {/* ── Call edges ─────────────────────────────────────────────────── */}
          {classCallEdges.map(e => {
            const sp = pos[e.source];
            const tp = pos[e.target];
            if (!sp || !tp) return null;
            const key = `${e.source}|||${e.target}`;
            const isHovered = hoveredEdge === key;
            const w = Math.min(0.7 + e.count * 0.25, 4);
            const d = curvePath(sp.x, sp.y, tp.x, tp.y, 0.15);
            const hasFocus = focusedPathSet.size > 0;
            const edgeFocused = hasFocus && (focusedPathSet.has(e.source) || focusedPathSet.has(e.target));
            const edgeOpacity = isHovered ? 0.9 : hasFocus ? (edgeFocused ? 0.6 : 0.06) : 0.45;
            return (
              <path key={`call-${key}`}
                d={d}
                fill="none"
                stroke="var(--tx-secondary)"
                strokeWidth={isHovered ? w + 1.5 : w}
                strokeDasharray="5 3"
                markerEnd="url(#cg-call)"
                opacity={edgeOpacity}
                onMouseEnter={(ev) => handleEdgeHover(ev, e)}
                onMouseLeave={() => { hideTip(); setHoveredEdge(null); }}
                style={{ cursor: 'pointer', transition: 'opacity 0.2s' }}
              />
            );
          })}

          {/* ── Inheritance edges ──────────────────────────────────────────── */}
          {inheritanceEdges.map(e => {
            const sp = pos[e.childId];
            const tp = pos[e.parentId];
            if (!sp || !tp) return null;
            const isImpl  = e.kind === 'implements';
            const isEmbed = e.kind === 'embeds';
            const markerId = isEmbed ? 'cg-embeds' : isImpl ? 'cg-impl' : 'cg-inherit';
            const stroke   = isImpl ? 'var(--lc-cyan)' : isEmbed ? 'var(--lc-green)' : 'var(--lc-purple)';
            const d = curvePath(sp.x, sp.y, tp.x, tp.y, 0.08);
            return (
              <path key={e.id}
                d={d}
                fill="none"
                stroke={stroke}
                strokeWidth={1.8}
                strokeDasharray={isImpl ? '6 3' : 'none'}
                markerEnd={`url(#${markerId})`}
                opacity={0.85}
              />
            );
          })}

          {/* ── Nodes ─────────────────────────────────────────────────────── */}
          {connectedClasses.map(cls => {
            const p = pos[cls.id];
            if (!p) return null;
            const isExpanded = expanded.has(cls.id);
            const methods = cls.methodIds.map(id => fnMap.get(id)).filter(Boolean);
            const compIdx = compIndexMap.get(cls.id) ?? 0;
            const color = allLangsSame ? componentColor(compIdx) : langColor(cls.language);
            const isFocused = focusedPathSet.has(cls.filePath);
            const hasFocus = focusedPathSet.size > 0;
            const isDimmed = hasFocus && !isFocused;

            return (
              <g key={cls.id} style={{ opacity: isDimmed ? 0.15 : 1, transition: 'opacity 0.2s' }}>
                {isExpanded
                  ? <>
                      <ExpandedClass
                        cls={cls} cx={p.x} cy={p.y}
                        methods={methods} color={color}
                        onMethodHover={handleMethodHover}
                        onMethodLeave={hideTip}
                      />
                      <g onClick={(ev) => { ev.stopPropagation(); toggleExpand(cls.id); }}
                        style={{ cursor: 'pointer' }}>
                        <circle cx={p.x} cy={p.y - 4} r={10}
                          fill="var(--bg-raised)" stroke={color} strokeWidth={1.2} />
                        <text x={p.x} y={p.y + 1} textAnchor="middle"
                          fontSize={10} fill={color} fontWeight="bold"
                          style={{ pointerEvents: 'none' }}>▲</text>
                      </g>
                    </>
                  : <>
                      {isFocused && (
                        <circle cx={p.x} cy={p.y}
                          r={(cls.isModule ? MODULE_R : CLASS_R) + Math.min(cls.methodIds.length, 16) * 1.2 + 10}
                          fill="none"
                          stroke="var(--ac-primary)"
                          strokeWidth={2.5}
                          opacity={0.8}
                          style={{ pointerEvents: 'none' }}
                        />
                      )}
                      <ClassNode
                        cls={cls} cx={p.x} cy={p.y}
                        selected={selectedClassId === cls.id}
                        onToggle={(id) => { toggleExpand(id); onSelectClass?.(cls); }}
                        onHover={handleClassHover}
                        onLeave={hideTip}
                      />
                    </>
                }
              </g>
            );
          })}
        </g>

        {/* ── Legend ─────────────────────────────────────────────────────── */}
        <g transform="translate(14,60)" fontSize={8}>
          <rect x={-2} y={-2} width={90} height={70} rx={4}
            fill="var(--bg-raised)" opacity={0.7} />
          <line x1={4} y1={8} x2={24} y2={8} stroke="var(--lc-purple)" strokeWidth={1.8}
            markerEnd="url(#cg-inherit)" />
          <text x={28} y={11} fill="var(--tx-secondary)">extends</text>

          <line x1={4} y1={22} x2={24} y2={22} stroke="var(--lc-cyan)" strokeWidth={1.2}
            strokeDasharray="5 3" markerEnd="url(#cg-impl)" />
          <text x={28} y={25} fill="var(--tx-secondary)">implements</text>

          <line x1={4} y1={36} x2={24} y2={36} stroke="var(--tx-secondary)" strokeWidth={1.2}
            strokeDasharray="5 3" markerEnd="url(#cg-call)" opacity={0.7} />
          <text x={28} y={39} fill="var(--tx-secondary)">calls</text>

          <circle cx={8} cy={52} r={5} fill="none" stroke="var(--tx-secondary)" strokeWidth={1.5} />
          <text x={16} y={55} fill="var(--tx-secondary)">class</text>
          <rect x={42} y={48} width={10} height={7} rx={2} fill="none"
            stroke="var(--tx-secondary)" strokeWidth={1} strokeDasharray="2 1" />
          <text x={56} y={55} fill="var(--tx-secondary)">module</text>
        </g>
      </svg>

      <Tooltip tip={tooltip} />
    </div>
  );
}
