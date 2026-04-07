import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { analyzeTestCoverage } from './coverage-analyzer.js';

const AUTH_SPEC = `# Auth

## Requirements

### Requirement: UserLogin

#### Scenario: SuccessfulLogin
- **GIVEN** a user exists
- **WHEN** POST /api/auth/login is called
- **THEN** the system returns status 200

#### Scenario: InvalidCredentials
- **GIVEN** an incorrect password
- **WHEN** POST /api/auth/login is called
- **THEN** the system returns status 401 with error "Invalid credentials"

### Requirement: UserRegistration

#### Scenario: SuccessfulRegistration
- **GIVEN** a unique email
- **WHEN** POST /api/auth/register is called
- **THEN** the system creates the user and returns a JWT with status 201
`;

// ============================================================================
// HELPERS
// ============================================================================

async function createProjectFixture(tmpDir: string): Promise<void> {
  const specDir = join(tmpDir, 'openspec', 'specs', 'auth');
  await mkdir(specDir, { recursive: true });
  await writeFile(join(specDir, 'spec.md'), AUTH_SPEC);
}

// ============================================================================
// TESTS
// ============================================================================

describe('analyzeTestCoverage', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `coverage-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
    await createProjectFixture(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('reports 0% when no test files exist', async () => {
    const report = await analyzeTestCoverage({ rootPath: tmpDir, testDirs: ['spec-tests'] });

    expect(report.totalScenarios).toBe(3);
    expect(report.coveredScenarios).toBe(0);
    expect(report.coveragePercent).toBe(0);
    expect(report.uncovered).toHaveLength(3);
    expect(report.belowThreshold).toBe(false);
  });

  it('detects tagged scenarios as covered', async () => {
    const testDir = join(tmpDir, 'spec-tests', 'auth');
    await mkdir(testDir, { recursive: true });
    const testFile = `
// spec-gen: {"domain":"auth","requirement":"UserLogin","scenario":"SuccessfulLogin","specFile":"openspec/specs/auth/spec.md"}
describe("Auth / UserLogin / SuccessfulLogin", () => {
  it("should satisfy spec scenario", async () => {
    expect(response.status).toBe(200);
  });
});
`;
    await writeFile(join(testDir, 'user-login.spec.ts'), testFile);

    const report = await analyzeTestCoverage({
      rootPath: tmpDir,
      testDirs: ['spec-tests'],
    });

    expect(report.taggedScenarios).toBe(1);
    expect(report.coveredScenarios).toBe(1);
    expect(report.uncovered).toHaveLength(2);
    expect(report.byDomain['auth'].covered).toBe(1);
    expect(report.byDomain['auth'].total).toBe(3);
  });

  it('counts coverage percentage correctly', async () => {
    const testDir = join(tmpDir, 'spec-tests', 'auth');
    await mkdir(testDir, { recursive: true });
    const testFile = `
// spec-gen: {"domain":"auth","requirement":"UserLogin","scenario":"SuccessfulLogin"}
describe("test 1") {}
// spec-gen: {"domain":"auth","requirement":"UserLogin","scenario":"InvalidCredentials"}
describe("test 2") {}
// spec-gen: {"domain":"auth","requirement":"UserRegistration","scenario":"SuccessfulRegistration"}
describe("test 3") {}
`;
    await writeFile(join(testDir, 'all.spec.ts'), testFile);

    const report = await analyzeTestCoverage({
      rootPath: tmpDir,
      testDirs: ['spec-tests'],
    });

    expect(report.coveredScenarios).toBe(3);
    expect(report.coveragePercent).toBe(100);
    expect(report.uncovered).toHaveLength(0);
  });

  it('sets belowThreshold when coverage is under minCoverage', async () => {
    const report = await analyzeTestCoverage({
      rootPath: tmpDir,
      testDirs: ['spec-tests'],
      minCoverage: 50,
    });

    expect(report.belowThreshold).toBe(true);
    expect(report.minCoverage).toBe(50);
  });

  it('does not set belowThreshold when coverage meets minCoverage', async () => {
    const testDir = join(tmpDir, 'spec-tests', 'auth');
    await mkdir(testDir, { recursive: true });
    // Cover all 3 scenarios
    await writeFile(
      join(testDir, 'full.spec.ts'),
      [
        '// spec-gen: {"domain":"auth","requirement":"UserLogin","scenario":"SuccessfulLogin"}',
        '// spec-gen: {"domain":"auth","requirement":"UserLogin","scenario":"InvalidCredentials"}',
        '// spec-gen: {"domain":"auth","requirement":"UserRegistration","scenario":"SuccessfulRegistration"}',
      ].join('\n')
    );

    const report = await analyzeTestCoverage({
      rootPath: tmpDir,
      testDirs: ['spec-tests'],
      minCoverage: 80,
    });

    expect(report.coveragePercent).toBe(100);
    expect(report.belowThreshold).toBe(false);
  });

  it('marks drifted domains in staleDomains', async () => {
    const fakeResult = {
      issues: [{ domain: 'auth', kind: 'gap', severity: 'warning', filePath: 'src/auth.ts', message: '', suggestion: '' }],
    } as any;

    const report = await analyzeTestCoverage({
      rootPath: tmpDir,
      testDirs: [],
      driftResult: fakeResult,
    });

    expect(report.staleDomains).toContain('auth');
    expect(report.byDomain['auth']?.hasDrift).toBe(true);
  });

  it('supports Python # spec-gen: tags', async () => {
    const testDir = join(tmpDir, 'spec-tests', 'auth');
    await mkdir(testDir, { recursive: true });
    await writeFile(
      join(testDir, 'auth_test.py'),
      '# spec-gen: {"domain":"auth","requirement":"UserLogin","scenario":"SuccessfulLogin"}\nclass TestAuth:\n    pass\n'
    );

    const report = await analyzeTestCoverage({
      rootPath: tmpDir,
      testDirs: ['spec-tests'],
    });

    expect(report.taggedScenarios).toBe(1);
    expect(report.covered[0].discoveredBy).toBe('tag');
  });
});
