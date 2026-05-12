/**
 * End-to-end integration tests for the Spec Verification Engine
 *
 * These tests exercise the full pipeline — real file I/O, real candidate
 * selection, real scoring — using MockLLMProvider instead of a live LLM.
 * They catch regressions that unit tests can't: file traversal bugs,
 * report serialisation issues, and scoring that looks correct in isolation
 * but breaks when the pipeline is assembled.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { verifySpecs } from './verification-engine.js';
import { MockLLMProvider, LLMService } from '../services/llm-service.js';
import type { DependencyGraphResult, DependencyNode } from '../analyzer/dependency-graph.js';
import type { ScoredFile } from '../../types/index.js';

vi.mock('../../utils/logger.js', () => ({
  default: {
    discovery: vi.fn(),
    analysis: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    blank: vi.fn(),
    debug: vi.fn(),
  },
}));

// ============================================================================
// HELPERS
// ============================================================================

function makeNode(
  relativePath: string,
  absolutePath: string,
  lines: number,
  inDegree = 2,
  outDegree = 3
): DependencyNode {
  return {
    id: relativePath,
    file: {
      path: relativePath,
      absolutePath,
      name: relativePath.split('/').pop()!,
      extension: '.ts',
      size: lines * 50,
      lines,
      depth: 2,
      directory: relativePath.split('/').slice(0, -1).join('/'),
      isEntryPoint: false,
      isConfig: false,
      isTest: false,
      isGenerated: false,
      score: 5,
      scoreBreakdown: { name: 1, path: 1, structure: 1, connectivity: 2 },
      tags: [],
    } as ScoredFile,
    exports: [{ name: 'default', isDefault: true, isType: false, isReExport: false, kind: 'class' as const, line: 1 }],
    metrics: { inDegree, outDegree, betweenness: 0.1, pageRank: 0.5 },
  };
}

function makeDepGraph(nodes: DependencyNode[]): DependencyGraphResult {
  return {
    nodes,
    edges: [],
    clusters: [],
    structuralClusters: [],
    rankings: {
      byImportance: nodes.map(n => n.file.path),
      byConnectivity: nodes.map(n => n.file.path),
      clusterCenters: [],
      leafNodes: [],
      bridgeNodes: [],
      orphanNodes: [],
    },
    cycles: [],
    statistics: {
      nodeCount: nodes.length,
      edgeCount: 0,
      importEdgeCount: 0,
      httpEdgeCount: 0,
      avgDegree: 2,
      density: 0.2,
      clusterCount: 1,
      structuralClusterCount: 0,
      cycleCount: 0,
    },
  };
}

// ============================================================================
// FIXTURES — source files and specs written to a temp directory
// ============================================================================

const PAYMENT_SERVICE_CONTENT = `/**
 * Payment Service
 *
 * Processes payment transactions, manages billing cycles,
 * and handles refund operations.
 */

import { database } from './database.js';
import { stripe } from './stripe-client.js';

export interface Payment {
  id: string;
  amount: number;
  currency: string;
}

export class PaymentService {
  async charge(amount: number, currency: string): Promise<Payment> {
    return stripe.createCharge({ amount, currency });
  }

  async refund(paymentId: string): Promise<void> {
    await stripe.refund(paymentId);
    await database.markRefunded(paymentId);
  }
}

export function createPaymentService(): PaymentService {
  return new PaymentService();
}
`;

// File whose JSDoc block starts after line 35 (after a long import section)
const LATE_DOCBLOCK_IMPORTS = Array.from(
  { length: 36 },
  (_, i) => `import { dep${i} } from './dep${i}.js';`
).join('\n');

const AUTH_SERVICE_CONTENT = `${LATE_DOCBLOCK_IMPORTS}

/**
 * Auth Service
 *
 * Handles user authentication and session management.
 */

export class AuthService {
  async login(email: string, password: string): Promise<string> {
    return 'token';
  }

  async logout(token: string): Promise<void> {}
}

export function createAuthService(): AuthService {
  return new AuthService();
}
`;

const PAYMENT_SPEC = `# Payment Domain

## Purpose

Processes payment transactions, handles billing, and manages refunds.

## Requirements

### PaymentProcessing

The system SHALL process payments using Stripe.

#### Scenario: SuccessfulCharge

- **GIVEN** a valid payment method
- **WHEN** a charge is initiated
- **THEN** funds are captured via Stripe

### RefundHandling

The system SHALL support full refunds for any payment.
`;

const AUTH_SPEC = `# Auth Domain

