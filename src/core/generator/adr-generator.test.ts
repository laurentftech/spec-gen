/**
 * ADR Generator Tests
 */

import { describe, it, expect } from 'vitest';
import { ADRGenerator } from './adr-generator.js';
import type {
  PipelineResult,
  EnrichedADR,
  ArchitectureSynthesis,
} from './spec-pipeline.js';

// ============================================================================
// TEST HELPERS
// ============================================================================

function createMockADRs(): EnrichedADR[] {
  return [
    {
      id: 'ADR-001',
      title: 'Use TypeORM for database access',
      status: 'accepted',
      context: 'The project needs a typed ORM for database interactions with PostgreSQL.',
      decision: 'Use TypeORM as the primary ORM for all database operations.',
      consequences: [
        'Type-safe database queries',
        'Migration complexity increases',
        'Vendor lock-in to TypeORM API',
      ],
      alternatives: ['Prisma', 'Raw SQL with pg driver'],
      relatedLayers: ['Data', 'Service'],
      relatedDomains: ['user', 'auth'],
    },
    {
      id: 'ADR-002',
      title: 'JWT for stateless authentication',
      status: 'accepted',
      context: 'The system requires stateless authentication for horizontal scaling.',
      decision: 'Use JWT tokens for all API authentication.',
      consequences: ['Stateless and scalable', 'Token revocation is complex'],
      alternatives: ['Session-based auth', 'OAuth2 only'],
      relatedLayers: ['API'],
      relatedDomains: ['auth'],
    },
  ];
}

function createMockArchitecture(): ArchitectureSynthesis {
  return {
    systemPurpose: 'A user management API service',
    architectureStyle: 'Layered architecture',
    layerMap: [
      { name: 'API', purpose: 'HTTP request handling', components: ['routes/'] },
      { name: 'Service', purpose: 'Business logic', components: ['services/'] },
      { name: 'Data', purpose: 'Database access', components: ['models/'] },
    ],
    dataFlow: 'Request -> Routes -> Services -> Database',
    integrations: ['PostgreSQL'],
    securityModel: 'JWT-based authentication',
    keyDecisions: ['Use TypeORM', 'JWT auth'],
  };
}

function createMockPipelineResult(adrs?: EnrichedADR[]): PipelineResult {
  return {
    survey: {
      projectCategory: 'web-backend',
      primaryLanguage: 'TypeScript',
      frameworks: ['Express'],
      architecturePattern: 'layered',
      domainSummary: 'A user management API',
      suggestedDomains: ['user', 'auth'],
      confidence: 0.85,
      schemaFiles: [],
      serviceFiles: [],
      apiFiles: [],
    },
    entities: [],
    services: [],
    endpoints: [],
    architecture: createMockArchitecture(),
    adrs,
    metadata: {
      totalTokens: 1000,
      estimatedCost: 0.01,
      duration: 5000,
      completedStages: ['survey', 'architecture', 'adr'],
      skippedStages: [],
    },
  };
}

// ============================================================================
// TESTS
// ============================================================================

