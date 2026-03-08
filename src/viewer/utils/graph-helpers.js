import { CLUSTER_PALETTE } from './constants.js';

export function parseSpecRequirements(mdText) {
  const reqs = {};
  if (!mdText) return reqs;
  const sections = mdText.split(/^#{3,4}\s+Requirement:\s*/m);
  for (let i = 1; i < sections.length; i++) {
    const lines = sections[i].split('\n');
    const rawTitle = lines[0].trim();
    if (!rawTitle) continue;
    const body = lines.slice(1).join('\n').trim();
    reqs[rawTitle] = { title: rawTitle, body };
  }
  return reqs;
}

export function buildMappingIndex(mappingJson) {
  const index = {};
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

export function normalizePath(p) {
  return (p || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

export function parseGraph(raw) {
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
    lines: n.file.lines,
    size: n.file.size,
    isEntry: n.isEntryPoint,
    isConfig: n.isConfig,
    isTest: n.isTest,
    score: n.importanceScore ?? 0,
    cluster: clusterByNode[n.id] || { name: '?', index: 0, id: 'unknown', color: '#555' },
    exports: n.exports || [],
    tags: n.tags || [],
    metrics: n.metrics || {},
    refactor: null,
  }));

  const edges = (raw.edges || []).map((e) => ({
    id: `${e.source}->${e.target}`,
    source: e.source,
    target: e.target,
    isType: e.isTypeOnly || false,
    importedNames: e.importedNames || [],
  }));

  const clusters = (raw.clusters || []).map((cl, ci) => ({
    id: cl.id,
    name: cl.name,
    files: cl.files,
    color: CLUSTER_PALETTE[ci % CLUSTER_PALETTE.length],
  }));

  return {
    nodes,
    edges,
    clusters,
    statistics: raw.statistics || {},
    rankings: raw.rankings || {},
  };
}

export function enrichGraphWithRefactors(graph, refReport) {
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

export function computeBlast(edges, nodeId) {
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

export function computeLayout(nodes, edges, W = 900, H = 540) {
  if (!nodes.length) return {};
  const pos = {};

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

  const k = 55;
  for (let iter = 0; iter < 80; iter++) {
    const disp = {};
    nodes.forEach((n) => {
      disp[n.id] = { x: 0, y: 0 };
    });

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

export function computeClusterLayout(clusters, W = 900, H = 540) {
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

export function inferClusterRole(entryCount, hubCount, fileCount) {
  if (entryCount > fileCount * 0.5) return 'entry_layer';
  if (hubCount > 0 && entryCount > 0) return 'orchestrator';
  if (hubCount > 0) return 'core_utilities';
  if (entryCount > 0) return 'api_layer';
  return 'internal';
}

export function computeArchOverview(graph, llmCtx) {
  if (!graph) return null;

  const hubFiles = new Set((llmCtx?.callGraph?.hubFunctions ?? []).map(h => h.filePath));
  const entryFiles = new Set((llmCtx?.callGraph?.entryPoints ?? []).map(e => e.filePath));

  const clusterOfNode = {};
  (graph.nodes ?? []).forEach(n => {
    if (n.cluster?.id) clusterOfNode[n.id] = n.cluster.id;
    const rel = n.path?.replace(/^\/+/, '') ?? '';
    if (rel && n.cluster?.id) clusterOfNode[rel] = n.cluster.id;
  });

  const clusterEdges = {};
  (graph.edges ?? []).forEach(e => {
    const from = clusterOfNode[e.source];
    const to = clusterOfNode[e.target];
    if (from && to && from !== to) {
      if (!clusterEdges[from]) clusterEdges[from] = new Set();
      clusterEdges[from].add(to);
    }
  });

  const clusters = (graph.clusters ?? []).map(cl => {
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
