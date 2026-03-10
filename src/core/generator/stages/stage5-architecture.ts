/**
 * Stage 5: Architecture Synthesis
 *
 * Synthesizes architecture overview from previous analysis results.
 */

import { PROMPTS } from '../prompts.js';
import type {
  ArchitectureSynthesis,
  ExtractedEntity,
  ExtractedEndpoint,
  ExtractedService,
  PipelineContext,
  ProjectSurveyResult,
  StageResult,
} from '../../../types/pipeline.js';
import type { DependencyGraphResult } from '../../analyzer/dependency-graph.js';
import type { SerializedCallGraph } from '../../analyzer/call-graph.js';

export async function runStage5(
  pipeline: PipelineContext,
  survey: ProjectSurveyResult,
  entities: ExtractedEntity[],
  services: ExtractedService[],
  endpoints: ExtractedEndpoint[],
  depGraph?: DependencyGraphResult,
  callGraph?: SerializedCallGraph
): Promise<StageResult<ArchitectureSynthesis>> {
  const startTime = Date.now();

  // Top structurally-significant nodes passed to the LLM for role classification.
  // We merge hubFunctions and entryPoints, deduplicate by id, and cap at 40.
  const topNodes = [
    ...(callGraph?.hubFunctions ?? []),
    ...(callGraph?.entryPoints ?? []),
  ].filter((n, i, arr) => arr.findIndex(x => x.id === n.id) === i).slice(0, 40);

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
- Cycles: ${depGraph.statistics.cycleCount}` : ''}${callGraph && callGraph.stats.totalNodes > 0 ? `

Call Graph (static analysis — ${callGraph.stats.totalNodes} functions, ${callGraph.stats.totalEdges} internal calls):
${callGraph.hubFunctions.length > 0 ? `Hub functions (called by many others — likely integration points):
${callGraph.hubFunctions.slice(0, 8).map(n => `- ${n.name} (${n.filePath}, fanIn=${n.fanIn}, fanOut=${n.fanOut}${n.className ? `, class=${n.className}` : ''})`).join('\n')}` : ''}
${callGraph.entryPoints.length > 0 ? `\nEntry points (no internal callers — likely public API or CLI handlers):
${callGraph.entryPoints.slice(0, 8).map(n => `- ${n.name} (${n.filePath}${n.isAsync ? ', async' : ''})`).join('\n')}` : ''}
${callGraph.layerViolations.length > 0 ? `\nLayer violations detected:
${callGraph.layerViolations.slice(0, 5).map(v => `- ${v.reason}`).join('\n')}` : ''}` : ''}${topNodes.length > 0 ? `

Nodes to classify (top ${topNodes.length} structurally significant functions):
${topNodes.map(n => `- id=${n.id} name=${n.name} file=${n.filePath} fanIn=${n.fanIn} fanOut=${n.fanOut}${n.className ? ` class=${n.className}` : ''}`).join('\n')}` : ''}`;

  try {
    const result = await pipeline.llm.completeJSON<ArchitectureSynthesis>({
      systemPrompt: PROMPTS.stage5_architecture(survey),
      userPrompt,
      temperature: 0.3,
      maxTokens: 4000,
    });

    const stageResult: StageResult<ArchitectureSynthesis> = {
      stage: 'architecture',
      success: true,
      data: result,
      tokens: pipeline.llm.getTokenUsage().totalTokens,
      duration: Date.now() - startTime,
    };

    if (pipeline.options.saveIntermediate) {
      await pipeline.saveResult('stage5-architecture', stageResult);
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
