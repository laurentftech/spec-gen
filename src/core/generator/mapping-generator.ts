/**
 * Mapping Generator
 *
 * Builds a requirement→function mapping artifact from pipeline results and
 * the dependency graph. Written to .spec-gen/analysis/mapping.json.
 *
 * Enables refactoring workflows: dead code detection, naming normalization.
 */

import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PipelineResult } from './spec-pipeline.js';
import type { DependencyGraphResult } from '../analyzer/dependency-graph.js';

// ============================================================================
// TYPES
// ============================================================================

export interface FunctionRef {
  name: string;
  file: string;    // relative path
  line: number;
  kind: string;
  confidence: 'llm' | 'heuristic';
}

export interface RequirementMapping {
  requirement: string;   // operation.name
  service: string;       // service.name
  domain: string;        // service.domain
  specFile: string;      // openspec/specs/{domain}/spec.md
  functions: FunctionRef[];
}

export interface MappingArtifact {
  generatedAt: string;
  mappings: RequirementMapping[];
  orphanFunctions: FunctionRef[];
  stats: {
    totalRequirements: number;
    mappedRequirements: number;
    totalExportedFunctions: number;
    orphanCount: number;
  };
}

// ============================================================================
// HELPERS
// ============================================================================

/** Normalize a name for fuzzy matching: lowercase, alphanumeric only */
function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Split camelCase/PascalCase into tokens for better matching */
function tokenize(name: string): string[] {
  return name
    .replace(/([A-Z])/g, ' $1')
    .toLowerCase()
    .split(/[\s_-]+/)
    .filter(Boolean);
}

/** Score similarity between an operation name and a function name */
function similarityScore(operationName: string, functionName: string): number {
  const opNorm = normalize(operationName);
  const fnNorm = normalize(functionName);

  // Exact normalized match
  if (opNorm === fnNorm) return 1.0;

  // Containment
  if (fnNorm.includes(opNorm) || opNorm.includes(fnNorm)) return 0.8;

  // Token overlap
  const opTokens = new Set(tokenize(operationName));
  const fnTokens = new Set(tokenize(functionName));
  const intersection = [...opTokens].filter(t => fnTokens.has(t)).length;
  const union = new Set([...opTokens, ...fnTokens]).size;
  if (union === 0) return 0;
  return (intersection / union) * 0.7;
}

// ============================================================================
// MAPPING GENERATOR
// ============================================================================

export class MappingGenerator {
  private rootPath: string;
  private openspecPath: string;

  constructor(rootPath: string, openspecPath = 'openspec') {
    this.rootPath = rootPath;
    this.openspecPath = openspecPath;
  }

  async generate(
    pipeline: PipelineResult,
    depGraph: DependencyGraphResult
  ): Promise<MappingArtifact> {
    // Build export index: name → list of FunctionRef (multiple files can export same name)
    const exportIndex = new Map<string, FunctionRef[]>();

    for (const node of depGraph.nodes) {
      const relPath = node.file.path;
      for (const exp of node.exports) {
        if (exp.isType) continue; // skip type-only exports

        const ref: FunctionRef = {
          name: exp.name,
          file: relPath,
          line: exp.line,
          kind: exp.kind,
          confidence: 'llm', // placeholder, overwritten below
        };

        const existing = exportIndex.get(exp.name) ?? [];
        existing.push(ref);
        exportIndex.set(exp.name, existing);
      }
    }

    const mappings: RequirementMapping[] = [];
    const mappedFunctionNames = new Set<string>(); // track name+file combos

    for (const service of pipeline.services) {
      const domain = service.domain || 'core';
      const specFile = `${this.openspecPath}/specs/${domain.toLowerCase()}/spec.md`;

      for (const op of service.operations) {
        const functions: FunctionRef[] = [];

        // 1. LLM-provided functionName — direct lookup
        if (op.functionName && op.functionName.trim()) {
          const refs = exportIndex.get(op.functionName.trim());
          if (refs && refs.length > 0) {
            for (const ref of refs) {
              functions.push({ ...ref, confidence: 'llm' });
              mappedFunctionNames.add(`${ref.name}::${ref.file}`);
            }
          }
        }

        // 2. Heuristic fallback — find best matching export(s)
        if (functions.length === 0) {
          const scored: Array<{ ref: FunctionRef; score: number }> = [];
          for (const [name, refs] of exportIndex) {
            const score = similarityScore(op.name, name);
            if (score >= 0.7) {
              for (const ref of refs) {
                scored.push({ ref, score });
              }
            }
          }
          scored.sort((a, b) => b.score - a.score);
          const top = scored.slice(0, 2); // at most 2 heuristic matches
          for (const { ref } of top) {
            functions.push({ ...ref, confidence: 'heuristic' });
            mappedFunctionNames.add(`${ref.name}::${ref.file}`);
          }
        }

        mappings.push({
          requirement: op.name,
          service: service.name,
          domain,
          specFile,
          functions,
        });
      }
    }

    // Orphan functions: exported, non-type, not referenced in any mapping
    const orphanFunctions: FunctionRef[] = [];
    for (const [name, refs] of exportIndex) {
      for (const ref of refs) {
        if (!mappedFunctionNames.has(`${name}::${ref.file}`)) {
          orphanFunctions.push({ ...ref, confidence: 'heuristic' });
        }
      }
    }

    const artifact: MappingArtifact = {
      generatedAt: new Date().toISOString(),
      mappings,
      orphanFunctions,
      stats: {
        totalRequirements: mappings.length,
        mappedRequirements: mappings.filter(m => m.functions.length > 0).length,
        totalExportedFunctions: [...exportIndex.values()].reduce((s, refs) => s + refs.length, 0),
        orphanCount: orphanFunctions.length,
      },
    };

    await this.write(artifact);
    return artifact;
  }

  private async write(artifact: MappingArtifact): Promise<void> {
    const outPath = join(this.rootPath, '.spec-gen', 'analysis', 'mapping.json');
    await writeFile(outPath, JSON.stringify(artifact, null, 2), 'utf-8');
  }

  /** Load an existing mapping artifact */
  static async load(rootPath: string): Promise<MappingArtifact | null> {
    try {
      const content = await readFile(
        join(rootPath, '.spec-gen', 'analysis', 'mapping.json'),
        'utf-8'
      );
      return JSON.parse(content) as MappingArtifact;
    } catch {
      return null;
    }
  }
}
