/**
 * spec-gen analyze command
 *
 * Runs static analysis on the codebase without LLM involvement.
 * Outputs repository map, dependency graph, and file significance scores.
 */

import { Command } from 'commander';
import { access, stat, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../../utils/logger.js';
import type { AnalyzeOptions, SpecGenConfig } from '../../types/index.js';
import { readSpecGenConfig } from '../../core/services/config-manager.js';
import { RepositoryMapper, type RepositoryMap } from '../../core/analyzer/repository-mapper.js';
import type { CloneGroup, CloneInstance } from '../../core/analyzer/duplicate-detector.js';
import {
  DependencyGraphBuilder,
  type DependencyGraphResult,
} from '../../core/analyzer/dependency-graph.js';
import {
  AnalysisArtifactGenerator,
  type AnalysisArtifacts,
} from '../../core/analyzer/artifact-generator.js';
import {
  buildArchitectureOverview,
  writeArchitectureMd,
} from '../../core/analyzer/architecture-writer.js';

// ============================================================================
// TYPES
// ============================================================================

interface ExtendedAnalyzeOptions extends AnalyzeOptions {
  force?: boolean;
  embed?: boolean;
  reindexSpecs?: boolean;
}

interface AnalysisResult {
  repoMap: RepositoryMap;
  depGraph: DependencyGraphResult;
  artifacts: AnalysisArtifacts;
  duration: number;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Collect multiple values for repeatable options
 */
function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

/**
 * Check if a file exists
 */
async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Format time duration for display
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/**
 * Format age in human-readable form
 */
function formatAge(ms: number): string {
  if (ms < 60000) return 'just now';
  if (ms < 3600000) return `${Math.floor(ms / 60000)} minutes ago`;
  if (ms < 86400000) return `${Math.floor(ms / 3600000)} hours ago`;
  return `${Math.floor(ms / 86400000)} days ago`;
}

/**
 * Check if analysis exists and return its age
 */
async function getAnalysisAge(outputPath: string): Promise<number | null> {
  try {
    const repoStructurePath = join(outputPath, 'repo-structure.json');
    if (!(await fileExists(repoStructurePath))) {
      return null;
    }
    const stats = await stat(repoStructurePath);
    return Date.now() - stats.mtime.getTime();
  } catch {
    return null;
  }
}

// ============================================================================
// CORE ANALYSIS FUNCTION
// ============================================================================

/**
 * Run the complete analysis pipeline
 */
export async function runAnalysis(
  rootPath: string,
  outputPath: string,
  options: {
    maxFiles: number;
    include: string[];
    exclude: string[];
  }
): Promise<AnalysisResult> {
  const startTime = Date.now();

  // Merge config patterns with caller-supplied patterns so all entry points
  // (CLI, MCP, …) automatically respect the project configuration.
  const specGenConfig = await readSpecGenConfig(rootPath);
  const configExclude = specGenConfig?.analysis.excludePatterns ?? [];
  const configInclude = specGenConfig?.analysis.includePatterns ?? [];
  const mergedExclude = [...new Set([...configExclude, ...options.exclude])];
  const mergedInclude = [...new Set([...configInclude, ...options.include])];

  // Phase 1: Repository Mapping
  logger.analysis('Scanning directory structure...');

  const mapper = new RepositoryMapper(rootPath, {
    maxFiles: options.maxFiles,
    includePatterns: mergedInclude.length > 0 ? mergedInclude : undefined,
    excludePatterns: mergedExclude.length > 0 ? mergedExclude : undefined,
  });

  const repoMap = await mapper.map();

  logger.info('Files found', repoMap.summary.totalFiles);
  logger.info('Files analyzed', repoMap.summary.analyzedFiles);
  logger.info('Files skipped', repoMap.summary.skippedFiles);
  logger.blank();

  // Phase 2: Dependency Graph
  logger.analysis('Building dependency graph...');

  const graphBuilder = new DependencyGraphBuilder({
    rootDir: rootPath,
  });

  const depGraph = await graphBuilder.build(repoMap.allFiles);

  logger.info('Nodes', depGraph.statistics.nodeCount);
  logger.info('Edges', depGraph.statistics.edgeCount);
  logger.info('Clusters', depGraph.statistics.clusterCount);
  if (depGraph.statistics.cycleCount > 0) {
    logger.warning(`Circular dependencies: ${depGraph.statistics.cycleCount}`);
  }
  logger.blank();

  // Phase 3: Generate Artifacts
  logger.analysis('Generating analysis artifacts...');

  const artifactGenerator = new AnalysisArtifactGenerator({
    rootDir: rootPath,
    outputDir: outputPath,
    maxDeepAnalysisFiles: Math.min(20, Math.ceil(repoMap.highValueFiles.length * 0.3)),
    maxValidationFiles: 5,
  });

  const artifacts = await artifactGenerator.generateAndSave(repoMap, depGraph);

  // Also save the raw dependency graph
  await writeFile(
    join(outputPath, 'dependency-graph.json'),
    JSON.stringify(depGraph, null, 2)
  );

  const duration = Date.now() - startTime;

  return { repoMap, depGraph, artifacts, duration };
}

// ============================================================================
// COMMAND
// ============================================================================

export const analyzeCommand = new Command('analyze')
  .description('Run static analysis on the codebase (no LLM required)')
  .option(
    '--output <path>',
    'Directory to write analysis results',
    '.spec-gen/analysis/'
  )
  .option(
    '--max-files <n>',
    'Maximum number of files to analyze',
    '500'
  )
  .option(
    '--include <glob>',
    'Additional glob patterns to include (repeatable)',
    collect,
    []
  )
  .option(
    '--exclude <glob>',
    'Additional glob patterns to exclude (repeatable)',
    collect,
    []
  )
  .option(
    '--force',
    'Force re-analysis even if recent analysis exists',
    false
  )
  .option(
    '--embed',
    'Build a semantic vector index after analysis (requires EMBED_BASE_URL + EMBED_MODEL)',
    false
  )
  .option(
    '--reindex-specs',
    'Re-index OpenSpec specs into the vector index without re-running full analysis (requires EMBED_BASE_URL + EMBED_MODEL)',
    false
  )
  .addHelpText(
    'after',
    `
Examples:
  $ spec-gen analyze                 Analyze with defaults
  $ spec-gen analyze --max-files 1000
                                     Analyze more files
  $ spec-gen analyze --include "*.graphql" --include "*.prisma"
                                     Include additional file types
  $ spec-gen analyze --exclude "legacy/**"
                                     Exclude specific directories
  $ spec-gen analyze --output ./my-analysis
                                     Custom output location
  $ spec-gen analyze --force         Force re-analysis
  $ spec-gen analyze --embed         Also build semantic vector index (code + specs)
  $ spec-gen analyze --reindex-specs Re-index specs only (no full re-analysis)

Output files:
  .spec-gen/analysis/
  ├── repo-structure.json    Repository structure and metadata
  ├── dependency-graph.json  Import/export relationships
  ├── llm-context.json       Optimized context for LLM
  ├── dependencies.mermaid   Visual dependency diagram
  └── SUMMARY.md             Human-readable analysis summary

After analysis, run 'spec-gen generate' to create OpenSpec files.
`
  )
  .action(async (options: Partial<ExtendedAnalyzeOptions>) => {
    const startTime = Date.now();
    const rootPath = process.cwd();

    const opts: ExtendedAnalyzeOptions = {
      output: options.output ?? '.spec-gen/analysis/',
      maxFiles: typeof options.maxFiles === 'string'
        ? parseInt(options.maxFiles, 10)
        : options.maxFiles ?? 500,
      include: options.include ?? [],
      exclude: options.exclude ?? [],
      force: options.force ?? false,
      embed: options.embed ?? false,
      reindexSpecs: options.reindexSpecs ?? false,
      quiet: false,
      verbose: false,
      noColor: false,
      config: '.spec-gen/config.json',
    };

    try {
      // ========================================================================
      // PHASE 1: VALIDATION
      // ========================================================================
      logger.section('Analyzing Codebase');

      // Check for spec-gen config
      const specGenConfig = await readSpecGenConfig(rootPath);
      if (!specGenConfig) {
        logger.error('No spec-gen configuration found. Run "spec-gen init" first.');
        process.exitCode = 1;
        return;
      }

      logger.info('Project', specGenConfig.projectType);
      logger.info('Output', opts.output);
      logger.info('Max files', opts.maxFiles);
      if (opts.include.length > 0) {
        logger.info('Include patterns', opts.include.join(', '));
      }
      if (opts.exclude.length > 0) {
        logger.info('Exclude patterns', opts.exclude.join(', '));
      }
      logger.blank();

      // ========================================================================
      // PHASE 1b: --reindex-specs fast path (no full analysis)
      // ========================================================================
      if (opts.reindexSpecs) {
        const outputPath = join(rootPath, opts.output);
        await mkdir(outputPath, { recursive: true });
        await runSpecIndexing(rootPath, outputPath, specGenConfig);
        return;
      }

      // ========================================================================
      // PHASE 2: CHECK EXISTING ANALYSIS
      // ========================================================================
      const outputPath = join(rootPath, opts.output);
      const analysisAge = await getAnalysisAge(outputPath);

      if (analysisAge !== null && !opts.force) {
        // Analysis exists - check if recent (< 1 hour)
        const oneHour = 60 * 60 * 1000;
        if (analysisAge < oneHour) {
          logger.discovery(`Recent analysis exists (${formatAge(analysisAge)})`);
          logger.info('Tip', 'Use --force to re-analyze');
          logger.blank();

          // Show existing analysis stats
          try {
            const repoStructurePath = join(outputPath, 'repo-structure.json');
            const content = await import('node:fs/promises').then(fs =>
              fs.readFile(repoStructurePath, 'utf-8')
            );
            const repoStructure = JSON.parse(content);

            logger.success('Analysis Summary');
            logger.info('Files analyzed', repoStructure.statistics.analyzedFiles);
            logger.info('Domains detected', repoStructure.domains.map((d: { name: string }) => d.name).join(', ') || 'None');
            logger.info('Architecture', repoStructure.architecture.pattern);
            logger.blank();
            logger.info('Next step', "Run 'spec-gen generate' to create OpenSpec files");
            return;
          } catch {
            // Continue with fresh analysis if we can't read existing
          }
        } else {
          logger.discovery(`Existing analysis is ${formatAge(analysisAge)} old, re-analyzing...`);
          logger.blank();
        }
      }

      // ========================================================================
      // PHASE 3: RUN ANALYSIS
      // ========================================================================
      // Ensure output directory exists
      await mkdir(outputPath, { recursive: true });

      const result = await runAnalysis(rootPath, outputPath, {
        maxFiles: opts.maxFiles,
        include: opts.include,
        exclude: opts.exclude,
      });

      // ========================================================================
      // PHASE 4: DISPLAY RESULTS
      // ========================================================================
      logger.blank();
      logger.section('Analysis Complete');

      const { repoMap, depGraph, artifacts } = result;

      // Summary
      console.log('');
      console.log('  Repository Structure:');
      console.log(`    ├─ Files analyzed: ${repoMap.summary.analyzedFiles}`);
      console.log(`    ├─ High-value files: ${repoMap.highValueFiles.length}`);
      console.log(`    ├─ Languages: ${repoMap.summary.languages.slice(0, 3).map(l => l.language).join(', ')}`);
      console.log(`    └─ Architecture: ${artifacts.repoStructure.architecture.pattern}`);
      console.log('');

      console.log('  Dependency Graph:');
      console.log(`    ├─ Nodes: ${depGraph.statistics.nodeCount}`);
      console.log(`    ├─ Edges: ${depGraph.statistics.edgeCount}`);
      console.log(`    ├─ Clusters: ${depGraph.statistics.clusterCount}`);
      if (depGraph.statistics.cycleCount > 0) {
        console.log(`    ├─ ⚠ Circular dependencies: ${depGraph.statistics.cycleCount}`);
      }
      console.log(`    └─ Average degree: ${depGraph.statistics.avgDegree.toFixed(1)}`);
      console.log('');

      // Call Graph
      const cg = artifacts.llmContext.callGraph;
      if (cg && cg.stats?.totalNodes > 0) {
        console.log('  Call Graph (static analysis):');
        console.log(`    ├─ Functions: ${cg.stats.totalNodes}`);
        console.log(`    ├─ Internal calls: ${cg.stats.totalEdges}`);
        if (cg.hubFunctions?.length > 0) {
          const hubs = cg.hubFunctions.slice(0, 3).map(f => `${f.name}(fanIn=${f.fanIn})`).join(', ');
          console.log(`    ├─ Hub functions: ${hubs}`);
        }
        if (cg.layerViolations?.length > 0) {
          console.log(`    ├─ ⚠ Layer violations: ${cg.layerViolations.length}`);
        }
        console.log(`    └─ Entry points: ${cg.entryPoints?.length ?? 0}`);
        console.log('');
      }

      // Refactor priorities (read from disk if available)
      try {
        const { readFile: rf } = await import('node:fs/promises');
        const rp = JSON.parse(await rf(join(opts.output, 'refactor-priorities.json'), 'utf-8'));
        if (rp?.stats?.withIssues > 0) {
          const s = rp.stats;
          const badges = [
            s.unreachable   > 0 ? `${s.unreachable} unreachable`  : null,
            s.highFanIn     > 0 ? `${s.highFanIn} hub overload`   : null,
            s.highFanOut    > 0 ? `${s.highFanOut} god function`   : null,
            s.srpViolations > 0 ? `${s.srpViolations} SRP`        : null,
            s.cyclesDetected> 0 ? `${s.cyclesDetected} cycle`     : null,
            s.inCloneGroup  > 0 ? `${s.inCloneGroup} duplicate`   : null,
          ].filter(Boolean).join('  ·  ');

          const issueLabel: Record<string, string> = {
            unreachable:       'dead code',
            high_fan_in:       `hub   fanIn`,
            high_fan_out:      `god   fanOut`,
            multi_requirement: 'SRP',
            in_cycle:          'cycle',
            in_clone_group:    'clone',
          };

          console.log(`  Refactoring Candidates  (${s.withIssues}/${s.totalFunctions} functions):`);
          console.log(`    ${badges}`);
          console.log('');

          const top = (rp.priorities as Array<{ function: string; file: string; fanIn: number; fanOut: number; issues: string[]; requirements: string[] }>).slice(0, 7);
          if (top.length === 0) {
            console.log('    (no refactoring candidates)');
          } else {
            const maxNameLen = Math.max(...top.map(p => (p.function ?? '').length), 8);
            const maxFileLen = Math.max(...top.map(p => (p.file?.split('/').pop() ?? '').length), 8);

            for (const p of top) {
              const name  = (p.function ?? '').padEnd(maxNameLen);
              const file  = (p.file?.split('/').pop() ?? '').padEnd(maxFileLen);
              const main  = p.issues?.[0];
              const val   = main === 'high_fan_in'  ? `fanIn=${p.fanIn}`
                          : main === 'high_fan_out' ? `fanOut=${p.fanOut}`
                          : main === 'in_cycle'     ? `cycle`
                          : main === 'unreachable'  ? `unreachable`
                          : `${p.requirements?.length ?? 0} req`;
              const extra = (p.issues ?? []).slice(1).map(i => issueLabel[i] ?? i).join(', ');
              const reqs  = (p.requirements?.length ?? 0) > 0 ? `  [${p.requirements.slice(0,2).join(', ')}${p.requirements.length > 2 ? '…' : ''}]` : '';
              console.log(`    ${name}  ${file}  ${val.padEnd(12)}${extra ? '  +' + extra : ''}${reqs}`);
            }
          }

          if (rp.cycles?.length > 0) {
            console.log('');
            for (const c of rp.cycles as Array<{ size: number; participants: Array<{ function: string; file: string }> }>) {
              const names = c.participants.map(p => p.function).join(' ↔ ');
              console.log(`    ⚠ Cycle: ${names}`);
            }
          }

          console.log('');
          console.log(`    → ${opts.output}refactor-priorities.json`);
          console.log('');
        }
      } catch { /* refactor-priorities.json not yet generated */ }

      // Duplicate code detection
      try {
        const { readFile: rf } = await import('node:fs/promises');
        const dup = JSON.parse(await rf(join(opts.output, 'duplicates.json'), 'utf-8'));
        if (dup?.stats?.cloneGroupCount > 0) {
          const s = dup.stats;
          const severity = s.duplicationRatio >= 0.2 ? '⚠'
                           : s.duplicationRatio >= 0.1 ? 'ℹ'
                           : ' ';
          console.log(`  ${severity} Code Duplication  (${s.duplicatedFunctions}/${s.totalFunctions} functions):`);
          console.log(`    ├─ Ratio: ${(s.duplicationRatio * 100).toFixed(1)}%`);
          console.log(`    ├─ Clone groups: ${s.cloneGroupCount}`);
          
          // Show top clone types
          const typeCounts: Record<string, number> = { exact: 0, structural: 0, near: 0 };
          for (const group of dup.cloneGroups) {
            typeCounts[group.type]++;
          }
          const typeLabels = Object.entries(typeCounts)
            .filter(([_, count]) => count > 0)
            .map(([type, count]) => `${count} ${type}`)
            .join('  ·  ');
          
          console.log(`    └─ Types: ${typeLabels}`);
          
          // Show top 5 clone groups
          if (dup.cloneGroups.length > 0) {
            console.log('');
            console.log('  Top 5 Clone Groups:');
            const topGroups = dup.cloneGroups
              .sort((a: CloneGroup, b: CloneGroup) => b.instances.length - a.instances.length)
              .slice(0, 5);
            
            for (const group of topGroups) {
              const files = group.instances.map((i: CloneInstance) => {
                const fileParts = i.file.split('/');
                return `${fileParts[fileParts.length - 2]}/${fileParts[fileParts.length - 1]}:${i.functionName}`;
              }).join('  ');
              
              console.log(`    ${group.type.padEnd(10)} (${group.instances.length}x, ${group.lineCount} lines): ${files}`);
            }
          }
          
          console.log('');
          console.log(`    → ${opts.output}duplicates.json`);
          console.log('');
        }
      } catch { /* duplicates.json not yet generated */ }

      // Detected domains
      if (artifacts.repoStructure.domains.length > 0) {
        console.log('  Detected Domains:');
        for (let i = 0; i < Math.min(artifacts.repoStructure.domains.length, 6); i++) {
          const domain = artifacts.repoStructure.domains[i];
          const isLast = i === Math.min(artifacts.repoStructure.domains.length, 6) - 1;
          const prefix = isLast ? '└─' : '├─';
          console.log(`    ${prefix} ${domain.name} (${domain.files.length} files)`);
        }
        if (artifacts.repoStructure.domains.length > 6) {
          console.log(`       ... and ${artifacts.repoStructure.domains.length - 6} more`);
        }
        console.log('');
      }

      // Generate ARCHITECTURE.md from cached analysis (no LLM)
      let architectureMdWritten = false;
      try {
        const ctx = artifacts.llmContext ?? null;
        const overview = buildArchitectureOverview(depGraph, ctx, rootPath);
        await writeArchitectureMd(rootPath, overview);
        architectureMdWritten = true;
      } catch {
        // non-fatal — analysis still succeeded
      }

      // Files generated
      console.log('  Output Files:');
      console.log(`    ├─ ${opts.output}repo-structure.json`);
      console.log(`    ├─ ${opts.output}dependency-graph.json`);
      console.log(`    ├─ ${opts.output}llm-context.json`);
      console.log(`    ├─ ${opts.output}dependencies.mermaid`);
      if (architectureMdWritten) {
        console.log(`    ├─ ${opts.output}SUMMARY.md`);
        console.log('    └─ ARCHITECTURE.md');
      } else {
        console.log(`    └─ ${opts.output}SUMMARY.md`);
      }
      console.log('');

      // ========================================================================
      // PHASE 5 (optional): BUILD VECTOR INDEX
      // ========================================================================
      if (opts.embed) {
        console.log('  Building semantic vector index...');
        try {
          const { EmbeddingService } = await import('../../core/analyzer/embedding-service.js');
          const { VectorIndex } = await import('../../core/analyzer/vector-index.js');

          // Resolve embedding config: env vars take priority, then .spec-gen/config.json
          let embedSvc: InstanceType<typeof EmbeddingService>;
          try {
            embedSvc = EmbeddingService.fromEnv();
          } catch {
            const cfg = await readSpecGenConfig(rootPath);
            if (!cfg) throw new Error('No embedding config found. Set EMBED_BASE_URL and EMBED_MODEL, or add "embedding" to .spec-gen/config.json');
            const svcFromConfig = EmbeddingService.fromConfig(cfg);
            if (!svcFromConfig) throw new Error('No embedding config found. Set EMBED_BASE_URL and EMBED_MODEL, or add "embedding" to .spec-gen/config.json');
            embedSvc = svcFromConfig;
          }

          const cg = result.artifacts.llmContext.callGraph;
          const sigs = result.artifacts.llmContext.signatures ?? [];

          if (!cg || cg.nodes.length === 0) {
            console.log('    ⚠ No call graph data — function index skipped');
          } else {
            const hubIds = new Set(cg.hubFunctions.map(f => f.id));
            const entryIds = new Set(cg.entryPoints.map(f => f.id));

            await VectorIndex.build(outputPath, cg.nodes, sigs, hubIds, entryIds, embedSvc);
            console.log(`    ✓ Function index built (${cg.nodes.length} functions)`);
            console.log(`    → ${opts.output}vector-index/`);
          }

          // Also index specs if they exist
          await runSpecIndexing(rootPath, outputPath, specGenConfig);
        } catch (embedErr) {
          console.log(`    ✗ Vector index failed: ${(embedErr as Error).message}`);
        }
        console.log('');
      }

      // Duration
      const totalDuration = Date.now() - startTime;
      console.log(`  Total time: ${formatDuration(totalDuration)}`);
      console.log('');

      logger.success('Ready for generation!');
      logger.blank();
      logger.info('Next step', "Run 'spec-gen generate' to create OpenSpec files");

    } catch (error) {
      logger.error(`Analysis failed: ${(error as Error).message}`);
      if (process.env.DEBUG) {
        console.error(error);
      }
      process.exitCode = 1;
    }
  });

// ============================================================================
// SPEC INDEXING HELPER
// ============================================================================

/**
 * Index OpenSpec specs into the vector index.
 * Looks for specs in <rootPath>/openspec/specs/ (configured or default).
 * Non-fatal: prints a warning if no specs found or embedding fails.
 */
async function runSpecIndexing(
  rootPath: string,
  outputPath: string,
  specGenConfig: SpecGenConfig | null
): Promise<void> {
  const { existsSync } = await import('node:fs');
  const { join: pathJoin } = await import('node:path');
  const { EmbeddingService } = await import('../../core/analyzer/embedding-service.js');
  const { SpecVectorIndex } = await import('../../core/analyzer/spec-vector-index.js');
  const { readSpecGenConfig } = await import('../../core/services/config-manager.js');

  // Resolve embedding service
  let embedSvc: InstanceType<typeof EmbeddingService>;
  try {
    embedSvc = EmbeddingService.fromEnv();
  } catch {
    const cfg = specGenConfig ?? await readSpecGenConfig(rootPath);
    if (!cfg) return; // no embedding config — silently skip
    const svc = EmbeddingService.fromConfig(cfg);
    if (!svc) return;
    embedSvc = svc;
  }

  // Locate specs directory
  const specsDir = pathJoin(rootPath, 'openspec', 'specs');
  if (!existsSync(specsDir)) {
    console.log('    ℹ No openspec/specs/ directory found — spec index skipped');
    return;
  }

  const mappingJsonPath = pathJoin(outputPath, 'mapping.json');

  try {
    const { recordCount } = await SpecVectorIndex.build(outputPath, specsDir, embedSvc, mappingJsonPath);
    console.log(`    ✓ Spec index built (${recordCount} sections)`);
    console.log(`    → ${outputPath.replace(rootPath + '/', '')}vector-index/`);
  } catch (err) {
    console.log(`    ⚠ Spec index skipped: ${(err as Error).message}`);
  }
}
