/**
 * spec-gen analyze — programmatic API
 *
 * Runs static analysis on the codebase (no LLM required).
 * No side effects (no process.exit, no console.log).
 */

import { join } from 'node:path';
import { access, stat, mkdir, writeFile } from 'node:fs/promises';
import { readSpecGenConfig } from '../core/services/config-manager.js';
import { RepositoryMapper } from '../core/analyzer/repository-mapper.js';
import { DependencyGraphBuilder } from '../core/analyzer/dependency-graph.js';
import { AnalysisArtifactGenerator } from '../core/analyzer/artifact-generator.js';
import type { AnalyzeApiOptions, AnalyzeResult, ProgressCallback } from './types.js';

function progress(onProgress: ProgressCallback | undefined, step: string, status: 'start' | 'progress' | 'complete' | 'skip', detail?: string): void {
  onProgress?.({ phase: 'analyze', step, status, detail });
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run static analysis on the codebase.
 *
 * Scans the repository, builds a dependency graph, and generates
 * analysis artifacts. No LLM involvement.
 *
 * @throws Error if no spec-gen configuration found
 */
export async function specGenAnalyze(options: AnalyzeApiOptions = {}): Promise<AnalyzeResult> {
  const startTime = Date.now();
  const rootPath = options.rootPath ?? process.cwd();
  const maxFiles = options.maxFiles ?? 500;
  const excludePatterns = options.excludePatterns ?? [];
  const force = options.force ?? false;
  const outputRelPath = options.outputPath ?? '.spec-gen/analysis/';
  const outputPath = join(rootPath, outputRelPath);
  const { onProgress } = options;

  // Validate config exists
  const specGenConfig = await readSpecGenConfig(rootPath);
  if (!specGenConfig) {
    throw new Error('No spec-gen configuration found. Run specGenInit() first.');
  }

  // Check for existing recent analysis
  if (!force) {
    const repoStructurePath = join(outputPath, 'repo-structure.json');
    if (await fileExists(repoStructurePath)) {
      const stats = await stat(repoStructurePath);
      const age = Date.now() - stats.mtime.getTime();
      const oneHour = 60 * 60 * 1000;
      if (age < oneHour) {
        progress(onProgress, 'Recent analysis exists', 'skip', `${Math.floor(age / 60000)} minutes old`);
        // Load and return existing analysis
        const { readFile } = await import('node:fs/promises');
        const repoStructureContent = await readFile(repoStructurePath, 'utf-8');
        const repoStructure = JSON.parse(repoStructureContent);

        const depGraphPath = join(outputPath, 'dependency-graph.json');
        let depGraph;
        if (await fileExists(depGraphPath)) {
          const depGraphContent = await readFile(depGraphPath, 'utf-8');
          depGraph = JSON.parse(depGraphContent);
        }

        return {
          repoMap: repoStructure,
          depGraph: depGraph ?? { nodes: [], edges: [], statistics: { nodeCount: 0, edgeCount: 0, clusterCount: 0, cycleCount: 0, avgDegree: 0 } },
          artifacts: { repoStructure } as AnalyzeResult['artifacts'],
          duration: Date.now() - startTime,
        };
      }
    }
  }

  // Ensure output directory exists
  await mkdir(outputPath, { recursive: true });

  // Phase 1: Repository Mapping
  progress(onProgress, 'Scanning directory structure', 'start');
  const mapper = new RepositoryMapper(rootPath, {
    maxFiles,
    excludePatterns: excludePatterns.length > 0 ? excludePatterns : undefined,
  });
  const repoMap = await mapper.map();
  progress(onProgress, 'Scanning directory structure', 'complete', `${repoMap.summary.analyzedFiles} files`);

  // Phase 2: Dependency Graph
  progress(onProgress, 'Building dependency graph', 'start');
  const graphBuilder = new DependencyGraphBuilder({ rootDir: rootPath });
  const depGraph = await graphBuilder.build(repoMap.allFiles);
  progress(onProgress, 'Building dependency graph', 'complete', `${depGraph.statistics.nodeCount} nodes, ${depGraph.statistics.edgeCount} edges`);

  // Phase 3: Generate Artifacts
  progress(onProgress, 'Generating analysis artifacts', 'start');
  const artifactGenerator = new AnalysisArtifactGenerator({
    rootDir: rootPath,
    outputDir: outputPath,
    maxDeepAnalysisFiles: Math.min(20, Math.ceil(repoMap.highValueFiles.length * 0.3)),
    maxValidationFiles: 5,
  });
  const artifacts = await artifactGenerator.generateAndSave(repoMap, depGraph);

  // Save dependency graph
  await writeFile(
    join(outputPath, 'dependency-graph.json'),
    JSON.stringify(depGraph, null, 2)
  );
  progress(onProgress, 'Generating analysis artifacts', 'complete');

  const duration = Date.now() - startTime;
  return { repoMap, depGraph, artifacts, duration };
}
