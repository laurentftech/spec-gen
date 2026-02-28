/**
 * spec-gen run — programmatic API
 *
 * Runs the full pipeline: init → analyze → generate.
 * Smart defaults skip unnecessary steps.
 * No side effects (no process.exit, no console.log).
 */

import { join } from 'node:path';
import { access, stat, readFile, mkdir, writeFile } from 'node:fs/promises';
import {
  detectProjectType,
  getProjectTypeName,
} from '../core/services/project-detector.js';
import {
  getDefaultConfig,
  readSpecGenConfig,
  writeSpecGenConfig,
  specGenConfigExists,
  openspecDirExists,
  createOpenSpecStructure,
} from '../core/services/config-manager.js';
import {
  gitignoreExists,
  isInGitignore,
  addToGitignore,
} from '../core/services/gitignore-manager.js';
import { createLLMService } from '../core/services/llm-service.js';
import type { LLMService } from '../core/services/llm-service.js';
import { RepositoryMapper } from '../core/analyzer/repository-mapper.js';
import { DependencyGraphBuilder } from '../core/analyzer/dependency-graph.js';
import { AnalysisArtifactGenerator } from '../core/analyzer/artifact-generator.js';
import type { RepoStructure, LLMContext } from '../core/analyzer/artifact-generator.js';
import { SpecGenerationPipeline } from '../core/generator/spec-pipeline.js';
import { OpenSpecFormatGenerator } from '../core/generator/openspec-format-generator.js';
import { OpenSpecWriter } from '../core/generator/openspec-writer.js';
import { ADRGenerator } from '../core/generator/adr-generator.js';
import type { RunApiOptions, RunResult, InitResult, AnalyzeResult, ProgressCallback } from './types.js';

