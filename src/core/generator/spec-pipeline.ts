/**
 * Spec Generation Pipeline
 *
 * Orchestrates the multi-step LLM process to generate accurate specifications
 * in OpenSpec format from code analysis.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import logger from '../../utils/logger.js';
import type { LLMService } from '../services/llm-service.js';
import type { RepoStructure, LLMContext } from '../analyzer/artifact-generator.js';
import type { DependencyGraphResult } from '../analyzer/dependency-graph.js';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Project category from Stage 1
 */
export type ProjectCategory =
  | 'web-frontend'
  | 'web-backend'
  | 'api-service'
  | 'cli-tool'
  | 'library'
  | 'mobile-app'
  | 'desktop-app'
  | 'data-pipeline'
  | 'ml-service'
  | 'monorepo'
  | 'other';

/**
 * Architecture pattern
 */
export type ArchitecturePattern =
  | 'layered'
  | 'hexagonal'
  | 'microservices'
  | 'monolith'
  | 'serverless'
  | 'event-driven'
  | 'mvc'
  | 'other';

/**
 * Stage 1 output: Project Survey
 */
export interface ProjectSurveyResult {
  projectCategory: ProjectCategory;
  primaryLanguage: string;
  frameworks: string[];
  architecturePattern: ArchitecturePattern;
  domainSummary: string;
  suggestedDomains: string[];
  confidence: number;
  /** Files containing data models, types, entities — for Stage 2 entity extraction */
  schemaFiles: string[];
  /** Files containing business logic, services, processors — for Stage 3 service analysis */
  serviceFiles: string[];
  /** Files exposing public interfaces, HTTP routes, CLI commands — for Stage 4 API extraction */
  apiFiles: string[];
}

/**
 * Entity property
 */
export interface EntityProperty {
  name: string;
  type: string;
  description?: string;
  required?: boolean;
}

/**
 * Entity relationship
 */
export interface EntityRelationship {
  targetEntity: string;
  type: 'one-to-one' | 'one-to-many' | 'many-to-many' | 'belongs-to';
  description?: string;
}

/**
 * Scenario in Given/When/Then format
 */
export interface Scenario {
  name: string;
  given: string;
  when: string;
  then: string;
  and?: string[];
}

/**
 * Stage 2 output: Entity
 */
export interface ExtractedEntity {
  name: string;
  description: string;
  properties: EntityProperty[];
  relationships: EntityRelationship[];
  validations: string[];
  scenarios: Scenario[];
  location: string;
}

/**
 * Service operation
 */
export interface ServiceOperation {
  name: string;
  description: string;
  inputs?: string[];
  outputs?: string[];
  scenarios: Scenario[];
  functionName?: string; // exact function/method name in source code, as reported by LLM
}

/**
 * Stage 3 output: Service
 */
export interface ExtractedService {
  name: string;
  purpose: string;
  operations: ServiceOperation[];
  dependencies: string[];
  sideEffects: string[];
  domain: string;
}

/**
 * Stage 4 output: API Endpoint
 */
export interface ExtractedEndpoint {
  method: string;
  path: string;
  purpose: string;
  authentication?: string;
  requestSchema?: Record<string, unknown>;
  responseSchema?: Record<string, unknown>;
  scenarios: Scenario[];
  relatedEntity?: string;
}

/**
 * Layer in the architecture
 */
export interface ArchitectureLayer {
  name: string;
  purpose: string;
  components: string[];
}

/**
 * Stage 5 output: Architecture Synthesis
 */
export interface ArchitectureSynthesis {
  systemPurpose: string;
  architectureStyle: string;
  layerMap: ArchitectureLayer[];
  dataFlow: string;
  integrations: string[];
  securityModel: string;
  keyDecisions: string[];
}

/**
 * Stage 6 output: Enriched Architecture Decision Record
 */
export interface EnrichedADR {
  id: string;
  title: string;
  status: 'accepted' | 'proposed' | 'deprecated' | 'superseded';
  context: string;
  decision: string;
  consequences: string[];
  alternatives: string[];
  relatedLayers: string[];
  relatedDomains: string[];
}

