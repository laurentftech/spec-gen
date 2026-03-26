/**
 * RAG Manifest Generator
 *
 * Produces openspec/rag-manifest.json — a lightweight index that maps each
 * spec domain to its source files and cross-domain dependency edges.  Used by
 * the orient MCP handler to inline condensed spec content without a separate
 * get_spec call.
 */

import type { DependencyGraphResult } from '../analyzer/dependency-graph.js';
import type { GeneratedSpec } from './openspec-format-generator.js';

// ============================================================================
// PUBLIC TYPES
// ============================================================================

export interface RagManifest {
  generatedAt: string;
  specVersion: string;
  domains: RagDomainEntry[];
}

export interface RagDomainEntry {
  /** Domain name, e.g. "analyzer" */
  domain: string;
  /** Relative path to the spec file, e.g. "openspec/specs/analyzer/spec.md" */
  specPath: string;
  /** Relative source file paths belonging to this domain's cluster */
  sourceFiles: string[];
  /** Number of Requirement blocks in the spec (populated post-generation) */
  requirementCount: number;
  /** Domains this domain calls into (outbound cross-cluster edges) */
  dependsOn: string[];
  /** Domains that call into this domain (inbound cross-cluster edges) */
  calledBy: string[];
}

// ============================================================================
// GENERATOR
// ============================================================================

export class RagManifestGenerator {
  /**
   * Build a RagManifest from the list of generated specs and the dependency
   * graph (optional — if absent, sourceFiles / dependsOn / calledBy are empty).
   */
  generate(specs: GeneratedSpec[], depGraph?: DependencyGraphResult): RagManifest {
    const domainSpecs = specs.filter(s => s.type === 'domain');

    // Build domain → cluster mapping from depGraph
    const clusterByDomain = new Map<
      string,
      { files: string[]; id: string }
    >();

    if (depGraph) {
      for (const cluster of depGraph.clusters) {
        const domainKey = cluster.suggestedDomain.toLowerCase();
        // Keep the first (or structural) cluster per domain
        if (!clusterByDomain.has(domainKey) || cluster.isStructural) {
          clusterByDomain.set(domainKey, {
            files: cluster.files,
            id: cluster.id,
          });
        }
      }
    }

    // Build file → cluster-id index for edge resolution
    const clusterIdByFile = new Map<string, string>();
    const clusterDomainById = new Map<string, string>();
    if (depGraph) {
      for (const [domain, cl] of clusterByDomain) {
        clusterDomainById.set(cl.id, domain);
        for (const f of cl.files) clusterIdByFile.set(f, cl.id);
      }
    }

    // Build a flat list of all cluster files for filename-based fallback
    const allClusterFiles: Array<{ file: string; domain: string }> = [];
    if (depGraph) {
      for (const [domain, cl] of clusterByDomain) {
        for (const f of cl.files) allClusterFiles.push({ file: f, domain });
      }
    }

    // For each domain spec, compute dependsOn / calledBy from dep graph edges
    const entries: RagDomainEntry[] = domainSpecs.map(spec => {
      const domainKey = spec.domain.toLowerCase();
      let cluster = clusterByDomain.get(domainKey);

      // Fallback: if no exact cluster match, collect files whose basename
      // contains the domain name (e.g. "openspec-*.ts" for domain "openspec")
      let sourceFiles: string[];
      if (cluster) {
        sourceFiles = cluster.files;
      } else if (depGraph) {
        sourceFiles = allClusterFiles
          .filter(({ file }) => {
            const basename = file.split('/').pop() ?? '';
            return basename.toLowerCase().includes(domainKey);
          })
          .map(({ file }) => file);
        // Synthesise a virtual cluster entry so edge resolution works below
        if (sourceFiles.length > 0) {
          const virtualId = `virtual:${domainKey}`;
          cluster = { files: sourceFiles, id: virtualId };
          clusterByDomain.set(domainKey, cluster);
          clusterDomainById.set(virtualId, domainKey);
          for (const f of sourceFiles) clusterIdByFile.set(f, virtualId);
        }
      } else {
        sourceFiles = [];
      }
      const clusterFileSet = new Set(cluster?.files ?? sourceFiles);

      const dependsOnDomains = new Set<string>();
      const calledByDomains = new Set<string>();

      if (depGraph && cluster) {
        for (const edge of depGraph.edges) {
          const srcInCluster = clusterFileSet.has(edge.source);
          const tgtInCluster = clusterFileSet.has(edge.target);

          if (srcInCluster && !tgtInCluster) {
            // This domain calls into the target's cluster
            const tgtClusterId = clusterIdByFile.get(edge.target);
            const tgtDomain = tgtClusterId
              ? clusterDomainById.get(tgtClusterId)
              : undefined;
            if (tgtDomain && tgtDomain !== domainKey) {
              dependsOnDomains.add(tgtDomain);
            }
          } else if (!srcInCluster && tgtInCluster) {
            // Another domain calls into this cluster
            const srcClusterId = clusterIdByFile.get(edge.source);
            const srcDomain = srcClusterId
              ? clusterDomainById.get(srcClusterId)
              : undefined;
            if (srcDomain && srcDomain !== domainKey) {
              calledByDomains.add(srcDomain);
            }
          }
        }
      }

      return {
        domain: spec.domain,
        specPath: spec.path,
        sourceFiles,
        requirementCount: countRequirements(spec.content),
        dependsOn: [...dependsOnDomains].sort(),
        calledBy: [...calledByDomains].sort(),
      };
    });

    return {
      generatedAt: new Date().toISOString(),
      specVersion: '1.0.0',
      domains: entries.sort((a, b) => a.domain.localeCompare(b.domain)),
    };
  }
}

// ============================================================================
// HELPERS
// ============================================================================

/** Count `### Requirement:` headers in a spec's markdown content */
function countRequirements(content: string): number {
  const matches = content.match(/^### Requirement:/gm);
  return matches?.length ?? 0;
}