function progress(onProgress: ProgressCallback | undefined, step: string, status: 'start' | 'progress' | 'complete' | 'skip', detail?: string): void {
  onProgress?.({ phase: 'run', step, status, detail });
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
 * Run the full spec-gen pipeline: init → analyze → generate.
 *
 * Uses smart defaults to skip unnecessary steps (e.g., skips init
 * if config exists, skips analysis if recent).
 *
 * @throws Error if no LLM API key found
 * @throws Error if pipeline fails
 */
export async function specGenRun(options: RunApiOptions = {}): Promise<RunResult> {
  const startTime = Date.now();
  const rootPath = options.rootPath ?? process.cwd();
  const force = options.force ?? false;
  const reanalyze = options.reanalyze ?? false;
  const maxFiles = options.maxFiles ?? 500;
  const adr = options.adr ?? false;
  const { onProgress } = options;

  // ========================================================================
  // STEP 1: INITIALIZATION
  // ========================================================================
  progress(onProgress, 'Initialization', 'start');

  const detection = await detectProjectType(rootPath);
  const projectType = getProjectTypeName(detection.projectType);

  let initResult: InitResult;
  const configExists = await specGenConfigExists(rootPath);
  let specGenConfig = configExists ? await readSpecGenConfig(rootPath) : null;

  if (configExists && !force) {
    initResult = {
      configPath: '.spec-gen/config.json',
      openspecPath: specGenConfig?.openspecPath ?? './openspec',
      projectType,
      created: false,
    };
    progress(onProgress, 'Initialization', 'skip', 'Config exists');
  } else {
    const openspecPath = './openspec';
    specGenConfig = getDefaultConfig(detection.projectType, openspecPath);
    await writeSpecGenConfig(rootPath, specGenConfig);

    const fullOpenspecPath = join(rootPath, openspecPath);
    if (!(await openspecDirExists(fullOpenspecPath))) {
      await createOpenSpecStructure(fullOpenspecPath);
    }

    const hasGitignore = await gitignoreExists(rootPath);
    if (hasGitignore) {
      const alreadyIgnored = await isInGitignore(rootPath, '.spec-gen/');
      if (!alreadyIgnored) {
        await addToGitignore(rootPath, '.spec-gen/', 'spec-gen analysis artifacts');
      }
    }

    initResult = {
      configPath: '.spec-gen/config.json',
      openspecPath: openspecPath,
      projectType,
      created: true,
    };
    progress(onProgress, 'Initialization', 'complete');
  }

  // Ensure we have config
  if (!specGenConfig) {
    specGenConfig = await readSpecGenConfig(rootPath);
    if (!specGenConfig) {
      throw new Error('Failed to load configuration');
    }
  }

  // ========================================================================
  // STEP 2: ANALYSIS
  // ========================================================================
  progress(onProgress, 'Analysis', 'start');

  const analysisPath = join(rootPath, '.spec-gen', 'analysis');
  let analyzeResult: AnalyzeResult;

  // Check for existing recent analysis
  const repoStructurePath = join(analysisPath, 'repo-structure.json');
  let useExisting = false;

  if (await fileExists(repoStructurePath)) {
    const stats = await stat(repoStructurePath);
    const age = Date.now() - stats.mtime.getTime();
    const oneHour = 60 * 60 * 1000;
    if (age < oneHour && !reanalyze && !force) {
      useExisting = true;
    }
  }

  if (useExisting) {
    const repoStructureContent = await readFile(repoStructurePath, 'utf-8');
    const repoStructure = JSON.parse(repoStructureContent);
    let depGraph;
    const depGraphPath = join(analysisPath, 'dependency-graph.json');
    if (await fileExists(depGraphPath)) {
      const content = await readFile(depGraphPath, 'utf-8');
      depGraph = JSON.parse(content);
    }

    analyzeResult = {
      repoMap: repoStructure,
      depGraph: depGraph ?? { nodes: [], edges: [], statistics: { nodeCount: 0, edgeCount: 0, clusterCount: 0, cycleCount: 0, avgDegree: 0 } },
      artifacts: { repoStructure } as AnalyzeResult['artifacts'],
      duration: 0,
    };
    progress(onProgress, 'Analysis', 'skip', 'Recent analysis exists');
  } else {
    await mkdir(analysisPath, { recursive: true });

    const mapper = new RepositoryMapper(rootPath, { maxFiles });
    const repoMap = await mapper.map();

    const graphBuilder = new DependencyGraphBuilder({ rootDir: rootPath });
    const depGraph = await graphBuilder.build(repoMap.allFiles);

    const artifactGenerator = new AnalysisArtifactGenerator({
      rootDir: rootPath,
      outputDir: analysisPath,
      maxDeepAnalysisFiles: Math.min(20, Math.ceil(repoMap.highValueFiles.length * 0.3)),
      maxValidationFiles: 5,
    });
    const artifacts = await artifactGenerator.generateAndSave(repoMap, depGraph);

    await writeFile(
      join(analysisPath, 'dependency-graph.json'),
      JSON.stringify(depGraph, null, 2)
    );

    analyzeResult = {
      repoMap,
      depGraph,
      artifacts,
      duration: Date.now() - startTime,
    };
    progress(onProgress, 'Analysis', 'complete', `${repoMap.summary.analyzedFiles} files`);
  }

  // ========================================================================
  // STEP 3: GENERATION
  // ========================================================================

  if (options.dryRun) {
    progress(onProgress, 'Generation', 'skip', 'Dry run');
    return {
      init: initResult,
      analysis: analyzeResult,
      generation: {
        report: {
          timestamp: new Date().toISOString(),
          openspecVersion: specGenConfig?.version ?? '1.0.0',
          specGenVersion: '1.0.0',
          filesWritten: [],
          filesSkipped: [],
          filesBackedUp: [],
          filesMerged: [],
          configUpdated: false,
          validationErrors: [],
          warnings: [],
          nextSteps: ['Run without --dry-run to generate specs'],
        },
        pipelineResult: {} as RunResult['generation']['pipelineResult'],
        duration: 0,
      },
      duration: Date.now() - startTime,
    };
  }

  progress(onProgress, 'Generation', 'start');

  // Check for API key
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!anthropicKey && !openaiKey) {
    throw new Error('No LLM API key found. Set ANTHROPIC_API_KEY or OPENAI_API_KEY.');
  }

  // Create LLM service
  const provider = options.provider ?? (anthropicKey ? 'anthropic' : 'openai');
  const model = options.model ?? 'claude-sonnet-4-20250514';
  let llm: LLMService;
  try {
    llm = createLLMService({
      provider,
      model,
      apiBase: options.apiBase ?? specGenConfig.llm?.apiBase,
      sslVerify: options.sslVerify ?? specGenConfig.llm?.sslVerify ?? true,
      openaiCompatBaseUrl: options.openaiCompatBaseUrl,
      enableLogging: true,
      logDir: join(rootPath, '.spec-gen', 'logs'),
    });
  } catch (error) {
    throw new Error(`Failed to create LLM service: ${(error as Error).message}`);
  }

  // Load analysis data for pipeline
  const llmContextPath = join(analysisPath, 'llm-context.json');
  let llmContext: LLMContext;
  if (await fileExists(llmContextPath)) {
    const content = await readFile(llmContextPath, 'utf-8');
    llmContext = JSON.parse(content) as LLMContext;
  } else {
    llmContext = {
      phase1_survey: { purpose: 'Initial survey', files: [], estimatedTokens: 0 },
      phase2_deep: { purpose: 'Deep analysis', files: [], totalTokens: 0 },
      phase3_validation: { purpose: 'Validation', files: [], totalTokens: 0 },
    };
  }

  const repoStructureContent = await readFile(repoStructurePath, 'utf-8');
  const repoStructure = JSON.parse(repoStructureContent) as RepoStructure;

  // Run pipeline
  const pipeline = new SpecGenerationPipeline(llm, {
    outputDir: join(rootPath, '.spec-gen', 'generation'),
    saveIntermediate: true,
    generateADRs: adr,
  });

  let pipelineResult;
  try {
    pipelineResult = await pipeline.run(repoStructure, llmContext, analyzeResult.depGraph);
  } catch (error) {
    await llm.saveLogs().catch(() => {});
    throw new Error(`Pipeline failed: ${(error as Error).message}`);
  }

  // Format and write specs
  const formatGenerator = new OpenSpecFormatGenerator({
    version: specGenConfig.version ?? '1.0.0',
    includeConfidence: true,
    includeTechnicalNotes: true,
  });

  const generatedSpecs = formatGenerator.generateSpecs(pipelineResult);

  if (adr && pipelineResult.adrs && pipelineResult.adrs.length > 0) {
    const adrGenerator = new ADRGenerator({
      version: specGenConfig.version ?? '1.0.0',
      includeMermaid: true,
    });
    const adrSpecs = adrGenerator.generateADRs(pipelineResult);
    generatedSpecs.push(...adrSpecs);
  }

  const writer = new OpenSpecWriter({
    rootPath,
    writeMode: 'replace',
    version: specGenConfig.version ?? '1.0.0',
    createBackups: true,
    updateConfig: true,
    validateBeforeWrite: true,
  });

  const report = await writer.writeSpecs(generatedSpecs, pipelineResult.survey);

  // Save LLM logs
  await llm.saveLogs().catch(() => {});

  progress(onProgress, 'Generation', 'complete', `${report.filesWritten.length} specs written`);

  // Save run metadata
  const duration = Date.now() - startTime;
  const runsDir = join(rootPath, '.spec-gen', 'runs');
  await mkdir(runsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  await writeFile(
    join(runsDir, `${timestamp}.json`),
    JSON.stringify({
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      duration,
      steps: {
        init: { status: initResult.created ? 'completed' : 'skipped' },
        analyze: { status: useExisting ? 'skipped' : 'completed' },
        generate: { status: 'completed', specsGenerated: report.filesWritten.length },
      },
      result: 'success',
    }, null, 2)
  );

  return {
    init: initResult,
    analysis: analyzeResult,
    generation: {
      report,
      pipelineResult,
      duration: Date.now() - startTime,
    },
    duration,
  };
}