/**
 * Complete pipeline result
 */
export interface PipelineResult {
  survey: ProjectSurveyResult;
  entities: ExtractedEntity[];
  services: ExtractedService[];
  endpoints: ExtractedEndpoint[];
  architecture: ArchitectureSynthesis;
  adrs?: EnrichedADR[];
  metadata: {
    totalTokens: number;
    estimatedCost: number;
    duration: number;
    completedStages: string[];
    skippedStages: string[];
  };
}

/**
 * Stage result for intermediate storage
 */
export interface StageResult<T> {
  stage: string;
  success: boolean;
  data?: T;
  error?: string;
  tokens: number;
  duration: number;
}

/**
 * Pipeline options
 */
export interface PipelineOptions {
  /** Output directory for intermediate results */
  outputDir: string;
  /** Skip specific stages */
  skipStages?: string[];
  /** Resume from a specific stage */
  resumeFrom?: string;
  /** Maximum retries per stage */
  maxRetries?: number;
  /** Save intermediate results */
  saveIntermediate?: boolean;
  /** Generate Architecture Decision Records (triggers Stage 6) */
  generateADRs?: boolean;
}

// ============================================================================
// SYSTEM PROMPTS
// ============================================================================

const PROMPTS = {
  stage1_survey: `You are a senior software architect performing a codebase audit.
Your task is to categorize this project based on the analysis data provided.

Respond with a JSON object containing:
- projectCategory: One of ["web-frontend", "web-backend", "api-service", "cli-tool", "library", "mobile-app", "desktop-app", "data-pipeline", "ml-service", "monorepo", "other"]
- primaryLanguage: The main language
- frameworks: Array of detected frameworks
- architecturePattern: One of ["layered", "hexagonal", "microservices", "monolith", "serverless", "event-driven", "mvc", "other"]
- domainSummary: One sentence describing what this system does
- suggestedDomains: Array of domain names for OpenSpec specs (e.g., ["user", "order", "auth", "api"])
- confidence: 0-1 score of how confident you are
- schemaFiles: Array of file paths (from the provided file list) that define data models, types, entities, or interfaces — these will be used for entity extraction. Include files regardless of their name, based on their content role.
- serviceFiles: Array of file paths containing business logic, services, processors, analyzers, pipelines, or domain operations — used for service analysis. Do not filter by name conventions; look at what the file does.
- apiFiles: Array of file paths that expose public interfaces: HTTP routes, CLI command handlers, GraphQL resolvers, message consumers, or external-facing APIs.

For schemaFiles/serviceFiles/apiFiles: use the exact file paths from the provided analysis. Return [] if none apply.

Respond ONLY with valid JSON.`,

  stage2_entities: (projectCategory: string, frameworks: string[]) => `You are analyzing the core data models of a ${projectCategory} built with ${frameworks.join(', ')}.

For each entity you identify, extract in OpenSpec format:
- name: The entity name (e.g., "User", "Order")
- description: What this entity represents in the business domain
- properties: Array of {name, type, description, required}
- relationships: Array of {targetEntity, type, description}
- validations: Array of validation rules as strings (these become Requirements)
- scenarios: Array of {name, given, when, then, and?} - observable behaviors in Given/When/Then format

Focus on BUSINESS entities, not framework internals.
Be precise - only include what you can verify from the code.

Respond with a JSON array of entities. Respond ONLY with valid JSON.`,

  stage3_services: (projectCategory: string, entities: string[], suggestedDomains: string[]) => `You are analyzing the logic and processing layer of a ${projectCategory}.

Known entities: ${entities.join(', ')}
Available domains: ${suggestedDomains.join(', ')}

For each service/module, identify:
- name: Service name
- purpose: What capability or responsibility it encapsulates
- operations: Array of {name, description, inputs, outputs, scenarios, functionName} - key operations/methods that become Requirements with Scenarios. Focus on the 3 most important operations per service, with 1 scenario each.
  - operations[].functionName: The exact function or method name as written in the source code that implements this operation (e.g. "runStage2", "buildSpecMap"). Leave empty string if uncertain.
- dependencies: Array of other services/repositories it uses
- sideEffects: Array of external interactions (file I/O, network calls, database, queues, etc.)
- domain: Which domain OWNS this service (where it lives in the codebase, not who uses it) — use ONLY one of the available domains listed above

Focus on WHAT the service does, not HOW it's implemented.
Express operations as requirements (SHALL/MUST/SHOULD) with testable scenarios.

Respond with a JSON array of services. Respond ONLY with valid JSON.`,

  stage4_api: `Extract the public API surface of this application.

For each endpoint/interface, structure as:
- method: HTTP method or interface type
- path: Route path or interface signature
- purpose: What it does (becomes requirement description)
- authentication: Required auth (if detectable)
- requestSchema: Expected input as JSON object
- responseSchema: Expected output as JSON object
- scenarios: Array of {name, given, when, then, and?} - example request/response flows
- relatedEntity: Which domain entity it operates on

Respond with a JSON array of endpoints. Respond ONLY with valid JSON.`,

  stage5_architecture: (survey: ProjectSurveyResult) => `Based on the analysis data, synthesize a complete architecture overview for OpenSpec.

Project context: ${survey.domainSummary}
Architecture pattern: ${survey.architecturePattern}
Domains: ${survey.suggestedDomains.join(', ')}

Include:
- systemPurpose: 2-3 sentences on what this system does and why
- architectureStyle: The overall architecture pattern with justification
- layerMap: Array of {name, purpose, components} - how code is organized
- dataFlow: How data moves through the system (entry to persistence) as a string
- integrations: Array of external systems this interacts with
- securityModel: Authentication/authorization approach as a string
- keyDecisions: Array of observable architectural decisions as strings

Express each key architectural aspect clearly.
Base all conclusions on the code evidence provided.
Where uncertain, say so explicitly.

Respond with a JSON object. Respond ONLY with valid JSON.`,

  stage6_adr: (architecture: ArchitectureSynthesis) => `You are a senior software architect creating Architecture Decision Records (ADRs).

For each key decision listed below, produce a complete ADR with:
- id: Sequential like "ADR-001", "ADR-002", etc.
- title: The decision as a clear statement (e.g., "Use TypeORM for database access")
- status: "accepted" (these are observed decisions already implemented in the code)
- context: 2-3 sentences on why this decision was needed
- decision: 1-2 sentences clearly stating what was decided
- consequences: Array of 2-4 consequences (include both positive and negative)
- alternatives: Array of 1-3 alternatives that could have been chosen instead
- relatedLayers: Array of architecture layer names affected (from: ${architecture.layerMap.map(l => l.name).join(', ')})
- relatedDomains: Array of domain names affected

Architecture context:
- System purpose: ${architecture.systemPurpose}
- Architecture style: ${architecture.architectureStyle}
- Layers: ${architecture.layerMap.map(l => `${l.name} (${l.purpose})`).join(', ')}
- Data flow: ${architecture.dataFlow}
- Security model: ${architecture.securityModel}
- External integrations: ${architecture.integrations.join(', ') || 'None'}

Key decisions to expand into full ADRs:
${architecture.keyDecisions.map((d, i) => `${i + 1}. ${d}`).join('\n')}

Base all conclusions on the code evidence provided. Where uncertain, say so explicitly.
Respond with a JSON array of ADR objects. Respond ONLY with valid JSON.`,
};

