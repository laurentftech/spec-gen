/**
 * Unit tests for Stage 5: Architecture Synthesis
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runStage5 } from './stage5-architecture.js';
import { createMockLLMService } from '../../services/llm-service.js';
import type { ArchitectureSynthesis, ProjectSurveyResult, ExtractedEntity, ExtractedService, ExtractedEndpoint, PipelineContext } from '../../../types/pipeline.js';
import type { DependencyGraphResult } from '../../analyzer/dependency-graph.js';
import type { SerializedCallGraph } from '../../analyzer/call-graph.js';

// ============================================================================
// MOCKS
// ============================================================================

vi.mock('../../utils/logger.js', () => ({
  default: {
    analysis: vi.fn(),
    debug: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
}));

// ============================================================================
// FIXTURES
// ============================================================================

const MOCK_SURVEY: ProjectSurveyResult = {
  projectCategory: 'api-service',
  primaryLanguage: 'TypeScript',
  frameworks: ['Express', 'TypeORM'],
  architecturePattern: 'layered',
  domainSummary: 'A user management API service',
  suggestedDomains: ['user', 'auth'],
  confidence: 0.9,
  schemaFiles: [],
  serviceFiles: [],
  apiFiles: [],
};

const MOCK_ENTITIES: ExtractedEntity[] = [
  {
    name: 'User',
    description: 'Represents a user',
    properties: [
      { name: 'id', type: 'string', required: true },
      { name: 'email', type: 'string', required: true },
    ],
    relationships: [],
    validations: ['Email must be unique'],
    scenarios: [{ name: 'Create user', given: 'valid data', when: 'create() called', then: 'user created' }],
    location: 'models/user.ts',
  },
];

const MOCK_SERVICES: ExtractedService[] = [
  {
    name: 'UserService',
    purpose: 'Manages user business logic',
    operations: [
      {
        name: 'createUser',
        description: 'Creates a new user',
        inputs: ['email: string'],
        outputs: ['userId: string'],
        scenarios: [{ name: 'Valid creation', given: 'unique email', when: 'createUser()', then: 'user created' }],
        functionName: 'createUser',
      },
    ],
    dependencies: ['UserRepository'],
    sideEffects: ['database write'],
    domain: 'user',
  },
];

const MOCK_ENDPOINTS: ExtractedEndpoint[] = [
  {
    method: 'POST',
    path: '/users',
    purpose: 'Create user',
    authentication: 'Bearer token',
    scenarios: [{ name: 'Success', given: 'valid token', when: 'POST /users', then: '201 Created' }],
    responseSchema: { userId: 'string' },
  },
];

const MOCK_DEP_GRAPH: DependencyGraphResult = {
  nodes: [],
  edges: [],
  clusters: [],
  rankings: {
    byImportance: [],
    byConnectivity: [],
    clusterCenters: [],
    leafNodes: [],
    bridgeNodes: [],
    orphanNodes: [],
  },
  cycles: [],
  statistics: {
    nodeCount: 100,
    edgeCount: 150,
    avgDegree: 3,
    density: 0.15,
    clusterCount: 5,
    cycleCount: 0,
  },
};

const MOCK_CALL_GRAPH: SerializedCallGraph = {
  nodes: [],
  edges: [],
  hubFunctions: [
    { 
      id: 'node1', 
      name: 'processRequest', 
      filePath: 'src/server.ts', 
      fanIn: 10, 
      fanOut: 3, 
      className: 'Server',
      isAsync: false,
      language: 'TypeScript',
      startIndex: 0,
      endIndex: 100
    },
    { 
      id: 'node2', 
      name: 'dispatch', 
      filePath: 'src/router.ts', 
      fanIn: 8, 
      fanOut: 5,
      isAsync: false,
      language: 'TypeScript',
      startIndex: 0,
      endIndex: 80
    },
  ],
  entryPoints: [
    { 
      id: 'node3', 
      name: 'main', 
      filePath: 'src/index.ts', 
      isAsync: false, 
      language: 'TypeScript', 
      startIndex: 0, 
      endIndex: 50, 
      fanIn: 0, 
      fanOut: 5 
    },
    { 
      id: 'node4', 
      name: 'handleRequest', 
      filePath: 'src/http.ts', 
      isAsync: true, 
      language: 'TypeScript', 
      startIndex: 0, 
      endIndex: 120, 
      fanIn: 0, 
      fanOut: 2 
    },
  ],
  layerViolations: [
    { callerId: 'a', calleeId: 'b', callerLayer: 'Service', calleeLayer: 'API', reason: 'Service depends on route' },
  ],
  stats: {
    totalNodes: 50,
    totalEdges: 80,
    avgFanIn: 1.6,
    avgFanOut: 1.6,
  },
};

const MOCK_ARCHITECTURE_RESULT: ArchitectureSynthesis = {
  systemPurpose: 'User management API with authentication',
  architectureStyle: 'Layered architecture with clear separation of concerns',
  layerMap: [
    { name: 'API', purpose: 'HTTP routing', components: ['routes/'] },
    { name: 'Service', purpose: 'Business logic', components: ['services/'] },
    { name: 'Data', purpose: 'Database access', components: ['models/'] },
  ],
  dataFlow: 'HTTP request → route → service → repository → database',
  integrations: ['PostgreSQL', 'Redis'],
  securityModel: 'JWT Bearer tokens',
  keyDecisions: ['Use TypeORM', 'JWT auth'],
  nodeRoles: [
    { id: 'node1', role: 'orchestrator', confidence: 0.9 },
    { id: 'node2', role: 'controller', confidence: 0.85 },
    { id: 'node3', role: 'entrypoint', confidence: 0.95 },
    { id: 'node4', role: 'controller', confidence: 0.8 },
  ],
};

function createMockPipelineContext() {
  const { service: llm, provider } = createMockLLMService();
  const saveResult = vi.fn().mockResolvedValue(undefined);
  const pipeline: PipelineContext = {
    llm,
    options: { saveIntermediate: false },
    saveResult,
    chunkContent: vi.fn(),
    graphPromptFor: vi.fn().mockReturnValue(null),
    generateSubSpecs: vi.fn().mockResolvedValue([]),
  };
  return { pipeline, provider, saveResult };
}

// ============================================================================
// TESTS
// ============================================================================

describe('Stage 5: Architecture Synthesis', () => {
  let pipeline: PipelineContext;
  let mockProvider: ReturnType<typeof createMockLLMService>['provider'];
  let saveResult: ReturnType<typeof createMockPipelineContext>['saveResult'];

  beforeEach(() => {
    const mock = createMockPipelineContext();
    pipeline = mock.pipeline;
    mockProvider = mock.provider;
    saveResult = mock.saveResult;
    mockProvider.reset();
  });

  it('synthesizes architecture with all inputs', async () => {
    mockProvider.setDefaultResponse(JSON.stringify(MOCK_ARCHITECTURE_RESULT));

    const result = await runStage5(
      pipeline,
      MOCK_SURVEY,
      MOCK_ENTITIES,
      MOCK_SERVICES,
      MOCK_ENDPOINTS,
      MOCK_DEP_GRAPH,
      MOCK_CALL_GRAPH
    );

    expect(result.success).toBe(true);
    expect(result.data?.systemPurpose).toBe(MOCK_ARCHITECTURE_RESULT.systemPurpose);
    expect(result.data?.architectureStyle).toBe(MOCK_ARCHITECTURE_RESULT.architectureStyle);
    expect(result.data?.layerMap.length).toBeGreaterThan(0);
    expect(result.data?.dataFlow).toContain('→');
    expect(result.data?.integrations).toContain('PostgreSQL');
    expect(result.data?.securityModel).toBe('JWT Bearer tokens');
    expect(result.data?.keyDecisions).toContain('Use TypeORM');
  });

  it('works without depGraph', async () => {
    mockProvider.setDefaultResponse(JSON.stringify(MOCK_ARCHITECTURE_RESULT));

    const result = await runStage5(
      pipeline,
      MOCK_SURVEY,
      MOCK_ENTITIES,
      MOCK_SERVICES,
      MOCK_ENDPOINTS
      // depGraph and callGraph undefined
    );

    expect(result.success).toBe(true);
    const request = mockProvider.callHistory[0];
    expect(request.userPrompt).not.toContain('Dependency Graph:');
  });

  it('works without callGraph', async () => {
    mockProvider.setDefaultResponse(JSON.stringify(MOCK_ARCHITECTURE_RESULT));

    const result = await runStage5(
      pipeline,
      MOCK_SURVEY,
      MOCK_ENTITIES,
      MOCK_SERVICES,
      MOCK_ENDPOINTS,
      MOCK_DEP_GRAPH
      // callGraph undefined
    );

    expect(result.success).toBe(true);
    const request = mockProvider.callHistory[0];
    expect(request.userPrompt).not.toContain('Call Graph');
  });

  it('includes depGraph statistics in prompt', async () => {
    mockProvider.setDefaultResponse(JSON.stringify(MOCK_ARCHITECTURE_RESULT));

    await runStage5(pipeline, MOCK_SURVEY, MOCK_ENTITIES, MOCK_SERVICES, MOCK_ENDPOINTS, MOCK_DEP_GRAPH);

    const request = mockProvider.callHistory[0];
    const userPrompt = request.userPrompt;
    expect(userPrompt).toContain('Dependency Graph:');
    expect(userPrompt).toContain(`Nodes: ${MOCK_DEP_GRAPH.statistics.nodeCount}`);
    expect(userPrompt).toContain(`Edges: ${MOCK_DEP_GRAPH.statistics.edgeCount}`);
    expect(userPrompt).toContain(`Clusters: ${MOCK_DEP_GRAPH.statistics.clusterCount}`);
    expect(userPrompt).toContain(`Cycles: ${MOCK_DEP_GRAPH.statistics.cycleCount}`);
  });

  it('includes callGraph details when provided', async () => {
    mockProvider.setDefaultResponse(JSON.stringify(MOCK_ARCHITECTURE_RESULT));

    await runStage5(pipeline, MOCK_SURVEY, MOCK_ENTITIES, MOCK_SERVICES, MOCK_ENDPOINTS, undefined, MOCK_CALL_GRAPH);

    const request = mockProvider.callHistory[0];
    const userPrompt = request.userPrompt;
    expect(userPrompt).toContain('Call Graph (static analysis');
    expect(userPrompt).toContain(`${MOCK_CALL_GRAPH.stats.totalNodes} functions`);
    expect(userPrompt).toContain(`${MOCK_CALL_GRAPH.stats.totalEdges} internal calls`);
    expect(userPrompt).toContain('Hub functions');
    expect(userPrompt).toContain('processRequest');
    expect(userPrompt).toContain('Entry points');
    expect(userPrompt).toContain('main');
    expect(userPrompt).toContain('Layer violations detected');
    expect(userPrompt).toContain('Service depends on route');
  });

  it('saves intermediate result when saveIntermediate is true', async () => {
    mockProvider.setDefaultResponse(JSON.stringify(MOCK_ARCHITECTURE_RESULT));
    pipeline.options.saveIntermediate = true;

    await runStage5(pipeline, MOCK_SURVEY, MOCK_ENTITIES, MOCK_SERVICES, MOCK_ENDPOINTS);

    expect(saveResult).toHaveBeenCalledWith('stage5-architecture', expect.objectContaining({
      stage: 'architecture',
      success: true,
    }));
  });

  it('does not save intermediate when saveIntermediate is false', async () => {
    mockProvider.setDefaultResponse(JSON.stringify(MOCK_ARCHITECTURE_RESULT));
    pipeline.options.saveIntermediate = false;

    await runStage5(pipeline, MOCK_SURVEY, MOCK_ENTITIES, MOCK_SERVICES, MOCK_ENDPOINTS);

    expect(saveResult).not.toHaveBeenCalled();
  });

  it('handles LLM errors and returns failure StageResult', async () => {
    pipeline.llm = { ...pipeline.llm, completeJSON: vi.fn().mockRejectedValue(new Error('LLM timeout')) } as any;

    const result = await runStage5(pipeline, MOCK_SURVEY, MOCK_ENTITIES, MOCK_SERVICES, MOCK_ENDPOINTS);

    expect(result.success).toBe(false);
    expect(result.error).toBe('LLM timeout');
    expect(result.data).toBeUndefined();
    expect(result.tokens).toBe(0);
    expect(result.duration).toBeGreaterThanOrEqual(0);
    expect(result.stage).toBe('architecture');
  });

  it('constructs correct userPrompt with all entity, service, endpoint info', async () => {
    mockProvider.setDefaultResponse(JSON.stringify(MOCK_ARCHITECTURE_RESULT));

    await runStage5(pipeline, MOCK_SURVEY, MOCK_ENTITIES, MOCK_SERVICES, MOCK_ENDPOINTS, MOCK_DEP_GRAPH);

    const request = mockProvider.callHistory[0];
    const userPrompt = request.userPrompt;
    expect(userPrompt).toContain('Synthesize the architecture from this analysis:');
    expect(userPrompt).toContain(`Entities (${MOCK_ENTITIES.length}):`);
    expect(userPrompt).toContain(`- ${MOCK_ENTITIES[0].name}: ${MOCK_ENTITIES[0].description}`);
    expect(userPrompt).toContain(`Services (${MOCK_SERVICES.length}):`);
    expect(userPrompt).toContain(`- ${MOCK_SERVICES[0].name}: ${MOCK_SERVICES[0].purpose}`);
    expect(userPrompt).toContain(`Endpoints (${MOCK_ENDPOINTS.length}):`);
    expect(userPrompt).toContain(`- ${MOCK_ENDPOINTS[0].method} ${MOCK_ENDPOINTS[0].path}: ${MOCK_ENDPOINTS[0].purpose}`);
  });

  it('returns proper StageResult shape on success', async () => {
    mockProvider.setDefaultResponse(JSON.stringify(MOCK_ARCHITECTURE_RESULT));

    const result = await runStage5(pipeline, MOCK_SURVEY, MOCK_ENTITIES, MOCK_SERVICES, MOCK_ENDPOINTS);

    expect(result).toEqual({
      stage: 'architecture',
      success: true,
      data: MOCK_ARCHITECTURE_RESULT,
      tokens: expect.any(Number),
      duration: expect.any(Number),
    });
  });

  it('includes nodes-to-classify section in prompt when callGraph provided', async () => {
    mockProvider.setDefaultResponse(JSON.stringify(MOCK_ARCHITECTURE_RESULT));

    await runStage5(pipeline, MOCK_SURVEY, MOCK_ENTITIES, MOCK_SERVICES, MOCK_ENDPOINTS, undefined, MOCK_CALL_GRAPH);

    const { userPrompt } = mockProvider.callHistory[0];
    expect(userPrompt).toContain('Nodes to classify');
    expect(userPrompt).toContain('id=node1');
    expect(userPrompt).toContain('id=node3');
    // Should not exceed 40 nodes
    const matches = userPrompt.match(/id=node/g) ?? [];
    expect(matches.length).toBeLessThanOrEqual(40);
  });

  it('omits nodes-to-classify section when no callGraph', async () => {
    mockProvider.setDefaultResponse(JSON.stringify(MOCK_ARCHITECTURE_RESULT));

    await runStage5(pipeline, MOCK_SURVEY, MOCK_ENTITIES, MOCK_SERVICES, MOCK_ENDPOINTS);

    const { userPrompt } = mockProvider.callHistory[0];
    expect(userPrompt).not.toContain('Nodes to classify');
  });

  it('deduplicates nodes that appear in both hubFunctions and entryPoints', async () => {
    const overlappingCallGraph: SerializedCallGraph = {
      ...MOCK_CALL_GRAPH,
      hubFunctions: [{ ...MOCK_CALL_GRAPH.hubFunctions[0], id: 'shared-node' }],
      entryPoints: [{ ...MOCK_CALL_GRAPH.entryPoints[0], id: 'shared-node' }],
    };
    mockProvider.setDefaultResponse(JSON.stringify(MOCK_ARCHITECTURE_RESULT));

    await runStage5(pipeline, MOCK_SURVEY, MOCK_ENTITIES, MOCK_SERVICES, MOCK_ENDPOINTS, undefined, overlappingCallGraph);

    const { userPrompt } = mockProvider.callHistory[0];
    const count = (userPrompt.match(/id=shared-node/g) ?? []).length;
    expect(count).toBe(1);
  });

  it('returns nodeRoles from LLM response', async () => {
    mockProvider.setDefaultResponse(JSON.stringify(MOCK_ARCHITECTURE_RESULT));

    const result = await runStage5(pipeline, MOCK_SURVEY, MOCK_ENTITIES, MOCK_SERVICES, MOCK_ENDPOINTS, undefined, MOCK_CALL_GRAPH);

    expect(result.success).toBe(true);
    expect(result.data?.nodeRoles).toHaveLength(4);
    expect(result.data?.nodeRoles?.[0]).toEqual({ id: 'node1', role: 'orchestrator', confidence: 0.9 });
    expect(result.data?.nodeRoles?.[2]).toEqual({ id: 'node3', role: 'entrypoint', confidence: 0.95 });
  });

  it('succeeds when LLM omits nodeRoles (backward compat)', async () => {
    const resultWithoutRoles = { ...MOCK_ARCHITECTURE_RESULT };
    delete (resultWithoutRoles as any).nodeRoles;
    mockProvider.setDefaultResponse(JSON.stringify(resultWithoutRoles));

    const result = await runStage5(pipeline, MOCK_SURVEY, MOCK_ENTITIES, MOCK_SERVICES, MOCK_ENDPOINTS, undefined, MOCK_CALL_GRAPH);

    expect(result.success).toBe(true);
    expect(result.data?.nodeRoles).toBeUndefined();
  });


  it('uses survey data to prompt correctly', async () => {
    mockProvider.setDefaultResponse(JSON.stringify(MOCK_ARCHITECTURE_RESULT));

    await runStage5(pipeline, MOCK_SURVEY, MOCK_ENTITIES, MOCK_SERVICES, MOCK_ENDPOINTS);

    const request = mockProvider.callHistory[0];
    const systemPrompt = request.systemPrompt;
    expect(systemPrompt).toContain(MOCK_SURVEY.domainSummary);
    expect(systemPrompt).toContain(MOCK_SURVEY.architecturePattern);
    expect(systemPrompt).toContain(MOCK_SURVEY.suggestedDomains.join(', '));
  });
});