## Purpose

Handles user authentication, login/logout, and session token management.

## Requirements

### UserLogin

The system SHALL authenticate users with email and password.

#### Scenario: SuccessfulLogin

- **GIVEN** valid credentials
- **WHEN** login is called
- **THEN** a session token is returned
`;

// ============================================================================
// TESTS
// ============================================================================

describe('verifySpecs — end-to-end', () => {
  let testDir: string;
  let openspecDir: string;
  let specsDir: string;
  let outputDir: string;
  let srcDir: string;
  let mockProvider: MockLLMProvider;
  let llmService: LLMService;

  beforeEach(async () => {
    testDir = join(tmpdir(), `openlore-e2e-verify-${Date.now()}`);
    openspecDir = join(testDir, 'openspec');
    specsDir = join(openspecDir, 'specs');
    outputDir = join(testDir, '.openlore', 'verification');
    srcDir = join(testDir, 'src');

    await mkdir(join(specsDir, 'payment'), { recursive: true });
    await mkdir(join(specsDir, 'auth'), { recursive: true });
    await mkdir(outputDir, { recursive: true });
    await mkdir(srcDir, { recursive: true });

    await writeFile(join(specsDir, 'payment', 'spec.md'), PAYMENT_SPEC);
    await writeFile(join(specsDir, 'auth', 'spec.md'), AUTH_SPEC);
    await writeFile(join(srcDir, 'payment-service.ts'), PAYMENT_SERVICE_CONTENT);
    await writeFile(join(srcDir, 'auth-service.ts'), AUTH_SERVICE_CONTENT);

    mockProvider = new MockLLMProvider();
    llmService = new LLMService(mockProvider);
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    vi.clearAllMocks();
  });

  it('produces a report with non-zero scores for well-aligned files', async () => {
    mockProvider.setDefaultResponse(JSON.stringify({
      predictedPurpose: 'Processes payment transactions, handles billing and refunds',
      predictedImports: ['database', 'stripe'],
      predictedExports: ['PaymentService', 'Payment', 'createPaymentService'],
      predictedLogic: ['charge via stripe', 'refund and mark in database'],
      relatedRequirements: ['PaymentProcessing', 'RefundHandling'],
      confidence: 0.85,
      reasoning: 'Spec clearly describes payment operations',
    }));

    const nodes = [
      makeNode('src/payment-service.ts', join(srcDir, 'payment-service.ts'), 100),
    ];

    const report = await verifySpecs(
      llmService,
      makeDepGraph(nodes),
      { rootPath: testDir, openspecPath: openspecDir, outputDir, minComplexity: 10, maxComplexity: 500 },
      '1.0.0'
    );

    expect(report.sampledFiles).toBe(1);
    expect(report.results[0].overallScore).toBeGreaterThan(0);
    // Purpose should be non-zero — the file has a matching docblock
    expect(report.results[0].purposeMatch.similarity).toBeGreaterThan(0);
    // Requirements matched by keyword search in file content
    expect(report.results[0].requirementCoverage.coverage).toBeGreaterThanOrEqual(0);
  });

  it('extracts purpose from a file whose JSDoc starts after line 30', async () => {
    mockProvider.setDefaultResponse(JSON.stringify({
      predictedPurpose: 'Handles user authentication and session management',
      predictedImports: ['session'],
      predictedExports: ['AuthService', 'createAuthService'],
      predictedLogic: ['login with email/password', 'logout session'],
      relatedRequirements: ['UserLogin'],
      confidence: 0.8,
      reasoning: 'Auth spec describes these operations',
    }));

    const nodes = [
      makeNode('src/auth-service.ts', join(srcDir, 'auth-service.ts'), 120),
    ];

    const report = await verifySpecs(
      llmService,
      makeDepGraph(nodes),
      { rootPath: testDir, openspecPath: openspecDir, outputDir, minComplexity: 10, maxComplexity: 500 },
      '1.0.0'
    );

    expect(report.sampledFiles).toBe(1);
    // The fix: purpose similarity must be > 0 even though the JSDoc is after line 36
    expect(report.results[0].purposeMatch.actual).toContain('Auth Service');
    expect(report.results[0].purposeMatch.similarity).toBeGreaterThan(0);
  });

  it('produces separate domain breakdown entries for multiple domains', async () => {
    mockProvider.setDefaultResponse(JSON.stringify({
      predictedPurpose: 'Service handling domain operations',
      predictedImports: [],
      predictedExports: [],
      predictedLogic: [],
      relatedRequirements: [],
      confidence: 0.6,
      reasoning: 'Generic prediction',
    }));

    const nodes = [
      makeNode('src/payment/payment-service.ts', join(srcDir, 'payment-service.ts'), 100),
      makeNode('src/auth/auth-service.ts', join(srcDir, 'auth-service.ts'), 120),
    ];

    const report = await verifySpecs(
      llmService,
      makeDepGraph(nodes),
      { rootPath: testDir, openspecPath: openspecDir, outputDir, minComplexity: 10, maxComplexity: 500 },
      '1.0.0'
    );

    expect(report.sampledFiles).toBe(2);
    const domains = report.domainBreakdown.map(d => d.domain);
    expect(domains).toContain('payment');
    expect(domains).toContain('auth');
  });

  it('skips files that fail LLM prediction and excludes them from the report', async () => {
    // Malformed JSON triggers a non-retryable parse error in completeJSON
    mockProvider.setDefaultResponse('INVALID JSON {{{');

    const nodes = [
      makeNode('src/payment-service.ts', join(srcDir, 'payment-service.ts'), 100),
    ];

    const report = await verifySpecs(
      llmService,
      makeDepGraph(nodes),
      { rootPath: testDir, openspecPath: openspecDir, outputDir, minComplexity: 10, maxComplexity: 500 },
      '1.0.0'
    );

    // File was skipped — not recorded as a 0% phantom result
    expect(report.sampledFiles).toBe(0);
    expect(report.results).toHaveLength(0);
  });

  it('writes report.json and REPORT.md to the output directory', async () => {
    const { access } = await import('node:fs/promises');

    mockProvider.setDefaultResponse(JSON.stringify({
      predictedPurpose: 'Processes payments',
      predictedImports: [],
      predictedExports: ['PaymentService'],
      predictedLogic: [],
      relatedRequirements: ['PaymentProcessing'],
      confidence: 0.7,
      reasoning: 'Matches payment spec',
    }));

    const nodes = [
      makeNode('src/payment-service.ts', join(srcDir, 'payment-service.ts'), 100),
    ];

    await verifySpecs(
      llmService,
      makeDepGraph(nodes),
      { rootPath: testDir, openspecPath: openspecDir, outputDir, minComplexity: 10, maxComplexity: 500 },
      '1.0.0'
    );

    await expect(access(join(outputDir, 'report.json'))).resolves.toBeUndefined();
    await expect(access(join(outputDir, 'REPORT.md'))).resolves.toBeUndefined();
  });

  it('gives a higher score to a well-described file than one with no spec alignment', async () => {
    // Payment file: LLM prediction closely matches spec content
    mockProvider.setResponse(
      'payment-service.ts',
      JSON.stringify({
        predictedPurpose: 'Processes payment transactions, handles billing and refunds via Stripe',
        predictedImports: ['database', 'stripe'],
        predictedExports: ['PaymentService', 'Payment', 'createPaymentService'],
        predictedLogic: ['charge', 'refund'],
        relatedRequirements: ['PaymentProcessing', 'RefundHandling'],
        confidence: 0.9,
        reasoning: 'Strong match',
      })
    );

    // Auth file: LLM prediction is completely wrong (off-topic)
    mockProvider.setResponse(
      'auth-service.ts',
      JSON.stringify({
        predictedPurpose: 'Manages database migrations and schema updates',
        predictedImports: ['knex', 'pg'],
        predictedExports: ['runMigrations'],
        predictedLogic: ['migrate up', 'migrate down'],
        relatedRequirements: [],
        confidence: 0.2,
        reasoning: 'Weak match',
      })
    );

    const nodes = [
      makeNode('src/payment/payment-service.ts', join(srcDir, 'payment-service.ts'), 100, 5, 5),
      makeNode('src/auth/auth-service.ts', join(srcDir, 'auth-service.ts'), 120, 5, 5),
    ];

    const report = await verifySpecs(
      llmService,
      makeDepGraph(nodes),
      { rootPath: testDir, openspecPath: openspecDir, outputDir, minComplexity: 10, maxComplexity: 500 },
      '1.0.0'
    );

    const paymentResult = report.results.find(r => r.filePath.includes('payment'));
    const authResult = report.results.find(r => r.filePath.includes('auth'));

    expect(paymentResult).toBeDefined();
    expect(authResult).toBeDefined();

    // Well-aligned file should score higher than the misaligned one
    expect(paymentResult!.overallScore).toBeGreaterThan(authResult!.overallScore);
  });
});
