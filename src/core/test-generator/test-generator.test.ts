import { describe, it, expect } from 'vitest';
import { generateTests } from './test-generator.js';
import type { ParsedScenario } from '../../types/test-generator.js';

const MOCK_SCENARIO: ParsedScenario = {
  domain: 'auth',
  specFile: 'openspec/specs/auth/spec.md',
  requirement: 'UserLogin',
  scenarioName: 'SuccessfulLogin',
  given: ['a registered user with email "alice@test.com" and a valid password'],
  when: ['POST /api/auth/login is called with those credentials'],
  then: ['the system returns a JWT token, expiry time, and userId with status 200'],
  mappedFunctions: [],
};

const MOCK_SCENARIO_2: ParsedScenario = {
  domain: 'auth',
  specFile: 'openspec/specs/auth/spec.md',
  requirement: 'UserLogin',
  scenarioName: 'InvalidCredentials',
  given: ['an incorrect password'],
  when: ['POST /api/auth/login is called'],
  then: ['the system returns status 401 with error "Invalid credentials"'],
  mappedFunctions: [],
};

const MOCK_TASKS_SCENARIO: ParsedScenario = {
  domain: 'tasks',
  specFile: 'openspec/specs/tasks/spec.md',
  requirement: 'TaskCreation',
  scenarioName: 'ValidCreation',
  given: ['a valid title and projectId'],
  when: ['POST /api/tasks is called'],
  then: ['the system creates the task with default status "todo" and returns it with status 201'],
  mappedFunctions: [],
};

describe('generateTests', () => {
  it('generates one file per requirement', async () => {
    const files = await generateTests({
      scenarios: [MOCK_SCENARIO, MOCK_SCENARIO_2, MOCK_TASKS_SCENARIO],
      framework: 'vitest',
      outputDir: 'spec-tests',
      rootPath: '/tmp',
    });

    expect(files).toHaveLength(2); // auth/UserLogin + tasks/TaskCreation
  });

  it('generates vitest file with metadata tag', async () => {
    const [file] = await generateTests({
      scenarios: [MOCK_SCENARIO],
      framework: 'vitest',
      outputDir: 'spec-tests',
      rootPath: '/tmp',
    });

    expect(file.content).toContain('// spec-gen: ');
    expect(file.content).toContain('"domain":"auth"');
    expect(file.content).toContain('"requirement":"UserLogin"');
    expect(file.content).toContain('"scenario":"SuccessfulLogin"');
  });

  it('generates vitest file with real assertions from pattern engine', async () => {
    const [file] = await generateTests({
      scenarios: [MOCK_SCENARIO_2],
      framework: 'vitest',
      outputDir: 'spec-tests',
      rootPath: '/tmp',
    });

    expect(file.content).toContain('expect(response.status).toBe(401)');
    expect(file.content).toContain("'Invalid credentials'");
  });

  it('generates pytest file', async () => {
    const [file] = await generateTests({
      scenarios: [MOCK_SCENARIO_2],
      framework: 'pytest',
      outputDir: 'spec-tests',
      rootPath: '/tmp',
    });

    expect(file.content).toContain('import pytest');
    expect(file.content).toContain('# spec-gen: ');
    expect(file.content).toContain('assert response.status_code == 401');
    expect(file.outputPath).toMatch(/_test\.py$/);
  });

  it('generates gtest file', async () => {
    const [file] = await generateTests({
      scenarios: [MOCK_SCENARIO_2],
      framework: 'gtest',
      outputDir: 'spec-tests',
      rootPath: '/tmp',
    });

    expect(file.content).toContain('#include <gtest/gtest.h>');
    expect(file.content).toContain('TEST(');
    expect(file.content).toContain('EXPECT_EQ(response.status, 401)');
    expect(file.outputPath).toMatch(/_test\.cpp$/);
  });

  it('generates catch2 file', async () => {
    const [file] = await generateTests({
      scenarios: [MOCK_SCENARIO_2],
      framework: 'catch2',
      outputDir: 'spec-tests',
      rootPath: '/tmp',
    });

    expect(file.content).toContain('#include <catch2/catch_test_macros.hpp>');
    expect(file.content).toContain('TEST_CASE(');
    expect(file.content).toContain('REQUIRE(response.status == 401)');
  });

  it('uses correct output path for each framework', async () => {
    const vitestFiles = await generateTests({
      scenarios: [MOCK_SCENARIO],
      framework: 'vitest',
      outputDir: 'spec-tests',
      rootPath: '/tmp',
    });
    expect(vitestFiles[0].outputPath).toBe('spec-tests/auth/user-login.spec.ts');

    const pytestFiles = await generateTests({
      scenarios: [MOCK_SCENARIO],
      framework: 'pytest',
      outputDir: 'spec-tests',
      rootPath: '/tmp',
    });
    expect(pytestFiles[0].outputPath).toBe('spec-tests/auth/user_login_test.py');
  });

  it('includes G/W/T comments in output', async () => {
    const [file] = await generateTests({
      scenarios: [MOCK_SCENARIO],
      framework: 'vitest',
      outputDir: 'spec-tests',
      rootPath: '/tmp',
    });

    expect(file.content).toContain('// GIVEN:');
    expect(file.content).toContain('// WHEN:');
    expect(file.content).toContain('// THEN:');
  });
});
