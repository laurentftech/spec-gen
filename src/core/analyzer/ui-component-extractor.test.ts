/**
 * UI Component Extractor Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extractUIComponents, summarizeUIComponents } from './ui-component-extractor.js';

// ============================================================================
// HELPERS
// ============================================================================

async function createTempDir(): Promise<string> {
  const dir = join(tmpdir(), `ui-extractor-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function createFile(dir: string, name: string, content: string): Promise<string> {
  const filePath = join(dir, name);
  const parts = name.split('/');
  if (parts.length > 1) {
    await mkdir(join(dir, ...parts.slice(0, -1)), { recursive: true });
  }
  await writeFile(filePath, content, 'utf-8');
  return filePath;
}

// ============================================================================
// TESTS
// ============================================================================

describe('extractUIComponents', () => {
  let tmpDir: string;

  beforeEach(async () => { tmpDir = await createTempDir(); });
  afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

  // ── React ──────────────────────────────────────────────────────────────────

  it('detects a React function component', async () => {
    const fp = await createFile(tmpDir, 'Button.tsx', `
import React from 'react';

interface ButtonProps {
  label: string;
  disabled?: boolean;
}

export function Button({ label, disabled }: ButtonProps) {
  return <button disabled={disabled}>{label}</button>;
}
`);
    const components = await extractUIComponents([fp], tmpDir);
    expect(components).toHaveLength(1);
    expect(components[0].name).toBe('Button');
    expect(components[0].framework).toBe('react');
    expect(components[0].isDefault).toBe(false);
    expect(components[0].props.some(p => p.name === 'label')).toBe(true);
    expect(components[0].props.some(p => p.name === 'disabled')).toBe(true);
  });

  it('detects a React default export function component', async () => {
    const fp = await createFile(tmpDir, 'Page.tsx', `
export default function Page() {
  return <div>Hello</div>;
}
`);
    const components = await extractUIComponents([fp], tmpDir);
    expect(components).toHaveLength(1);
    expect(components[0].name).toBe('Page');
    expect(components[0].isDefault).toBe(true);
  });

  it('detects a React arrow component', async () => {
    const fp = await createFile(tmpDir, 'Card.tsx', `
export const Card = ({ title }: { title: string }) => {
  return <div>{title}</div>;
};
`);
    const components = await extractUIComponents([fp], tmpDir);
    expect(components).toHaveLength(1);
    expect(components[0].name).toBe('Card');
    expect(components[0].framework).toBe('react');
  });

  it('skips lowercase-named exports (non-component)', async () => {
    const fp = await createFile(tmpDir, 'util.tsx', `
export function helper() { return 42; }
export const foo = () => <span />;
`);
    const components = await extractUIComponents([fp], tmpDir);
    expect(components).toHaveLength(0);
  });

  // ── Vue ────────────────────────────────────────────────────────────────────

  it('detects a Vue SFC component', async () => {
    const fp = await createFile(tmpDir, 'MyCard.vue', `
<template>
  <div>{{ title }}</div>
</template>
<script setup lang="ts">
defineProps<{ title: string; count?: number }>();
</script>
`);
    const components = await extractUIComponents([fp], tmpDir);
    expect(components).toHaveLength(1);
    expect(components[0].name).toBe('MyCard');
    expect(components[0].framework).toBe('vue');
    expect(components[0].isDefault).toBe(true);
    expect(components[0].props.some(p => p.name === 'title')).toBe(true);
  });

  it('skips lowercase Vue files', async () => {
    const fp = await createFile(tmpDir, 'mycard.vue', `<template><div/></template>`);
    const components = await extractUIComponents([fp], tmpDir);
    expect(components).toHaveLength(0);
  });

  // ── Svelte ─────────────────────────────────────────────────────────────────

  it('detects a Svelte component', async () => {
    const fp = await createFile(tmpDir, 'Modal.svelte', `
<script>
  export let title = '';
  export let open = false;
</script>
<dialog>{title}</dialog>
`);
    const components = await extractUIComponents([fp], tmpDir);
    expect(components).toHaveLength(1);
    expect(components[0].name).toBe('Modal');
    expect(components[0].framework).toBe('svelte');
    expect(components[0].props.some(p => p.name === 'title')).toBe(true);
    expect(components[0].props.some(p => p.name === 'open')).toBe(true);
  });

  // ── Angular ────────────────────────────────────────────────────────────────

  it('detects an Angular component', async () => {
    const fp = await createFile(tmpDir, 'hero.component.ts', `
import { Component } from '@angular/core';

@Component({ selector: 'app-hero', template: '<h1>Hero</h1>' })
export class HeroComponent {
  name = 'Superman';
}
`);
    const components = await extractUIComponents([fp], tmpDir);
    expect(components).toHaveLength(1);
    expect(components[0].name).toBe('HeroComponent');
    expect(components[0].framework).toBe('angular');
  });

  // ── React.memo ─────────────────────────────────────────────────────────────

  it('detects a React.memo(...) wrapped component', async () => {
    const fp = await createFile(tmpDir, 'MemoButton.tsx', `
import React from 'react';

interface MemoButtonProps {
  label: string;
}

const MemoButtonInner = ({ label }: MemoButtonProps) => {
  return <button>{label}</button>;
};

export const MemoButton = React.memo(MemoButtonInner);
`);
    const components = await extractUIComponents([fp], tmpDir);
    // Should detect at least one component from the file
    expect(components.length).toBeGreaterThanOrEqual(1);
    const names = components.map(c => c.name);
    // Either MemoButtonInner or MemoButton should be detected
    expect(names.some(n => n.includes('Memo') || n.includes('Button'))).toBe(true);
    expect(components[0].framework).toBe('react');
  });

  // ── Multiple components in same file ───────────────────────────────────────

  it('detects multiple components exported from the same .tsx file', async () => {
    const fp = await createFile(tmpDir, 'Components.tsx', `
export function Header({ title }: { title: string }) {
  return <h1>{title}</h1>;
}

export function Footer({ text }: { text: string }) {
  return <footer>{text}</footer>;
}

export const Sidebar = ({ items }: { items: string[] }) => {
  return <aside>{items.join(',')}</aside>;
};
`);
    const components = await extractUIComponents([fp], tmpDir);
    expect(components.length).toBeGreaterThanOrEqual(2);
    const names = components.map(c => c.name);
    expect(names).toContain('Header');
    expect(names).toContain('Footer');
  });

  // ── .jsx file support ──────────────────────────────────────────────────────

  it('detects React components from .jsx file (not just .tsx)', async () => {
    const fp = await createFile(tmpDir, 'Widget.jsx', `
export function Widget({ value }) {
  return <div>{value}</div>;
}
`);
    const components = await extractUIComponents([fp], tmpDir);
    expect(components).toHaveLength(1);
    expect(components[0].name).toBe('Widget');
    expect(components[0].framework).toBe('react');
  });

  // ── Non-UI files ───────────────────────────────────────────────────────────

  it('ignores plain .ts files without @Component', async () => {
    const fp = await createFile(tmpDir, 'service.ts', `
export class UserService {
  getUser() { return null; }
}
`);
    const components = await extractUIComponents([fp], tmpDir);
    expect(components).toHaveLength(0);
  });

  it('returns relative paths in file field', async () => {
    const fp = await createFile(tmpDir, 'Button.tsx', `export function Button() { return null; }`);
    const components = await extractUIComponents([fp], tmpDir);
    expect(components[0].file).toBe('Button.tsx');
    expect(components[0].file).not.toContain(tmpDir);
  });
});

describe('summarizeUIComponents', () => {
  it('counts components by framework', () => {
    const components = [
      { name: 'A', file: 'a.tsx', framework: 'react' as const, isDefault: false, line: 1, props: [] },
      { name: 'B', file: 'b.tsx', framework: 'react' as const, isDefault: false, line: 1, props: [] },
      { name: 'C', file: 'c.vue', framework: 'vue' as const, isDefault: true, line: 1, props: [] },
    ];
    const summary = summarizeUIComponents(components);
    expect(summary['react']).toBe(2);
    expect(summary['vue']).toBe(1);
    expect(summary['svelte']).toBeUndefined();
  });
});