// ============================================================================
// SPEC GENERATION PIPELINE
// ============================================================================

/**
 * Spec Generation Pipeline
 */
export class SpecGenerationPipeline {
  private llm: LLMService;
  private options: Required<PipelineOptions>;
  private stageResults: Map<string, StageResult<unknown>> = new Map();

  constructor(llm: LLMService, options: PipelineOptions) {
    this.llm = llm;
    this.options = {
      outputDir: options.outputDir,
      skipStages: options.skipStages ?? [],
      resumeFrom: options.resumeFrom ?? '',
      maxRetries: options.maxRetries ?? 2,
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
    const startTime = Date.now();
    let totalTokens = 0;
    const completedStages: string[] = [];
    const skippedStages: string[] = [];

    // Ensure output directory exists
    if (this.options.saveIntermediate) {
      await mkdir(this.options.outputDir, { recursive: true });
    }

    // Stage 1: Project Survey
    let survey: ProjectSurveyResult;
    if (this.shouldRunStage('survey')) {
      logger.analysis('Running Stage 1: Project Survey');
      const result = await this.runStage1(repoStructure, llmContext);
      if (result.success && result.data) {
        survey = result.data;
        totalTokens += result.tokens;
        completedStages.push('survey');
      } else {
        const errorMsg = result.error ?? 'Unknown error';
        logger.warning(`Survey stage failed: ${errorMsg}`);
        if (errorMsg.includes('Unauthorized') || errorMsg.includes('401') || errorMsg.includes('403')) {
          throw new Error(`API authentication failed: ${errorMsg}. Check your API key (OPENAI_COMPAT_API_KEY, ANTHROPIC_API_KEY, etc.)`);
        }
        survey = this.getDefaultSurvey(repoStructure);
        skippedStages.push('survey');
      }
    } else {
      skippedStages.push('survey');
      survey = this.getDefaultSurvey(repoStructure);
    }

    // Stage 2: Entity Extraction
    let entities: ExtractedEntity[] = [];
    if (this.shouldRunStage('entities')) {
      logger.analysis('Running Stage 2: Entity Extraction');
      const schemaFiles = this.resolveFiles(llmContext, survey.schemaFiles ?? [], this.getSchemaFiles(llmContext));
      if (schemaFiles.length > 0) {
        const result = await this.runStage2(survey, schemaFiles);
        entities = result.data ?? [];
        totalTokens += result.tokens;
        completedStages.push('entities');
      } else {
        logger.warning('No schema files found, skipping entity extraction');
        skippedStages.push('entities');
      }
    } else {
      skippedStages.push('entities');
    }

    // Stage 3: Service Analysis
    let services: ExtractedService[] = [];
    if (this.shouldRunStage('services')) {
      logger.analysis('Running Stage 3: Service Analysis');
      const serviceFiles = this.resolveFiles(llmContext, survey.serviceFiles ?? [], this.getServiceFiles(llmContext));
      if (serviceFiles.length > 0) {
        const result = await this.runStage3(survey, entities, serviceFiles);
        services = result.data ?? [];
        totalTokens += result.tokens;
        completedStages.push('services');
      } else {
        logger.warning('No service files found, skipping service analysis');
        skippedStages.push('services');
      }
    } else {
      skippedStages.push('services');
    }

    // Stage 4: API Extraction
    let endpoints: ExtractedEndpoint[] = [];
    if (this.shouldRunStage('api')) {
      logger.analysis('Running Stage 4: API Extraction');
      const apiFiles = this.resolveFiles(llmContext, survey.apiFiles ?? [], this.getApiFiles(llmContext));
      if (apiFiles.length > 0) {
        const result = await this.runStage4(apiFiles);
        endpoints = result.data ?? [];
        totalTokens += result.tokens;
        completedStages.push('api');
      } else {
        logger.warning('No API files found, skipping API extraction');
        skippedStages.push('api');
      }
    } else {
      skippedStages.push('api');
    }

    // Stage 5: Architecture Synthesis
    let architecture: ArchitectureSynthesis;
    if (this.shouldRunStage('architecture')) {
      logger.analysis('Running Stage 5: Architecture Synthesis');
      const result = await this.runStage5(survey, entities, services, endpoints, depGraph);
      if (result.success && result.data) {
        architecture = result.data;
        totalTokens += result.tokens;
        completedStages.push('architecture');
      } else {
        logger.warning('Architecture stage failed, using defaults');
        architecture = this.getDefaultArchitecture(survey);
        skippedStages.push('architecture');
      }
    } else {
      skippedStages.push('architecture');
      architecture = this.getDefaultArchitecture(survey);
    }

    // Stage 6: ADR Enrichment (optional)
    let adrs: EnrichedADR[] = [];
    if (this.options.generateADRs && this.shouldRunStage('adr')) {
      if (architecture.keyDecisions.length > 0) {
        logger.analysis('Running Stage 6: ADR Enrichment');
        const result = await this.runStage6(architecture);
        adrs = result.data ?? [];
        totalTokens += result.tokens;
        if (result.success) {
          completedStages.push('adr');
        } else {
          logger.warning('ADR enrichment failed');
          skippedStages.push('adr');
        }
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
   * Stage 1: Project Survey
   */
  private async runStage1(repoStructure: RepoStructure, llmContext: LLMContext): Promise<StageResult<ProjectSurveyResult>> {
    const startTime = Date.now();

    const filePaths = llmContext.phase2_deep.files.map(f => f.path);

    const userPrompt = `Analyze this project structure:

Project Name: ${repoStructure.projectName}
Project Type: ${repoStructure.projectType}
Frameworks: ${repoStructure.frameworks.join(', ')}
Architecture Pattern: ${repoStructure.architecture.pattern}

Layers:
${repoStructure.architecture.layers.map(l => `- ${l.name}: ${l.purpose} (${l.files.length} files)`).join('\n')}

Detected Domains:
${repoStructure.domains.map(d => `- ${d.name}: ${d.files.length} files, entities: ${d.entities.join(', ')}`).join('\n')}

Statistics:
- Total files: ${repoStructure.statistics.totalFiles}
- Analyzed files: ${repoStructure.statistics.analyzedFiles}
- Node count: ${repoStructure.statistics.nodeCount}
- Edge count: ${repoStructure.statistics.edgeCount}
- Clusters: ${repoStructure.statistics.clusterCount}

Available file paths for analysis (use ONLY these exact strings for schemaFiles/serviceFiles/apiFiles):
${filePaths.map(p => `- ${p}`).join('\n')}`;

    try {
      const result = await this.llm.completeJSON<ProjectSurveyResult>({
        systemPrompt: PROMPTS.stage1_survey,
        userPrompt,
        temperature: 0.3,
        maxTokens: 1000,
      });

      const stageResult: StageResult<ProjectSurveyResult> = {
        stage: 'survey',
        success: true,
        data: result,
        tokens: this.llm.getTokenUsage().totalTokens,
        duration: Date.now() - startTime,
      };

      if (this.options.saveIntermediate) {
        await this.saveResult('stage1-survey', stageResult);
      }

      return stageResult;
    } catch (error) {
      return {
        stage: 'survey',
        success: false,
        error: (error as Error).message,
        tokens: 0,
        duration: Date.now() - startTime,
      };
    }
  }

  /**
   * Split file content into chunks, breaking only on blank lines (function/class boundaries).
   * A chunk is emitted when its size exceeds maxChars and a blank line is encountered.
   * overlapLines trailing lines from the previous chunk are prepended to the next one,
   * preserving context (e.g. class declaration visible when processing its methods).
   */
  private chunkContent(content: string, maxChars: number, overlapLines = 10): string[] {
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
   * Stage 2: Entity Extraction — one LLM call per file (chunked if large)
   */
  private async runStage2(
    survey: ProjectSurveyResult,
    schemaFiles: Array<{ path: string; content: string }>
  ): Promise<StageResult<ExtractedEntity[]>> {
    const startTime = Date.now();
    const systemPrompt = PROMPTS.stage2_entities(survey.projectCategory, survey.frameworks);
    const allEntities: ExtractedEntity[] = [];
    const seenNames = new Set<string>();

    for (const file of schemaFiles.slice(0, 10)) {
      const chunks = this.chunkContent(file.content, 8000);
      for (let i = 0; i < chunks.length; i++) {
        const chunkNote = chunks.length > 1 ? ` (part ${i + 1}/${chunks.length})` : '';
        const userPrompt = `Analyze this schema/model file and extract entities:\n\n=== ${file.path}${chunkNote} ===\n${chunks[i]}`;
        try {
          const result = await this.llm.completeJSON<ExtractedEntity[]>({
            systemPrompt,
            userPrompt,
            temperature: 0.3,
            maxTokens: 2000,
          });
          if (Array.isArray(result)) {
            for (const entity of result) {
              if (!seenNames.has(entity.name)) {
                seenNames.add(entity.name);
                entity.location = file.path; // always use the actual file, not the LLM's guess
                allEntities.push(entity);
              }
            }
          }
        } catch (error) {
          logger.warning(`Stage 2: failed to analyze ${file.path}${chunkNote}: ${(error as Error).message}`);
        }
      }
    }

    const stageResult: StageResult<ExtractedEntity[]> = {
      stage: 'entities',
      success: true,
      data: allEntities,
      tokens: this.llm.getTokenUsage().totalTokens,
      duration: Date.now() - startTime,
    };

    if (this.options.saveIntermediate) {
      await this.saveResult('stage2-entities', stageResult);
    }

    return stageResult;
  }

  /**
   * Stage 3: Service Analysis — one LLM call per file (chunked if large)
   */
  private async runStage3(
    survey: ProjectSurveyResult,
    entities: ExtractedEntity[],
    serviceFiles: Array<{ path: string; content: string }>
  ): Promise<StageResult<ExtractedService[]>> {
    const startTime = Date.now();
    const entityNames = entities.map(e => e.name);
    const systemPrompt = PROMPTS.stage3_services(survey.projectCategory, entityNames, survey.suggestedDomains ?? []);
    const allServices: ExtractedService[] = [];
    const seenNames = new Set<string>();

    for (const file of serviceFiles.slice(0, 10)) {
      const chunks = this.chunkContent(file.content, 8000);
      for (let i = 0; i < chunks.length; i++) {
        const chunkNote = chunks.length > 1 ? ` (part ${i + 1}/${chunks.length})` : '';
        const userPrompt = `Analyze this file and extract services/modules:\n\n=== ${file.path}${chunkNote} ===\n${chunks[i]}`;
        try {
          const result = await this.llm.completeJSON<ExtractedService[]>({
            systemPrompt,
            userPrompt,
            temperature: 0.3,
            maxTokens: 2000,
          });
          if (Array.isArray(result)) {
            for (const service of result) {
              if (!seenNames.has(service.name)) {
                seenNames.add(service.name);
                allServices.push(service);
              }
            }
          }
        } catch (error) {
          logger.warning(`Stage 3: failed to analyze ${file.path}${chunkNote}: ${(error as Error).message}`);
        }
      }
    }

    const stageResult: StageResult<ExtractedService[]> = {
      stage: 'services',
      success: true,
      data: allServices,
      tokens: this.llm.getTokenUsage().totalTokens,
      duration: Date.now() - startTime,
    };

    if (this.options.saveIntermediate) {
      await this.saveResult('stage3-services', stageResult);
    }

    return stageResult;
  }

  /**
   * Stage 4: API Extraction
   */
  private async runStage4(
    apiFiles: Array<{ path: string; content: string }>
  ): Promise<StageResult<ExtractedEndpoint[]>> {
    const startTime = Date.now();

    const filesContent = apiFiles
      .slice(0, 10)
      .map(f => `=== ${f.path} ===\n${f.content}`)
      .join('\n\n');

    const userPrompt = `Analyze these API/route files and extract endpoints:

${filesContent}`;

    try {
      const result = await this.llm.completeJSON<ExtractedEndpoint[]>({
        systemPrompt: PROMPTS.stage4_api,
        userPrompt,
        temperature: 0.3,
        maxTokens: 2000,
      });

      const stageResult: StageResult<ExtractedEndpoint[]> = {
        stage: 'api',
        success: true,
        data: Array.isArray(result) ? result : [],
        tokens: this.llm.getTokenUsage().totalTokens,
        duration: Date.now() - startTime,
      };

      if (this.options.saveIntermediate) {
        await this.saveResult('stage4-api', stageResult);
      }

      return stageResult;
    } catch (error) {
      return {
        stage: 'api',
        success: false,
        error: (error as Error).message,
        data: [],
        tokens: 0,
        duration: Date.now() - startTime,
      };
    }
  }

  /**
   * Stage 5: Architecture Synthesis
   */
  private async runStage5(
    survey: ProjectSurveyResult,
    entities: ExtractedEntity[],
    services: ExtractedService[],
    endpoints: ExtractedEndpoint[],
    depGraph?: DependencyGraphResult
  ): Promise<StageResult<ArchitectureSynthesis>> {
    const startTime = Date.now();

    const userPrompt = `Synthesize the architecture from this analysis:

Entities (${entities.length}):
${entities.map(e => `- ${e.name}: ${e.description}`).join('\n')}

Services (${services.length}):
${services.map(s => `- ${s.name}: ${s.purpose}`).join('\n')}

Endpoints (${endpoints.length}):
${endpoints.map(e => `- ${e.method} ${e.path}: ${e.purpose}`).join('\n')}

${depGraph ? `Dependency Graph:
- Nodes: ${depGraph.statistics.nodeCount}
- Edges: ${depGraph.statistics.edgeCount}
- Clusters: ${depGraph.statistics.clusterCount}
- Cycles: ${depGraph.statistics.cycleCount}` : ''}`;

    try {
      const result = await this.llm.completeJSON<ArchitectureSynthesis>({
        systemPrompt: PROMPTS.stage5_architecture(survey),
        userPrompt,
        temperature: 0.3,
        maxTokens: 2000,
      });

      const stageResult: StageResult<ArchitectureSynthesis> = {
        stage: 'architecture',
        success: true,
        data: result,
        tokens: this.llm.getTokenUsage().totalTokens,
        duration: Date.now() - startTime,
      };

      if (this.options.saveIntermediate) {
        await this.saveResult('stage5-architecture', stageResult);
      }

      return stageResult;
    } catch (error) {
      return {
        stage: 'architecture',
        success: false,
        error: (error as Error).message,
        tokens: 0,
        duration: Date.now() - startTime,
      };
    }
  }

  /**
   * Stage 6: ADR Enrichment
   */
  private async runStage6(
    architecture: ArchitectureSynthesis
  ): Promise<StageResult<EnrichedADR[]>> {
    const startTime = Date.now();

    const userPrompt = `Expand these ${architecture.keyDecisions.length} architectural decisions into full ADRs:

${architecture.keyDecisions.map((d, i) => `${i + 1}. ${d}`).join('\n')}`;

    try {
      const result = await this.llm.completeJSON<EnrichedADR[]>({
        systemPrompt: PROMPTS.stage6_adr(architecture),
        userPrompt,
        temperature: 0.3,
        maxTokens: 3000,
      });

      const stageResult: StageResult<EnrichedADR[]> = {
        stage: 'adr',
        success: true,
        data: result,
        tokens: this.llm.getTokenUsage().totalTokens,
        duration: Date.now() - startTime,
      };

      if (this.options.saveIntermediate) {
        await this.saveResult('stage6-adr-enrichment', stageResult);
      }

      return stageResult;
    } catch (error) {
      return {
        stage: 'adr',
        success: false,
        error: (error as Error).message,
        tokens: 0,
        duration: Date.now() - startTime,
      };
    }
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
   * Falls back to the provided heuristic list if no LLM-identified paths match.
   */
  private resolveFiles(
    context: LLMContext,
    llmPaths: string[],
    fallback: Array<{ path: string; content: string }>
  ): Array<{ path: string; content: string }> {
    if (llmPaths.length === 0) return fallback;

    const allFiles = context.phase2_deep.files;
    const resolved = llmPaths
      .map(p => allFiles.find(f => f.path === p || f.path.endsWith('/' + p) || p.endsWith('/' + f.path)))
      .filter((f): f is (typeof allFiles)[0] => f !== undefined)
      .map(f => ({ path: f.path, content: f.content ?? '' }))
      .filter(f => f.content.length > 0);

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
  private async saveResult(name: string, data: unknown): Promise<void> {
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
