/**
 * Tests for git-diff module
 */

import { describe, it, expect } from 'vitest';
import { classifyFile, isSkippableFile } from './git-diff.js';

// ============================================================================
// FILE CLASSIFICATION TESTS
// ============================================================================

describe('classifyFile', () => {
  describe('test file detection', () => {
    it('should detect .test.ts files', () => {
      const result = classifyFile('src/utils/helper.test.ts');
      expect(result.isTest).toBe(true);
    });

    it('should detect .spec.ts files', () => {
      const result = classifyFile('src/utils/helper.spec.ts');
      expect(result.isTest).toBe(true);
    });

    it('should detect files in test directories', () => {
      const result = classifyFile('tests/unit/helper.ts');
      expect(result.isTest).toBe(true);
    });

    it('should detect files in __tests__ directories', () => {
      const result = classifyFile('src/__tests__/helper.ts');
      expect(result.isTest).toBe(true);
    });

    it('should not flag regular source files as tests', () => {
      const result = classifyFile('src/core/service.ts');
      expect(result.isTest).toBe(false);
    });

    it('should detect _test suffix pattern', () => {
      const result = classifyFile('src/auth/login_test.go');
      expect(result.isTest).toBe(true);
    });
  });

  describe('config file detection', () => {
    it('should detect package.json', () => {
      const result = classifyFile('package.json');
      expect(result.isConfig).toBe(true);
    });

    it('should detect tsconfig.json', () => {
      const result = classifyFile('tsconfig.json');
      expect(result.isConfig).toBe(true);
    });

    it('should detect dotrc files', () => {
      const result = classifyFile('.eslintrc');
      expect(result.isConfig).toBe(true);
    });

    it('should detect config.ts files', () => {
      const result = classifyFile('src/config.ts');
      expect(result.isConfig).toBe(true);
    });

    it('should detect settings files', () => {
      const result = classifyFile('src/settings.json');
      expect(result.isConfig).toBe(true);
    });

    it('should not flag regular source files as config', () => {
      const result = classifyFile('src/core/service.ts');
      expect(result.isConfig).toBe(false);
    });
  });

  describe('generated file detection', () => {
    it('should detect .d.ts files', () => {
      const result = classifyFile('src/types/index.d.ts');
      expect(result.isGenerated).toBe(true);
    });

    it('should detect .generated.ts files', () => {
      const result = classifyFile('src/api/client.generated.ts');
      expect(result.isGenerated).toBe(true);
    });

    it('should detect files in /generated/ directories', () => {
      const result = classifyFile('src/generated/schema.ts');
      expect(result.isGenerated).toBe(true);
    });

    it('should detect files in /__generated__/ directories', () => {
      const result = classifyFile('src/__generated__/types.ts');
      expect(result.isGenerated).toBe(true);
    });

    it('should not flag regular source files as generated', () => {
      const result = classifyFile('src/core/service.ts');
      expect(result.isGenerated).toBe(false);
    });
  });

  describe('extension extraction', () => {
    it('should extract .ts extension', () => {
      const result = classifyFile('src/index.ts');
      expect(result.extension).toBe('.ts');
    });

    it('should extract .js extension', () => {
      const result = classifyFile('src/index.js');
      expect(result.extension).toBe('.js');
    });

    it('should extract .py extension', () => {
      const result = classifyFile('src/main.py');
      expect(result.extension).toBe('.py');
    });

    it('should handle files with multiple dots', () => {
      const result = classifyFile('src/helper.test.ts');
      expect(result.extension).toBe('.ts');
    });
  });
});

// ============================================================================
// SKIPPABLE FILE TESTS
// ============================================================================

describe('isSkippableFile', () => {
  it('should skip lock files', () => {
    expect(isSkippableFile('package-lock.json')).toBe(true);
    expect(isSkippableFile('yarn.lock')).toBe(true);
    expect(isSkippableFile('pnpm-lock.yaml')).toBe(true);
  });

  it('should skip image files', () => {
    expect(isSkippableFile('logo.png')).toBe(true);
    expect(isSkippableFile('banner.jpg')).toBe(true);
    expect(isSkippableFile('icon.svg')).toBe(true);
  });

  it('should skip font files', () => {
    expect(isSkippableFile('font.woff')).toBe(true);
    expect(isSkippableFile('font.woff2')).toBe(true);
    expect(isSkippableFile('font.ttf')).toBe(true);
  });

  it('should skip compiled files', () => {
    expect(isSkippableFile('module.pyc')).toBe(true);
    expect(isSkippableFile('lib.so')).toBe(true);
    expect(isSkippableFile('app.exe')).toBe(true);
  });

  it('should skip source maps', () => {
    expect(isSkippableFile('bundle.js.map')).toBe(true);
  });

  it('should skip .DS_Store', () => {
    expect(isSkippableFile('.DS_Store')).toBe(true);
  });

  it('should not skip source files', () => {
    expect(isSkippableFile('src/index.ts')).toBe(false);
    expect(isSkippableFile('src/main.py')).toBe(false);
    expect(isSkippableFile('README.md')).toBe(false);
  });
});
