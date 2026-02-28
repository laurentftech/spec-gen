/**
 * spec-gen generate — programmatic API
 *
 * Generates OpenSpec specification files from analysis results using LLM.
 * No side effects (no process.exit, no console.log).
 */

import { join } from 'node:path';
import { access, readFile } from 'node:fs/promises';
import {
  readSpecGenConfig,
  readOpenSpecConfig,
} from '../core/services/config-manager.js';
import { createLLMService } from '../core/services/llm-service.js';
import type { LLMService } from '../core/services/llm-service.js';
import { SpecGenerationPipeline } from '../core/generator/spec-pipeline.js';
import { OpenSpecFormatGenerator } from '../core/generator/openspec-format-generator.js';
import { OpenSpecWriter, type WriteMode } from '../core/generator/openspec-writer.js';
import { ADRGenerator } from '../core/generator/adr-generator.js';
import { MappingGenerator } from '../core/generator/mapping-generator.js';
import type { RepoStructure, LLMContext } from '../core/analyzer/artifact-generator.js';
import type { DependencyGraphResult } from '../core/analyzer/dependency-graph.js';
import type { GenerateApiOptions, GenerateResult, ProgressCallback } from './types.js';

function progress(onProgress: ProgressCallback | undefined, step: string, status: 'start' | 'progress' | 'complete' | 'skip', detail?: string): void {
  onProgress?.({ phase: 'generate', step, status, detail });
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

interface AnalysisData {
  repoStructure: RepoStructure;
  llmContext: LLMContext;
  depGraph?: DependencyGraphResult;
}

async function loadAnalysisData(analysisPath: string): Promise<AnalysisData | null> {
  const repoStructurePath = join(analysisPath, 'repo-structure.json');
  if (!(await fileExists(repoStructurePath))) {
    return null;
  }

  const repoStructureContent = await readFile(repoStructurePath, 'utf-8');
  const repoStructure = JSON.parse(repoStructureContent) as RepoStructure;

  let llmContext: LLMContext;
  const llmContextPath = join(analysisPath, 'llm-context.json');
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

  let depGraph: DependencyGraphResult | undefined;
  const depGraphPath = join(analysisPath, 'dependency-graph.json');
  if (await fileExists(depGraphPath)) {
    const content = await readFile(depGraphPath, 'utf-8');
    depGraph = JSON.parse(content) as DependencyGraphResult;
  }

  return { repoStructure, llmContext, depGraph };
}

/**
 * Generate OpenSpec specification files from analysis results using LLM.
 *
 * @throws Error if no spec-gen configuration found
 * @throws Error if no analysis found
 * @throws Error if no LLM API key found
 * @throws Error if LLM API connectivity fails
 * @throws Error if pipeline fails
 */
export async function specGenGenerate(options: GenerateApiOptions = {}): Promise<GenerateResult> {
  const startTime = Date.now();
  const rootPath = options.rootPath ?? process.cwd();
  const analysisRelPath = options.analysisPath ?? '.spec-gen/analysis/';
  const analysisPath = join(rootPath, analysisRelPath);
  const { onProgress } = options;

  // Load config
  progress(onProgress, 'Loading configuration', 'start');
  const specGenConfig = await readSpecGenConfig(rootPath);
  if (!specGenConfig) {
    throw new Error('No spec-gen configuration found. Run specGenInit() first.');
  }

  const openspecRelPath = specGenConfig.openspecPath ?? 'openspec';
  const fullOpenspecPath = join(rootPath, openspecRelPath);
  await readOpenSpecConfig(fullOpenspecPath); // Ensure it's readable
  progress(onProgress, 'Loading configuration', 'complete');

  // Load analysis
  progress(onProgress, 'Loading analysis', 'start');
  const analysisData = await loadAnalysisData(analysisPath);
  if (!analysisData) {
    throw new Error('No analysis found. Run specGenAnalyze() first.');
  }
  const { repoStructure, llmContext, depGraph } = analysisData;
  progress(onProgress, 'Loading analysis', 'complete', `${repoStructure.statistics.analyzedFiles} files`);

  // Resolve provider
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const openaiCompatKey = process.env.OPENAI_COMPAT_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;

  if (!anthropicKey && !openaiKey && !openaiCompatKey && !geminiKey) {
    throw new Error(
      'No LLM API key found. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, or OPENAI_COMPAT_API_KEY.'
    );
  }

  const envDetectedProvider = anthropicKey ? 'anthropic'
    : geminiKey ? 'gemini'
    : openaiCompatKey ? 'openai-compat'
    : 'openai';

  const effectiveProvider = options.provider ?? specGenConfig.generation.provider ?? envDetectedProvider;

  const defaultModels: Record<string, string> = {
    anthropic: 'claude-sonnet-4-20250514',
    gemini: 'gemini-2.0-flash',
    'openai-compat': 'mistral-large-latest',
    openai: 'gpt-4o',
  };
  const effectiveModel = options.model || specGenConfig.generation.model || defaultModels[effectiveProvider];

  const rootConfig = specGenConfig as unknown as Record<string, string>;
  const effectiveBaseUrl = options.openaiCompatBaseUrl
    ?? process.env.OPENAI_COMPAT_BASE_URL
    ?? specGenConfig.generation.openaiCompatBaseUrl
    ?? rootConfig['openaiCompatBaseUrl'];

  // Apply SSL verification setting
  const sslVerify = options.sslVerify ?? specGenConfig.llm?.sslVerify ?? true;
  if (!sslVerify || specGenConfig.generation.skipSslVerify) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  }

  // Create LLM service
  progress(onProgress, 'Creating LLM service', 'start');
  let llm: LLMService;
  try {
    llm = createLLMService({
      provider: effectiveProvider,
      model: effectiveModel,
      openaiCompatBaseUrl: effectiveBaseUrl,
      apiBase: options.apiBase ?? specGenConfig.llm?.apiBase,
      sslVerify,
      enableLogging: true,
      logDir: join(rootPath, '.spec-gen', 'logs'),
    });
  } catch (error) {
    throw new Error(`Failed to create LLM service: ${(error as Error).message}`);
  }
  progress(onProgress, 'Creating LLM service', 'complete', `${effectiveProvider}/${effectiveModel}`);

  // Dry run — return empty result
  if (options.dryRun) {
    progress(onProgress, 'Dry run complete', 'complete');
    return {
      report: {
        timestamp: new Date().toISOString(),
        openspecVersion: specGenConfig.version ?? '1.0.0',
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
      pipelineResult: {} as GenerateResult['pipelineResult'],
      duration: Date.now() - startTime,
    };
  }

  // Run pipeline
  progress(onProgress, 'Running LLM generation pipeline', 'start');
  const adr = options.adr ?? false;
  const adrOnly = options.adrOnly ?? false;
  const pipeline = new SpecGenerationPipeline(llm, {
    outputDir: join(rootPath, '.spec-gen', 'generation'),
    saveIntermediate: true,
    generateADRs: adr || adrOnly,
  });

  let pipelineResult;
  try {
    pipelineResult = await pipeline.run(repoStructure, llmContext, depGraph);
  } catch (error) {
    await llm.saveLogs().catch(() => {});
    throw new Error(`Pipeline failed: ${(error as Error).message}`);
  }
  progress(onProgress, 'Running LLM generation pipeline', 'complete');

  // Format specs
  progress(onProgress, 'Formatting specifications', 'start');
  const formatGenerator = new OpenSpecFormatGenerator({
    version: specGenConfig.version,
    includeConfidence: true,
    includeTechnicalNotes: true,
  });

  let generatedSpecs = adrOnly ? [] : formatGenerator.generateSpecs(pipelineResult);

  // Filter by domains
  if (!adrOnly && options.domains && options.domains.length > 0) {
    const domainSet = new Set(options.domains.map(d => d.toLowerCase()));
    generatedSpecs = generatedSpecs.filter(spec =>
      spec.type === 'overview' || spec.type === 'architecture' || domainSet.has(spec.domain.toLowerCase())
    );
  }

  // Generate ADRs
  if (adr || adrOnly) {
    const adrGenerator = new ADRGenerator({
      version: specGenConfig.version,
      includeMermaid: true,
    });
    const adrSpecs = adrGenerator.generateADRs(pipelineResult);
    generatedSpecs.push(...adrSpecs);
  }
  progress(onProgress, 'Formatting specifications', 'complete', `${generatedSpecs.length} files`);

  // Write specs
  progress(onProgress, 'Writing OpenSpec files', 'start');
  const writeMode: WriteMode = options.writeMode ?? 'replace';

  const writer = new OpenSpecWriter({
    rootPath,
    writeMode,
    version: specGenConfig.version,
    createBackups: true,
    updateConfig: true,
    validateBeforeWrite: true,
  });

  const report = await writer.writeSpecs(generatedSpecs, pipelineResult.survey);
  progress(onProgress, 'Writing OpenSpec files', 'complete', `${report.filesWritten.length} written`);

  // Generate mapping artifact
  if ((options.mapping ?? true) && depGraph) {
    try {
      const mapper = new MappingGenerator(rootPath, openspecRelPath);
      await mapper.generate(pipelineResult, depGraph);
      progress(onProgress, 'Generating mapping artifact', 'complete');
    } catch {
      // Non-fatal
    }
  }

  // Save LLM logs
  await llm.saveLogs().catch(() => {});

  return {
    report,
    pipelineResult,
    duration: Date.now() - startTime,
  };
}
