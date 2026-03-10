/**
 * Spec Generation Pipeline
 *
 * Orchestrates the multi-step LLM process to generate accurate specifications
 * in OpenSpec format from code analysis.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import logger from '../../utils/logger.js';
import type { ProgressIndicator } from '../../utils/progress.js';
import type { LLMService } from '../services/llm-service.js';
import type { RepoStructure, LLMContext, ArchitectureNode } from '../analyzer/artifact-generator.js';
import { buildGraphPromptSection, getFileGodFunctions, extractSubgraph } from '../analyzer/subgraph-extractor.js';
import { getSkeletonContent, detectLanguage, isSkeletonWorthIncluding } from '../analyzer/code-shaper.js';
import type { DependencyGraphResult } from '../analyzer/dependency-graph.js';
import { isTestFile, AnalysisArtifactGenerator } from '../analyzer/artifact-generator.js';
import { runStage1 } from './stages/stage1-survey.js';
import { runStage2 } from './stages/stage2-entities.js';
import { runStage3 } from './stages/stage3-services.js';
import { runStage4 } from './stages/stage4-api.js';
import { runStage5 } from './stages/stage5-architecture.js';
import { runStage6 } from './stages/stage6-adr.js';
import { PROMPTS } from './prompts.js';
import type {
  ProjectSurveyResult,
  ExtractedEntity,
  ExtractedService,
  ExtractedEndpoint,
  ArchitectureSynthesis,
  ArchitecturePattern,
  EnrichedADR,
  PipelineResult,
  StageResult,
  PipelineOptions,
  PipelineContext,
  ServiceSubSpec,
} from '../../types/pipeline.js';

// Re-export all types for backward compatibility with external consumers
export type {
  ProjectCategory,
  ArchitecturePattern,
  ProjectSurveyResult,
  EntityProperty,
  EntityRelationship,
  Scenario,
  ExtractedEntity,
  ServiceOperation,
  ServiceSubSpec,
  ExtractedService,
  ExtractedEndpoint,
  ArchitectureLayer,
  ArchitectureSynthesis,
  EnrichedADR,
  PipelineResult,
  StageResult,
  PipelineOptions,
  PipelineContext,
} from '../../types/pipeline.js';

// ============================================================================
// SPEC GENERATION PIPELINE
// ============================================================================

/**
 * Spec Generation Pipeline
 */
export class SpecGenerationPipeline implements PipelineContext {
  llm: LLMService;
  options: Required<Omit<PipelineOptions, 'progress'>>;
  private progress?: ProgressIndicator;
  /** Set at the start of run() and used by stage methods for graph-based prompts */
  private currentLLMContext?: LLMContext;

  constructor(llm: LLMService, options: PipelineOptions) {
    this.llm = llm;
    this.progress = options.progress;
    this.options = {
      outputDir: options.outputDir,
      skipStages: options.skipStages ?? [],
      resumeFrom: options.resumeFrom ?? '',
      maxRetries: options.maxRetries ?? 2,
      rootPath: options.rootPath ?? '',
      saveIntermediate: options.saveIntermediate ?? true,
      generateADRs: options.generateADRs ?? false,
    };
  }

