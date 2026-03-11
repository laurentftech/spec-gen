import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { extColor } from './utils/constants.js';
import {
  parseSpecRequirements,
  buildMappingIndex,
  normalizePath,
  parseGraph,
  enrichGraphWithRefactors,
  computeBlast,
} from './utils/graph-helpers.js';
import { FlatGraph } from './components/FlatGraph.jsx';
import { ClusterGraph } from './components/ClusterGraph.jsx';
import { FilterBar } from './components/FilterBar.jsx';
import { ArchitectureView } from './components/ArchitectureView.jsx';
import { Hint, SL, Row, Chip, KindBadge } from './components/MicroComponents.jsx';
import { ChatPanel } from './components/ChatPanel.jsx';

export default function App({ graphUrl, mappingUrl = '/api/mapping', specUrl = '/api/spec' }) {
  const [graph, setGraph] = useState(null);
  const [llmCtx, setLlmCtx] = useState(null);
  const [refReport, setRefReport] = useState(null);
  const [mapping, setMapping] = useState(null);
  const [specReqs, setSpecReqs] = useState({});
  const [selectedId, setSelectedId] = useState(null);
  const [affectedIds, setAffectedIds] = useState([]);
  const [focusedIds, setFocusedIds] = useState([]);
  const [search, setSearch] = useState('');
  const [semanticResults, setSemanticResults] = useState([]);
  const [semanticAvailable, setSemanticAvailable] = useState(true);
  const semanticTimer = useRef(null);
  const [tab, setTab] = useState('node');
  const [skeletonData, setSkeletonData] = useState(null);
  const [skeletonLoading, setSkeletonLoading] = useState(false);
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
  const [chatOpen, setChatOpen] = useState(false);
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

        try {
          const ctxRes = await fetch('/api/llm-context');
          if (ctxRes.ok) setLlmCtx(await ctxRes.json());
        } catch { /* ignore */ }

        try {
          const refRes = await fetch('/api/refactor-priorities');
          if (refRes.ok) {
            const report = await refRes.json();
            setRefReport(report);
            setGraph((g) => (g ? enrichGraphWithRefactors(g, report) : g));
          }
        } catch { /* ignore */ }

        try {
          const mRes = await fetch('/api/mapping');
          if (mRes.ok) loadMapping(await mRes.text());
        } catch { /* ignore */ }
        try {
          const srRes = await fetch('/api/spec-requirements');
          if (srRes.ok) {
            const reqsJson = await srRes.json();
            setSpecReqs(reqsJson);
          } else {
            try {
              const sRes = await fetch('/api/spec');
              if (sRes.ok) loadSpec(await sRes.text());
            } catch { /* ignore */ }
          }
        } catch { /* ignore */ }
      } catch (e) {
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
      setSemanticResults([]);
      clearTimeout(semanticTimer.current);
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
    if (!semanticAvailable || q.trim().length < 3) return;
    clearTimeout(semanticTimer.current);
    semanticTimer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q.trim())}`);
        if (res.status === 404) { setSemanticAvailable(false); return; }
        if (!res.ok) return;
        setSemanticResults(await res.json());
      } catch { /* ignore */ }
    }, 400);
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

  const clearSelection = useCallback(() => {
    setSelectedId(null);
    setAffectedIds([]);
    setExpandedClusters(new Set());
    setSemanticResults([]);
    setSkeletonData(null);
  }, []);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') clearSelection(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [clearSelection]);

  // Auto-expand clusters when their nodes are highlighted by the chatbot
  useEffect(() => {
    if (!graph || focusedIds.length === 0) return;
    
    const clusterIdsToExpand = new Set();
    const validNodeIds = [];
    focusedIds.forEach((fid) => {
      const node = graph.nodes.find((n) => n.id === fid);
      if (node) {
        if (node.cluster?.id) clusterIdsToExpand.add(node.cluster.id);
        validNodeIds.push(fid);
      }
    });
    
    if (clusterIdsToExpand.size > 0) {
      setExpandedClusters((prev) => {
        const next = new Set(prev);
        clusterIdsToExpand.forEach((cid) => next.add(cid));
        return next;
      });
    }

    // Select the first highlighted node to show details and prominent highlight
    if (validNodeIds.length > 0) {
      const id = validNodeIds[0];
      setSelectedId(id);
      setAffectedIds(computeBlast(visibleEdges, id));
      setTab(mapping ? 'spec' : 'node');
    }
  }, [focusedIds, graph, visibleEdges, mapping, computeBlast]);

  const selectedNode = graph?.nodes.find((n) => n.id === selectedId);

  const selectedPath = selectedNode?.path ?? null;
  useEffect(() => {
    if (tab !== 'skeleton' || !selectedPath) { setSkeletonData(null); return; }
    setSkeletonLoading(true);
    fetch(`/api/skeleton?file=${encodeURIComponent(selectedPath)}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { setSkeletonData(d); setSkeletonLoading(false); })
      .catch(() => setSkeletonLoading(false));
  }, [tab, selectedPath]);

  const selectedEdges = useMemo(() => {
    if (!selectedId) return [];
    return visibleEdges.filter((e) => e.source === selectedId || e.target === selectedId);
  }, [selectedId, visibleEdges]);

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
  // Use structuralClusters (clusters with real internal edges) for all UI.
  // Compute from clusters if not present in the JSON (for backward compatibility).
  const structuralClusters = graph?.structuralClusters ??
    (graph?.clusters?.filter(c => c.internalEdges > 0) ?? []);
  const displayClusters = structuralClusters;
  const clusterNames = displayClusters.map((c) => c.name);

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
          ['clusters', stats.structuralClusterCount ?? displayClusters.length],
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
            placeholder="search name, path, export, tag..."
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
          {search && (
            <span
              onClick={() => handleSearch('')}
              style={{
                position: 'absolute',
                right: focusedIds.length > 0 ? 22 : 8,
                top: '50%',
                transform: 'translateY(-50%)',
                fontSize: 10,
                color: '#3a3f5c',
                cursor: 'pointer',
                lineHeight: 1,
              }}
            >
              x
            </span>
          )}
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
          {semanticResults.length > 0 && (
            <div
              style={{
                position: 'absolute',
                top: '100%',
                right: 0,
                marginTop: 4,
                width: 280,
                background: '#0d0f22',
                border: '1px solid #1a1f38',
                borderRadius: 5,
                zIndex: 100,
                boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
                overflow: 'hidden',
              }}
            >
              <div style={{ padding: '4px 8px', borderBottom: '1px solid #1a1f38', fontSize: 8, color: '#3a3f5c', fontFamily: 'inherit' }}>
                semantic matches
              </div>
              {semanticResults.map((r) => {
                const node = graph?.nodes.find((n) => n.path === r.filePath || n.path.endsWith(r.filePath) || r.filePath.endsWith(n.path));
                return (
                  <div
                    key={r.id}
                    onClick={() => { if (node) { handleSelect(node.id); setSemanticResults([]); setSearch(''); } }}
                    style={{
                      padding: '5px 8px',
                      cursor: node ? 'pointer' : 'default',
                      borderBottom: '1px solid #111428',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 2,
                      opacity: node ? 1 : 0.4,
                    }}
                    onMouseEnter={(e) => { if (node) e.currentTarget.style.background = '#131630'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: 9, color: '#c8cde8', fontFamily: "'JetBrains Mono',monospace" }}>{r.name}</span>
                      <span style={{ fontSize: 8, color: '#4a3f7a', fontFamily: 'inherit' }}>{(1 - r.score).toFixed(2)}</span>
                    </div>
                    <span style={{ fontSize: 8, color: '#3a3f5c', fontFamily: 'inherit', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {r.filePath.split('/').slice(-2).join('/')}
                    </span>
                  </div>
                );
              })}
            </div>
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
          {mapping ? '[x] MAP' : 'MAP'}
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
          {Object.keys(specReqs).length ? '[x] SPEC' : 'SPEC'}
        </button>
        <button
          onClick={() => setChatOpen((v) => !v)}
          style={{
            background: chatOpen ? '#1a1050' : 'none',
            border: `1px solid ${chatOpen ? '#7c6af7' : '#1a1f38'}`,
            borderRadius: 4,
            color: chatOpen ? '#7c6af7' : '#3a3f5c',
            fontSize: 8,
            padding: '3px 8px',
            cursor: 'pointer',
            fontFamily: 'inherit',
            letterSpacing: '0.06em',
          }}
          title="Toggle AI chat"
        >
          CHAT
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
            <ArchitectureView graph={graph} llmCtx={llmCtx} focusedIds={focusedIds} />
          ) : viewMode === 'clusters' ? (
            <ClusterGraph
              clusters={displayClusters.filter(
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
              onClear={clearSelection}
              hasSelection={selectedId !== null || expandedClusters.size > 0}
              selectedId={selectedId}
              affectedIds={affectedIds}
              linkedIds={linkedIds}
              focusedIds={focusedIds}
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
                ? 'CLICK CLUSTER -> EXPAND  ·  CLICK NODE -> INSPECT'
                : 'CLICK NODE -> INSPECT'}
            </div>
          )}
        </div>

        {/* Chat panel */}
        {chatOpen && (
          <ChatPanel
            onHighlight={(ids) => setFocusedIds(ids)}
            onClose={() => { setChatOpen(false); setFocusedIds([]); }}
          />
        )}

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
            {['node', 'links', 'blast', 'spec', 'skeleton', 'info'].map((t) => (
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
                  value={<Chip color={extColor(selectedNode.ext)}>{selectedNode.ext || '--'}</Chip>}
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
                const nodePath = normalizePath(selectedNode?.path || selectedId);
                const entries = [];
                for (const [k, list] of Object.entries(mapping)) {
                  if (nodePath.endsWith(k) || k.endsWith(nodePath) || nodePath === k) {
                    entries.push(...list);
                  }
                }
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
                                ? 'Requirement title mismatch -- spec section not found in the spec file.'
                                : <>Spec not loaded -- run <code style={{ color: '#7c6af7' }}>spec-gen view</code> or load <code style={{ color: '#7c6af7' }}>spec.md</code> manually.</>}
                            </div>
                          )}
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

            {/* SKELETON */}
            {tab === 'skeleton' && !selectedNode && (
              <Hint>Select a node to view its code skeleton.</Hint>
            )}
            {tab === 'skeleton' && selectedNode && (
              <div>
                {skeletonLoading && <Hint>Loading...</Hint>}
                {!skeletonLoading && !skeletonData && <Hint>Skeleton unavailable for this file.</Hint>}
                {!skeletonLoading && skeletonData && (
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <span style={{ fontSize: 9, color: '#6a70a0', fontFamily: 'inherit' }}>
                        {skeletonData.language} · {skeletonData.skeletonLines}/{skeletonData.originalLines} lines
                      </span>
                      <span style={{ fontSize: 9, color: skeletonData.reductionPct >= 20 ? '#7c6af7' : '#3a3f5c', fontFamily: 'inherit' }}>
                        -{skeletonData.reductionPct}%
                      </span>
                    </div>
                    <pre style={{
                      margin: 0,
                      fontSize: 8,
                      lineHeight: 1.6,
                      color: '#9aa0c8',
                      fontFamily: "'JetBrains Mono', monospace",
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      background: '#060819',
                      border: '1px solid #0f1224',
                      borderRadius: 4,
                      padding: '8px 10px',
                    }}>
                      {skeletonData.skeleton}
                    </pre>
                  </div>
                )}
              </div>
            )}

            {/* INFO */}
            {tab === 'info' && (
              <div>
                <SL>Statistics</SL>
                {[
                  ['Nodes', stats.nodeCount],
                  ['Edges', stats.edgeCount],
                  ['Clusters', stats.structuralClusterCount ?? displayClusters.length],
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
                      <span style={{ fontSize: 8, color: extColor(n.ext) }}>{n.ext || '--'}</span>
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

          {/* Cluster legend */}
          <div style={{ padding: '9px 13px', borderTop: '1px solid #0f1224', flexShrink: 0 }}>
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
              {displayClusters.map((cl) => (
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
