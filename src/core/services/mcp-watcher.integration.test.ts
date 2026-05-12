/**
 * Integration tests for McpWatcher — real chokidar watcher + real filesystem.
 *
 * These tests start an actual FSWatcher, write files to a tmpdir, and verify
 * that llm-context.json is updated after the debounce fires.
 *
 * No embedding server required.  No mocks.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LLMContext } from '../analyzer/artifact-generator.js';
import { McpWatcher } from './mcp-watcher.js';

// ── Timing ────────────────────────────────────────────────────────────────────
//   stabilityThreshold 100ms  +  debounce 100ms  +  processing slack 200ms
const WAIT_MS = 500;
const DEBOUNCE_MS = 100;

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeContext(): LLMContext {
  return {
    phase1_survey:     { purpose: '', files: [], totalTokens: 0 },
    phase2_deep:       { purpose: '', files: [], totalTokens: 0 },
    phase3_validation: { purpose: '', files: [], totalTokens: 0 },
    signatures: [],
    callGraph: {
      nodes: [], edges: [], classes: [], inheritanceEdges: [],
      hubFunctions: [], entryPoints: [], layerViolations: [],
      stats: { totalNodes: 0, totalEdges: 0, avgFanIn: 0, avgFanOut: 0 },
    },
  };
}

async function setupProject(): Promise<{ rootPath: string; outputPath: string; contextPath: string }> {
  const rootPath   = await mkdtemp(join(tmpdir(), 'mcp-watcher-int-'));
  const outputPath = join(rootPath, '.openlore', 'analysis');
  await mkdir(outputPath, { recursive: true });
  const contextPath = join(outputPath, 'llm-context.json');
  await writeFile(contextPath, JSON.stringify(makeContext(), null, 2), 'utf-8');
  return { rootPath, outputPath, contextPath };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('McpWatcher — real fs watcher', () => {
  const watchers: McpWatcher[] = [];

  afterEach(async () => {
    for (const w of watchers) await w.stop();
    watchers.length = 0;
  });

  it('picks up a changed TypeScript file and updates llm-context.json', async () => {
    const { rootPath, outputPath, contextPath } = await setupProject();

    // Create the file BEFORE starting the watcher so the first write is a change, not an add
    const srcFile = join(rootPath, 'src', 'auth.ts');
    await mkdir(join(rootPath, 'src'), { recursive: true });
    await writeFile(srcFile, 'export function login() {}', 'utf-8');

    const watcher = new McpWatcher({ rootPath, outputPath, debounceMs: DEBOUNCE_MS });
    watchers.push(watcher);
    await watcher.start();

    // Modify the file — triggers chokidar 'change' event
    await writeFile(srcFile, 'export function login(user: string): boolean { return true; }', 'utf-8');

    await wait(WAIT_MS);

    const updated = JSON.parse(await readFile(contextPath, 'utf-8')) as LLMContext;
    const entry = updated.signatures?.find(s => s.path === 'src/auth.ts');
    expect(entry, 'signature entry for src/auth.ts should exist').toBeDefined();
    expect(entry!.language).toBe('TypeScript');
    expect(entry!.entries.some(e => e.name === 'login')).toBe(true);
  }, 10_000);

  it('preserves the callGraph after re-indexing', async () => {
    const { rootPath, outputPath, contextPath } = await setupProject();
    const original = JSON.parse(await readFile(contextPath, 'utf-8')) as LLMContext;

    const srcFile = join(rootPath, 'util.ts');
    await writeFile(srcFile, 'export function noop() {}', 'utf-8');

    const watcher = new McpWatcher({ rootPath, outputPath, debounceMs: DEBOUNCE_MS });
    watchers.push(watcher);
    await watcher.start();

    await writeFile(srcFile, 'export function noop() { /* updated */ }', 'utf-8');
    await wait(WAIT_MS);

    const updated = JSON.parse(await readFile(contextPath, 'utf-8')) as LLMContext;
    expect(updated.callGraph).toEqual(original.callGraph);
  }, 10_000);

  it('updates the entry when the same file is changed twice', async () => {
    const { rootPath, outputPath, contextPath } = await setupProject();

    const srcFile = join(rootPath, 'service.ts');
    await writeFile(srcFile, 'export function first() {}', 'utf-8');

    const watcher = new McpWatcher({ rootPath, outputPath, debounceMs: DEBOUNCE_MS });
    watchers.push(watcher);
    await watcher.start();

    // First change
    await writeFile(srcFile, 'export function second() {}', 'utf-8');
    await wait(WAIT_MS);

    const after1 = JSON.parse(await readFile(contextPath, 'utf-8')) as LLMContext;
    expect(after1.signatures?.find(s => s.path === 'service.ts')?.entries.some(e => e.name === 'second')).toBe(true);

    // Second change
    await writeFile(srcFile, 'export function third() {}', 'utf-8');
    await wait(WAIT_MS);

    const after2 = JSON.parse(await readFile(contextPath, 'utf-8')) as LLMContext;
    const entry = after2.signatures?.find(s => s.path === 'service.ts');
    expect(entry?.entries.some(e => e.name === 'third')).toBe(true);
    // No duplicate entries for the same file
    expect(after2.signatures?.filter(s => s.path === 'service.ts')).toHaveLength(1);
  }, 15_000);

  it('ignores .test.ts files', async () => {
    const { rootPath, outputPath, contextPath } = await setupProject();
    const before = await readFile(contextPath, 'utf-8');

    const testFile = join(rootPath, 'auth.test.ts');
    await writeFile(testFile, 'it("x", () => {})', 'utf-8');

    const watcher = new McpWatcher({ rootPath, outputPath, debounceMs: DEBOUNCE_MS });
    watchers.push(watcher);
    await watcher.start();

    await writeFile(testFile, 'it("y", () => {})', 'utf-8');
    await wait(WAIT_MS);

    const after = await readFile(contextPath, 'utf-8');
    expect(after).toBe(before);
  }, 10_000);
});
