/**
 * Stage 3: Service Analysis
 *
 * Extracts services/modules from business logic files.
 */

import logger from '../../../utils/logger.js';
import { PROMPTS } from '../prompts.js';
import type { ExtractedEntity, ExtractedService, StageResult, PipelineContext, ProjectSurveyResult } from '../../../types/pipeline.js';
import { astChunkContent } from '../../analyzer/ast-chunker.js';

export async function runStage3(
  pipeline: PipelineContext,
  survey: ProjectSurveyResult,
  entities: ExtractedEntity[],
  serviceFiles: Array<{ path: string; content: string }>,
  onFile?: (i: number, total: number, file: string) => void
): Promise<StageResult<ExtractedService[]>> {
  const startTime = Date.now();
  const entityNames = entities.map(e => e.name);
  const systemPrompt = PROMPTS.stage3_services(survey.projectCategory, entityNames, survey.suggestedDomains ?? []);
  const allServices: ExtractedService[] = [];
  const seenNames = new Set<string>();

  for (const [idx, file] of serviceFiles.entries()) {
    onFile?.(idx + 1, serviceFiles.length, file.path);
    const chunks = await astChunkContent(file.content, file.path, 8000);
    const isLargeFile = chunks.length > 1;
    const graphSection = pipeline.graphPromptFor(file.path, file.content);

    if (isLargeFile && !graphSection) {
      logger.warning(`Stage 3: ${file.path} too large (${chunks.length} parts) — service spec may be incomplete`);
    }

    const servicesFromFile: ExtractedService[] = [];
    const fileChunks = graphSection ? [graphSection] : chunks;
    for (let i = 0; i < fileChunks.length; i++) {
      const chunkNote = !graphSection && isLargeFile ? ` (part ${i + 1}/${fileChunks.length})` : '';
      const userPrompt = `Analyze this file and extract services/modules:\n\n=== ${file.path}${chunkNote} ===\n${fileChunks[i]}`;
      try {
        const result = await pipeline.llm.completeJSON<ExtractedService[]>({
          systemPrompt,
          userPrompt,
          temperature: 0.3,
          maxTokens: 4000,
        });
        if (Array.isArray(result)) {
          for (const service of result) {
            if (!seenNames.has(service.name)) {
              seenNames.add(service.name);
              servicesFromFile.push(service);
            }
          }
        }
      } catch (error) {
        logger.warning(`Stage 3: failed to analyze ${file.path}${chunkNote}: ${(error as Error).message}`);
      }
    }
    if (isLargeFile && !graphSection) {
      for (const service of servicesFromFile) {
        service.purpose = `[PARTIAL SPEC — file too large to fully analyze (${chunks.length} parts)] ${service.purpose}`;
      }
    }

    // For god-function files analyzed via graph, generate hierarchical sub-specs
    if (graphSection && servicesFromFile.length > 0) {
      for (const service of servicesFromFile) {
        const subSpecs = await pipeline.generateSubSpecs(file.path, service.name, service.purpose);
        if (subSpecs.length > 0) {
          service.subSpecs = subSpecs;
        }
      }
    }

    allServices.push(...servicesFromFile);
  }

  const stageResult: StageResult<ExtractedService[]> = {
    stage: 'services',
    success: true,
    data: allServices,
    tokens: pipeline.llm.getTokenUsage().totalTokens,
    duration: Date.now() - startTime,
  };

  if (pipeline.options.saveIntermediate) {
    await pipeline.saveResult('stage3-services', stageResult);
  }

  return stageResult;
}
