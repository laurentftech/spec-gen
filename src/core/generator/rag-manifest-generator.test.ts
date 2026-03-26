/**
 * RagManifestGenerator tests
 */

import { describe, it, expect } from 'vitest';
import { RagManifestGenerator } from './rag-manifest-generator.js';
import type { GeneratedSpec } from './openspec-format-generator.js';
import type { DependencyGraphResult } from '../analyzer/dependency-graph.js';

// ============================================================================
// HELPERS
// ============================================================================

function makeSpec(domain: string, content = ''): GeneratedSpec {
  return {
    path: `openspec/specs/${domain}/spec.md`,
    content: content || `# ${domain}\n### Requirement: Foo\n### Requirement: Bar\n`,
    domain,
    type: 'domain',
  };
}

function makeDepGraph(overrides: Partial<DependencyGraphResult> = {}): DependencyGraphResult {
  return {
    nodes: [],
    edges: [],
    clusters: [],
    structuralClusters: [],
    cycles: [],
    rankings: { byImportance: [], byConnectivity: [], clusterCenters: [], leafNodes: [], bridgeNodes: [], orphanNodes: [] },
    statistics: {
      nodeCount: 0, edgeCount: 0, httpEdgeCount: 0, importEdgeCount: 0,
      avgDegree: 0, density: 0, clusterCount: 0, structuralClusterCount: 0, cycleCount: 0,
    },
    ...overrides,
  };
}

// ============================================================================
// TESTS
// ============================================================================

describe('RagManifestGenerator', () => {
  it('generates manifest with correct generatedAt and specVersion', () => {
    const gen = new RagManifestGenerator();
    const manifest = gen.generate([makeSpec('analyzer')]);
    expect(manifest.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(manifest.specVersion).toBe('1.0.0');
  });

  it('only includes domain specs (not overview/architecture/adr)', () => {
    const gen = new RagManifestGenerator();
    const specs: GeneratedSpec[] = [
      { path: 'openspec/specs/overview/spec.md', content: '', domain: 'overview', type: 'overview' },
      makeSpec('analyzer'),
      { path: 'openspec/specs/architecture/spec.md', content: '', domain: 'architecture', type: 'architecture' },
    ];
    const manifest = gen.generate(specs);
    expect(manifest.domains).toHaveLength(1);
    expect(manifest.domains[0].domain).toBe('analyzer');
  });

  it('counts requirements correctly', () => {
    const gen = new RagManifestGenerator();
    const content = '### Requirement: Foo\n\nbody\n\n### Requirement: Bar\n\nbody\n';
    const manifest = gen.generate([makeSpec('auth', content)]);
    expect(manifest.domains[0].requirementCount).toBe(2);
  });

  it('returns 0 requirementCount when no requirements', () => {
    const gen = new RagManifestGenerator();
    const manifest = gen.generate([makeSpec('auth', '# Auth\n\nNo requirements here.\n')]);
    expect(manifest.domains[0].requirementCount).toBe(0);
  });

  it('sorts domains alphabetically', () => {
    const gen = new RagManifestGenerator();
    const specs = [makeSpec('types'), makeSpec('analyzer'), makeSpec('generator')];
    const manifest = gen.generate(specs);
    const names = manifest.domains.map(d => d.domain);
    expect(names).toEqual([...names].sort());
  });

  it('sourceFiles is empty when no depGraph', () => {
    const gen = new RagManifestGenerator();
    const manifest = gen.generate([makeSpec('analyzer')]);
    expect(manifest.domains[0].sourceFiles).toEqual([]);
  });

  it('sourceFiles comes from cluster matching domain', () => {
    const gen = new RagManifestGenerator();
    const depGraph = makeDepGraph({
      clusters: [
        {
          id: 'c1', name: 'analyzer', files: ['src/core/analyzer/call-graph.ts'],
          internalEdges: 1, cohesion: 0.5, isStructural: true,
          suggestedDomain: 'analyzer', color: '#000',
          externalEdges: 0, coupling: 0,
        },
      ],
    });
    const manifest = gen.generate([makeSpec('analyzer')], depGraph);
    expect(manifest.domains[0].sourceFiles).toContain('src/core/analyzer/call-graph.ts');
  });

  it('dependsOn and calledBy are populated from cross-cluster edges', () => {
    const gen = new RagManifestGenerator();
    const depGraph = makeDepGraph({
      clusters: [
        {
          id: 'c1', name: 'generator', files: ['src/generator/gen.ts'],
          internalEdges: 1, cohesion: 0.5, isStructural: true,
          suggestedDomain: 'generator', color: '#0f0',
          externalEdges: 1, coupling: 0.5,
        },
        {
          id: 'c2', name: 'analyzer', files: ['src/analyzer/dep.ts'],
          internalEdges: 1, cohesion: 0.5, isStructural: true,
          suggestedDomain: 'analyzer', color: '#f00',
          externalEdges: 1, coupling: 0.5,
        },
      ],
      edges: [
        {
          source: 'src/generator/gen.ts',
          target: 'src/analyzer/dep.ts',
          importedNames: ['DependencyGraphResult'],
          isTypeOnly: false,
          weight: 1,
        },
      ],
    });
    const manifest = gen.generate([makeSpec('generator'), makeSpec('analyzer')], depGraph);

    const genEntry = manifest.domains.find(d => d.domain === 'generator')!;
    const analyzerEntry = manifest.domains.find(d => d.domain === 'analyzer')!;

    expect(genEntry.dependsOn).toContain('analyzer');
    expect(genEntry.calledBy).toEqual([]);
    expect(analyzerEntry.calledBy).toContain('generator');
    expect(analyzerEntry.dependsOn).toEqual([]);
  });

  it('does not add self-edges in dependsOn / calledBy', () => {
    const gen = new RagManifestGenerator();
    const depGraph = makeDepGraph({
      clusters: [
        {
          id: 'c1', name: 'analyzer', files: ['src/analyzer/a.ts', 'src/analyzer/b.ts'],
          internalEdges: 1, cohesion: 1, isStructural: true,
          suggestedDomain: 'analyzer', color: '#000',
          externalEdges: 0, coupling: 0,
        },
      ],
      edges: [
        {
          source: 'src/analyzer/a.ts',
          target: 'src/analyzer/b.ts',
          importedNames: [],
          isTypeOnly: false,
          weight: 1,
        },
      ],
    });
    const manifest = gen.generate([makeSpec('analyzer')], depGraph);
    expect(manifest.domains[0].dependsOn).toEqual([]);
    expect(manifest.domains[0].calledBy).toEqual([]);
  });
});