  /**
   * Run the complete pipeline
   */
  async run(
    repoStructure: RepoStructure,
    llmContext: LLMContext,
    depGraph?: DependencyGraphResult
  ): Promise<PipelineResult> {
    this.currentLLMContext = llmContext;
    const startTime = Date.now();
    let totalTokens = 0;
    const completedStages: string[] = [];
    const skippedStages: string[] = [];

    // Ensure output directory exists
    if (this.options.saveIntermediate) {
      await mkdir(this.options.outputDir, { recursive: true });
    }

    const totalStages = this.options.generateADRs ? 6 : 5;
    let stageNum = 0;

     const startStage = (name: string, label: string) => {
       stageNum++;
       if (this.progress) {
         this.progress.updateGeneration({ stage: stageNum, totalStages, stageName: label });
       } else {
         logger.analysis(`Running Stage ${stageNum}: ${label}`);
       }
     };

     // Helper to execute a pipeline stage with consistent error handling
     const executeStage = async <T extends object>(
       name: string,
       label: string,
       runner: () => Promise<StageResult<T>>,
       fallback: () => T | Promise<T>,
       normalize?: (data: T) => T,
       onSuccess?: (data: T) => void
     ): Promise<T> => {
       if (!this.shouldRunStage(name)) {
         skippedStages.push(name);
         return fallback();
       }

       startStage(name, label);
       const result = await runner();

       if (result.success && result.data) {
         let data = result.data;
         if (normalize) data = normalize(data);
         totalTokens += result.tokens;
         completedStages.push(name);
         if (onSuccess) onSuccess(data);
         return data;
      } else {
        const errorMsg = result.error ?? 'Unknown error';
        this.progress?.stop();
        logger.warning(`${label} failed: ${errorMsg}`);
        if (name === 'survey' && /Unauthorized|401|403/i.test(errorMsg)) {
          throw new Error(`API authentication failed: ${errorMsg}. Check your API key`);
        }
        return await fallback();
      }
      };

      // Stage 1: Project Survey
      const survey = await executeStage(
        'survey',
        'Project Survey',
        async () => runStage1(this.llm, this.options, this.saveResult.bind(this), repoStructure, llmContext),
        () => this.getDefaultSurvey(repoStructure),
        data => ({
          ...data,
          frameworks: data.frameworks ?? [],
          suggestedDomains: data.suggestedDomains ?? [],
          schemaFiles: data.schemaFiles ?? [],
          serviceFiles: data.serviceFiles ?? [],
          apiFiles: data.apiFiles ?? [],
        })
      );

      // Stage 2: Entity Extraction
      let entities: ExtractedEntity[] = [];
      const schemaFiles = await this.resolveFiles(llmContext, survey.schemaFiles ?? [], this.getSchemaFiles(llmContext));
      if (schemaFiles.length > 0) {
        entities = await executeStage(
          'entities',
          'Entity Extraction',
          async () => runStage2(this, survey, schemaFiles, (i, total, file) => {
            this.progress?.updateGeneration({ stage: stageNum, totalStages, stageName: `Entity Extraction ${i}/${total}: ${file}` });
          }),
          () => []
        );
      } else {
        logger.warning('No schema files found, skipping entity extraction');
        skippedStages.push('entities');
      }

      // Stage 3: Service Analysis
      let services: ExtractedService[] = [];
      const serviceFiles = await this.resolveFiles(llmContext, survey.serviceFiles ?? [], this.getServiceFiles(llmContext));
      if (serviceFiles.length > 0) {
        services = await executeStage(
          'services',
          'Service Analysis',
          async () => runStage3(this, survey, entities, serviceFiles, (i, total, file) => {
            this.progress?.updateGeneration({ stage: stageNum, totalStages, stageName: `Service Analysis ${i}/${total}: ${file}` });
          }),
          () => []
        );
      } else {
        logger.warning('No service files found, skipping service analysis');
        skippedStages.push('services');
      }

       // Stage 4: API Extraction
       let endpoints: ExtractedEndpoint[] = [];
       const apiFiles = await this.resolveFiles(llmContext, survey.apiFiles ?? [], this.getApiFiles(llmContext));
       if (apiFiles.length > 0) {
         endpoints = await executeStage(
           'api',
           'API Extraction',
           async () => runStage4(this, apiFiles, (i, total, file) => {
             this.progress?.updateGeneration({ stage: stageNum, totalStages, stageName: `API Extraction ${i}/${total}: ${file}` });
           }),
           () => []
         );
       } else {
         logger.warning('No API files found, skipping API extraction');
         skippedStages.push('api');
       }

       // Stage 5: Architecture Synthesis
       const architecture = await executeStage(
         'architecture',
         'Architecture Synthesis',
         async () => runStage5(this, survey, entities, services, endpoints, depGraph, llmContext.callGraph),
         () => this.getDefaultArchitecture(survey),
         data => ({
           ...data,
           layerMap: data.layerMap ?? [],
           integrations: data.integrations ?? [],
           keyDecisions: data.keyDecisions ?? [],
           nodeRoles: data.nodeRoles ?? [],
         })
       );
      // Enrich architecture_nodes.json with LLM-derived roles from stage 5
      if (architecture.nodeRoles && architecture.nodeRoles.length > 0 && this.options.saveIntermediate) {
        try {
          const raw = await readFile(join(this.options.outputDir, 'architecture_nodes.json'), 'utf-8');
          const existingNodes: ArchitectureNode[] = JSON.parse(raw);
          const artifactGenerator = new AnalysisArtifactGenerator({
            rootDir: this.options.rootPath,
            outputDir: this.options.outputDir,
          });
          await artifactGenerator.enrichArchitectureNodes(existingNodes, architecture.nodeRoles);
        } catch {
          // architecture_nodes.json not present or unreadable — non-fatal
        }
      }

      // Stage 6: ADR Enrichment (optional)
      let adrs: EnrichedADR[] = [];
      if (this.options.generateADRs && this.shouldRunStage('adr')) {
        if (architecture.keyDecisions.length > 0) {
          adrs = await executeStage(
            'adr',
            'ADR Enrichment',
            async () => runStage6(this, architecture),
            () => [] as EnrichedADR[]
          );
        } else {
          logger.warning('No key decisions found, skipping ADR enrichment');
          skippedStages.push('adr');
        }
      }

    const duration = Date.now() - startTime;
    const costTracking = this.llm.getCostTracking();

    const pipelineResult: PipelineResult = {
      survey,
      entities,
      services,
      endpoints,
      architecture,
      adrs: adrs.length > 0 ? adrs : undefined,
      metadata: {
        totalTokens,
        estimatedCost: costTracking.estimatedCost,
        duration,
        completedStages,
        skippedStages,
      },
    };

    // Save final result
    if (this.options.saveIntermediate) {
      await this.saveResult('pipeline-result', pipelineResult);
    }

    logger.success(`Pipeline completed in ${(duration / 1000).toFixed(1)}s, ${totalTokens} tokens used`);

    return pipelineResult;
  }

