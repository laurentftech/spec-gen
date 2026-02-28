/**
 * spec-gen Programmatic API
 *
 * This is the public API surface for spec-gen. Consumers (like OpenSpec CLI)
 * can import these functions to use spec-gen as a library.
 *
 * @example
 * ```typescript
 * import { specGenRun, specGenDrift } from 'spec-gen';
 *
 * // Run the full pipeline
 * const result = await specGenRun({
 *   rootPath: '/path/to/project',
 *   onProgress: (event) => console.log(event.step),
 * });
 *
 * // Check for drift
 * const drift = await specGenDrift({ rootPath: '/path/to/project' });
 * if (drift.hasDrift) {
 *   console.warn(`${drift.summary.total} drift issues found`);
 * }
 * ```
 */

// API functions
export { specGenInit } from './init.js';
export { specGenAnalyze } from './analyze.js';
export { specGenGenerate } from './generate.js';
export { specGenVerify } from './verify.js';
export { specGenDrift } from './drift.js';
export { specGenRun } from './run.js';

// API option/result types
export type {
  ProgressCallback,
  ProgressEvent,
  BaseOptions,
  InitApiOptions,
  InitResult,
  AnalyzeApiOptions,
  AnalyzeResult,
  GenerateApiOptions,
  GenerateResult,
  VerifyApiOptions,
  VerifyResult,
  DriftApiOptions,
  RunApiOptions,
  RunResult,
} from './types.js';

// Re-export key core types that consumers will need
export type { DriftResult, DriftIssue, DriftSeverity, SpecGenConfig } from '../types/index.js';
export type { RepositoryMap } from './types.js';
export type { DependencyGraphResult } from '../core/analyzer/dependency-graph.js';
export type { PipelineResult } from '../core/generator/spec-pipeline.js';
export type { GenerationReport } from '../core/generator/openspec-writer.js';
export type { VerificationReport } from '../core/verifier/verification-engine.js';