describe('ADRGenerator', () => {
  describe('generateADRs', () => {
    it('should generate individual ADR files plus index', () => {
      const generator = new ADRGenerator();
      const result = generator.generateADRs(createMockPipelineResult(createMockADRs()));

      // 2 individual ADRs + 1 index = 3 files
      expect(result).toHaveLength(3);
    });

    it('should return empty array when no ADRs', () => {
      const generator = new ADRGenerator();
      const result = generator.generateADRs(createMockPipelineResult(undefined));

      expect(result).toHaveLength(0);
    });

    it('should return empty array when ADRs array is empty', () => {
      const generator = new ADRGenerator();
      const result = generator.generateADRs(createMockPipelineResult([]));

      expect(result).toHaveLength(0);
    });

    it('should use type adr for all specs', () => {
      const generator = new ADRGenerator();
      const result = generator.generateADRs(createMockPipelineResult(createMockADRs()));

      for (const spec of result) {
        expect(spec.type).toBe('adr');
      }
    });

    it('should use decisions as domain', () => {
      const generator = new ADRGenerator();
      const result = generator.generateADRs(createMockPipelineResult(createMockADRs()));

      for (const spec of result) {
        expect(spec.domain).toBe('decisions');
      }
    });

    it('should generate correct file paths', () => {
      const generator = new ADRGenerator();
      const result = generator.generateADRs(createMockPipelineResult(createMockADRs()));

      expect(result[0].path).toBe('openspec/decisions/adr-0001-use-typeorm-for-database-access.md');
      expect(result[1].path).toBe('openspec/decisions/adr-0002-jwt-for-stateless-authentication.md');
      expect(result[2].path).toBe('openspec/decisions/index.md');
    });
  });

  describe('Single ADR', () => {
    it('should include all standard ADR sections', () => {
      const generator = new ADRGenerator();
      const result = generator.generateADRs(createMockPipelineResult(createMockADRs()));
      const adr = result[0].content;

      expect(adr).toContain('# ADR-001: Use TypeORM for database access');
      expect(adr).toContain('## Status');
      expect(adr).toContain('Accepted');
      expect(adr).toContain('## Context');
      expect(adr).toContain('## Decision');
      expect(adr).toContain('## Consequences');
      expect(adr).toContain('## Alternatives Considered');
      expect(adr).toContain('## Related');
    });

    it('should include context and decision text', () => {
      const generator = new ADRGenerator();
      const result = generator.generateADRs(createMockPipelineResult(createMockADRs()));
      const adr = result[0].content;

      expect(adr).toContain('The project needs a typed ORM');
      expect(adr).toContain('Use TypeORM as the primary ORM');
    });

    it('should list consequences as bullet points', () => {
      const generator = new ADRGenerator();
      const result = generator.generateADRs(createMockPipelineResult(createMockADRs()));
      const adr = result[0].content;

      expect(adr).toContain('- Type-safe database queries');
      expect(adr).toContain('- Migration complexity increases');
      expect(adr).toContain('- Vendor lock-in to TypeORM API');
    });

    it('should list alternatives as bullet points', () => {
      const generator = new ADRGenerator();
      const result = generator.generateADRs(createMockPipelineResult(createMockADRs()));
      const adr = result[0].content;

      expect(adr).toContain('- Prisma');
      expect(adr).toContain('- Raw SQL with pg driver');
    });

    it('should include mermaid diagram when enabled', () => {
      const generator = new ADRGenerator({ includeMermaid: true });
      const result = generator.generateADRs(createMockPipelineResult(createMockADRs()));
      const adr = result[0].content;

      expect(adr).toContain('```mermaid');
      expect(adr).toContain('graph TB');
      expect(adr).toContain('## Architecture Impact');
    });

    it('should skip mermaid diagram when disabled', () => {
      const generator = new ADRGenerator({ includeMermaid: false });
      const result = generator.generateADRs(createMockPipelineResult(createMockADRs()));
      const adr = result[0].content;

      expect(adr).not.toContain('```mermaid');
      expect(adr).not.toContain('## Architecture Impact');
    });

    it('should list related layers and domains', () => {
      const generator = new ADRGenerator();
      const result = generator.generateADRs(createMockPipelineResult(createMockADRs()));
      const adr = result[0].content;

      expect(adr).toContain('**Layers**: Data, Service');
      expect(adr).toContain('**Domains**: user, auth');
    });

    it('should include version in header', () => {
      const generator = new ADRGenerator({ version: '2.0.0' });
      const result = generator.generateADRs(createMockPipelineResult(createMockADRs()));
      const adr = result[0].content;

      expect(adr).toContain('spec-gen v2.0.0');
    });
  });

  describe('ADR Index', () => {
    it('should generate index with table of all ADRs', () => {
      const generator = new ADRGenerator();
      const result = generator.generateADRs(createMockPipelineResult(createMockADRs()));
      const index = result[2].content;

      expect(index).toContain('# Architecture Decision Records');
      expect(index).toContain('| ID | Decision | Status | Layers |');
      expect(index).toContain('ADR-001');
      expect(index).toContain('ADR-002');
    });

    it('should include links to individual ADR files', () => {
      const generator = new ADRGenerator();
      const result = generator.generateADRs(createMockPipelineResult(createMockADRs()));
      const index = result[2].content;

      expect(index).toContain('[ADR-001](./adr-0001-use-typeorm-for-database-access.md)');
      expect(index).toContain('[ADR-002](./adr-0002-jwt-for-stateless-authentication.md)');
    });

    it('should have path openspec/decisions/index.md', () => {
      const generator = new ADRGenerator();
      const result = generator.generateADRs(createMockPipelineResult(createMockADRs()));
      const index = result[2];

      expect(index.path).toBe('openspec/decisions/index.md');
    });

    it('should include About ADRs section', () => {
      const generator = new ADRGenerator();
      const result = generator.generateADRs(createMockPipelineResult(createMockADRs()));
      const index = result[2].content;

      expect(index).toContain('## About ADRs');
      expect(index).toContain('immutable records');
    });
  });

  describe('Edge Cases', () => {
    it('should handle ADR with empty consequences', () => {
      const adrs: EnrichedADR[] = [{
        id: 'ADR-001',
        title: 'Use Express',
        status: 'accepted',
        context: 'Need a framework.',
        decision: 'Use Express.',
        consequences: [],
        alternatives: [],
        relatedLayers: [],
        relatedDomains: [],
      }];

      const generator = new ADRGenerator();
      const result = generator.generateADRs(createMockPipelineResult(adrs));

      expect(result).toHaveLength(2); // 1 ADR + 1 index
      expect(result[0].content).toContain('No consequences identified.');
    });

    it('should handle ADR with empty alternatives', () => {
      const adrs: EnrichedADR[] = [{
        id: 'ADR-001',
        title: 'Use Express',
        status: 'accepted',
        context: 'Need a framework.',
        decision: 'Use Express.',
        consequences: ['Fast'],
        alternatives: [],
        relatedLayers: [],
        relatedDomains: [],
      }];

      const generator = new ADRGenerator();
      const result = generator.generateADRs(createMockPipelineResult(adrs));

      expect(result[0].content).not.toContain('## Alternatives Considered');
    });

    it('should handle special characters in title', () => {
      const adrs: EnrichedADR[] = [{
        id: 'ADR-001',
        title: 'Use C++ & Rust (v2.0) for "performance"',
        status: 'accepted',
        context: 'Performance.',
        decision: 'Use native langs.',
        consequences: ['Fast'],
        alternatives: [],
        relatedLayers: [],
        relatedDomains: [],
      }];

      const generator = new ADRGenerator();
      const result = generator.generateADRs(createMockPipelineResult(adrs));

      // File path should be safe (no special chars)
      expect(result[0].path).toMatch(/^openspec\/decisions\/adr-0001-[a-z0-9-]+\.md$/);
      // Title in content should be preserved
      expect(result[0].content).toContain('Use C++ & Rust');
    });

    it('should handle single ADR', () => {
      const adrs: EnrichedADR[] = [{
        id: 'ADR-001',
        title: 'Monolith first',
        status: 'accepted',
        context: 'Starting simple.',
        decision: 'Build as monolith.',
        consequences: ['Simple deployment'],
        alternatives: ['Microservices'],
        relatedLayers: ['API'],
        relatedDomains: [],
      }];

      const generator = new ADRGenerator();
      const result = generator.generateADRs(createMockPipelineResult(adrs));

      expect(result).toHaveLength(2); // 1 ADR + index
    });

    it('should handle ADR with no related layers for mermaid', () => {
      const adrs: EnrichedADR[] = [{
        id: 'ADR-001',
        title: 'Use UTC timestamps',
        status: 'accepted',
        context: 'Timezone handling.',
        decision: 'Store all times as UTC.',
        consequences: ['Consistent times'],
        alternatives: ['Local time'],
        relatedLayers: [],
        relatedDomains: ['user'],
      }];

      const generator = new ADRGenerator({ includeMermaid: true });
      const result = generator.generateADRs(createMockPipelineResult(adrs));

      // No Architecture Impact section since no related layers
      expect(result[0].content).not.toContain('## Architecture Impact');
    });
  });
});