  /**
   * Check if a stage should run
   */
  private shouldRunStage(stage: string): boolean {
    if (this.options.skipStages.includes(stage)) {
      return false;
    }

    if (this.options.resumeFrom) {
      const stages = ['survey', 'entities', 'services', 'api', 'architecture', 'adr'];
      const resumeIndex = stages.indexOf(this.options.resumeFrom);
      const currentIndex = stages.indexOf(stage);
      return currentIndex >= resumeIndex;
    }

    return true;
  }

  /**
   * Split file content into chunks, breaking only on blank lines (function/class boundaries).
   * A chunk is emitted when its size exceeds maxChars and a blank line is encountered.
   * overlapLines trailing lines from the previous chunk are prepended to the next one,
   * preserving context (e.g. class declaration visible when processing its methods).
   */
  chunkContent(content: string, maxChars: number, overlapLines = 10): string[] {
    if (content.length <= maxChars) return [content];

    const lines = content.split('\n');
    const chunks: string[] = [];
    let currentLines: string[] = [];
    let currentSize = 0;

    for (const line of lines) {
      currentLines.push(line);
      currentSize += line.length + 1;

      // Break only at blank lines once the threshold is reached
      if (currentSize >= maxChars && line.trim() === '') {
        const chunk = currentLines.join('\n').trim();
        if (chunk.length > 0) chunks.push(chunk);
        // Carry over the last N lines as overlap for the next chunk
        const overlap = currentLines.slice(-overlapLines);
        currentLines = [...overlap];
        currentSize = overlap.reduce((s, l) => s + l.length + 1, 0);
      }
    }

    const remaining = currentLines.join('\n').trim();
    if (remaining.length > 0) chunks.push(remaining);

    return chunks;
  }

  /**
   * For a large file, try to build a graph-based prompt section.
   * Returns null when no call graph data is available or the file has no god functions
   * (caller should fall back to raw source chunking).
   *
   * When file content is provided, appends a stripped skeleton when it achieves
   * a meaningful size reduction (≥ 20%), giving the LLM both topology and
   * internal control-flow structure.
   */
  graphPromptFor(filePath: string, content?: string): string | null {
    const ctx = this.currentLLMContext;
    if (!ctx?.callGraph) return null;

    const graphSection = buildGraphPromptSection(ctx.callGraph, ctx.signatures, filePath);
    if (!graphSection) return null;
    if (!content) return graphSection;

    const language = detectLanguage(filePath);
    const skeleton = getSkeletonContent(content, language);

    if (isSkeletonWorthIncluding(content, skeleton)) {
      // Cap skeleton at 4000 chars to avoid overwhelming the prompt
      const cap = 4000;
      const skeletonExcerpt = skeleton.length > cap
        ? skeleton.slice(0, cap) + '\n... [skeleton truncated]'
        : skeleton;
      return `${graphSection}\n\nFunction skeleton (logs/comments stripped):\n${skeletonExcerpt}`;
    }

    return graphSection;
  }

  /**
   * Generate sub-specifications for the direct callees of god functions in a file.
   * Makes a single batched LLM call covering all callees at once.
   * Returns [] when no graph data or no god functions are found.
   */
  async generateSubSpecs(
    filePath: string,
    parentName: string,
    parentPurpose: string,
  ): Promise<ServiceSubSpec[]> {
    const callGraph = this.currentLLMContext?.callGraph;
    if (!callGraph) return [];

    const godFunctions = getFileGodFunctions(callGraph, filePath);
    if (godFunctions.length === 0) return [];

    // Collect unique direct callees across all god functions in this file
    const seenCallees = new Set<string>();
    const calleeInfos: Array<{
      name: string;
      signature?: string;
      docstring?: string;
      subcallees: string[];
    }> = [];

    for (const godFn of godFunctions) {
      const sub = extractSubgraph(callGraph, godFn);
      const directCallees = [...new Set(
        sub.edges.filter(([from]) => from === godFn.name).map(([, to]) => to)
      )];

      for (const calleeName of directCallees) {
        if (seenCallees.has(calleeName)) continue;
        seenCallees.add(calleeName);

        const sigEntry = this.currentLLMContext?.signatures
          ?.flatMap(s => s.entries)
          .find(e => e.name === calleeName);

        const subcallees = [...new Set(
          sub.edges.filter(([from]) => from === calleeName).map(([, to]) => to)
        )];

        calleeInfos.push({
          name: calleeName,
          signature: sigEntry?.signature,
          docstring: sigEntry?.docstring,
          subcallees,
        });
      }
    }

    if (calleeInfos.length === 0) return [];

    try {
      const result = await this.llm.completeJSON<ServiceSubSpec[]>({
        systemPrompt: PROMPTS.stage3_subspec_system,
        userPrompt: PROMPTS.stage3_subspec(parentName, parentPurpose, calleeInfos),
        temperature: 0.3,
        maxTokens: 4000,
      });
      if (Array.isArray(result)) {
        // Ensure callee field is set — LLM sometimes names it differently
        for (const sub of result) {
          if (!sub.callee) {
            const matched = calleeInfos.find(
              c => c.name === sub.name ||
              c.name.toLowerCase().includes((sub.name ?? '').toLowerCase())
            );
            sub.callee = matched?.name ?? sub.name;
          }
          sub.operations = sub.operations ?? [];
        }
        return result;
      }
    } catch (error) {
      logger.warning(`Sub-specs: failed for ${parentName}: ${(error as Error).message}`);
    }
    return [];
  }

  /**
   * Get schema files from LLM context
   */
  private getSchemaFiles(context: LLMContext): Array<{ path: string; content: string }> {
    return context.phase2_deep.files
      .filter(f => {
        const name = f.path.toLowerCase();
        return (
          name.includes('model') ||
          name.includes('schema') ||
          name.includes('entity') ||
          name.includes('types') ||
          name.includes('interface')
        );
      })
      .map(f => ({ path: f.path, content: f.content ?? '' }))
      .filter(f => f.content.length > 0);
  }

  /**
   * Get service files from LLM context
   */
  private getServiceFiles(context: LLMContext): Array<{ path: string; content: string }> {
    return context.phase2_deep.files
      .filter(f => {
        const name = f.path.toLowerCase();
        return (
          name.includes('service') ||
          name.includes('manager') ||
          name.includes('handler') ||
          name.includes('controller') ||
          name.includes('use-case') ||
          name.includes('usecase')
        );
      })
      .map(f => ({ path: f.path, content: f.content ?? '' }))
      .filter(f => f.content.length > 0);
  }

  /**
   * Get API files from LLM context
   */
  private getApiFiles(context: LLMContext): Array<{ path: string; content: string }> {
    return context.phase2_deep.files
      .filter(f => {
        const name = f.path.toLowerCase();
        return (
          name.includes('route') ||
          name.includes('api') ||
          name.includes('endpoint') ||
          name.includes('controller') ||
          name.includes('rest')
        );
      })
      .map(f => ({ path: f.path, content: f.content ?? '' }))
      .filter(f => f.content.length > 0);
  }

  /**
   * Resolve file paths identified by Stage 1 LLM to actual file content.
   * First looks in phase2_deep (already in memory); if not found and rootPath is set,
   * reads the file from disk so that files outside the top-20 scored set can still
   * be analyzed in later stages.
   * Falls back to the provided heuristic list if no paths resolve.
   */
  private async resolveFiles(
    context: LLMContext,
    llmPaths: string[],
    fallback: Array<{ path: string; content: string }>
  ): Promise<Array<{ path: string; content: string }>> {
    // Guard: never pass test files to the LLM stages regardless of what Stage 1 suggested
    const safePaths = llmPaths.filter(p => !isTestFile(p));
    if (safePaths.length === 0) {
      return fallback.filter(f => !isTestFile(f.path));
    }
    llmPaths = safePaths;

    const allFiles = context.phase2_deep.files;
    const resolved: Array<{ path: string; content: string }> = [];

    for (const p of llmPaths) {
      // 1. Look in phase2_deep (already loaded in memory)
      const found = allFiles.find(f => f.path === p || f.path.endsWith('/' + p) || p.endsWith('/' + f.path));
      if (found?.content) {
        resolved.push({ path: found.path, content: found.content });
        continue;
      }
      // 2. Read from disk when rootPath is configured (covers files outside phase2_deep)
      if (this.options.rootPath) {
        try {
          const absPath = resolve(this.options.rootPath, p);
          // Prevent path traversal outside the project root
          if (!absPath.startsWith(resolve(this.options.rootPath))) continue;
          const content = await readFile(absPath, 'utf-8');
          resolved.push({ path: p, content });
        } catch {
          // file not found or unreadable — skip
        }
      }
    }

    return resolved.length > 0 ? resolved : fallback;
  }

  /**
   * Get default survey when stage is skipped
   */
  private getDefaultSurvey(repoStructure: RepoStructure): ProjectSurveyResult {
    return {
      projectCategory: 'other',
      primaryLanguage: repoStructure.projectType,
      frameworks: repoStructure.frameworks,
      architecturePattern: repoStructure.architecture.pattern as ArchitecturePattern,
      domainSummary: `A ${repoStructure.projectType} project`,
      suggestedDomains: repoStructure.domains.map(d => d.name),
      confidence: 0.5,
      schemaFiles: [],
      serviceFiles: [],
      apiFiles: [],
    };
  }

  /**
   * Get default architecture when stage is skipped
   */
  private getDefaultArchitecture(survey: ProjectSurveyResult): ArchitectureSynthesis {
    return {
      systemPurpose: survey.domainSummary,
      architectureStyle: survey.architecturePattern,
      layerMap: [],
      dataFlow: 'Unknown',
      integrations: [],
      securityModel: 'Unknown',
      keyDecisions: [],
    };
  }

  /**
   * Save intermediate result
   */
  async saveResult(name: string, data: unknown): Promise<void> {
    const filepath = join(this.options.outputDir, `${name}.json`);
    await writeFile(filepath, JSON.stringify(data, null, 2));
    logger.debug(`Saved ${name} to ${filepath}`);
  }

  /**
   * Load previous stage result (for resume)
   */
  async loadStageResult<T>(stage: string): Promise<StageResult<T> | null> {
    try {
      const filepath = join(this.options.outputDir, `stage-${stage}.json`);
      const content = await readFile(filepath, 'utf-8');
      return JSON.parse(content) as StageResult<T>;
    } catch {
      return null;
    }
  }
}

// ============================================================================
// CONVENIENCE FUNCTIONS
// ============================================================================

/**
 * Run the spec generation pipeline
 */
export async function runSpecGenerationPipeline(
  llm: LLMService,
  repoStructure: RepoStructure,
  llmContext: LLMContext,
  options: PipelineOptions,
  depGraph?: DependencyGraphResult
): Promise<PipelineResult> {
  const pipeline = new SpecGenerationPipeline(llm, options);
  return pipeline.run(repoStructure, llmContext, depGraph);
}
