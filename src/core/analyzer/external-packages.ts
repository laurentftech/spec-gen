/**
 * External package extractor.
 *
 * Parses package manifests (npm, pip, cargo, go) to build a flat list
 * of direct dependencies. No LLM required — pure filesystem reads.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type PackageEcosystem = 'npm' | 'pypi' | 'cargo' | 'go';

export interface ExternalPackage {
  name: string;
  version: string;
  ecosystem: PackageEcosystem;
  isDev: boolean;
}

// ============================================================================
// PARSERS
// ============================================================================

async function parseNpm(rootDir: string): Promise<ExternalPackage[]> {
  try {
    const raw = await readFile(join(rootDir, 'package.json'), 'utf-8');
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    const out: ExternalPackage[] = [];
    for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
      out.push({ name, version, ecosystem: 'npm', isDev: false });
    }
    for (const [name, version] of Object.entries(pkg.devDependencies ?? {})) {
      out.push({ name, version, ecosystem: 'npm', isDev: true });
    }
    for (const [name, version] of Object.entries(pkg.peerDependencies ?? {})) {
      if (!out.some(p => p.name === name)) {
        out.push({ name, version, ecosystem: 'npm', isDev: false });
      }
    }
    return out;
  } catch { return []; }
}

async function parsePyproject(rootDir: string): Promise<ExternalPackage[]> {
  try {
    const raw = await readFile(join(rootDir, 'pyproject.toml'), 'utf-8');
    const out: ExternalPackage[] = [];

    // PEP 621: [project] dependencies = ["requests>=2.0", ...]
    const pep621Block = raw.match(/^\[project\]\s*\n([\s\S]*?)(?=^\[)/m);
    const depsMatch = pep621Block
      ? pep621Block[1].match(/^dependencies\s*=\s*\[([^\]]*)\]/m)
      : raw.match(/^dependencies\s*=\s*\[([^\]]*)\]/m);
    if (depsMatch) {
      for (const line of depsMatch[1].split('\n')) {
        const m = line.match(/["']([a-zA-Z0-9_.-]+)([^"']*)?["']/);
        if (m) out.push({ name: m[1], version: m[2]?.trim() ?? '*', ecosystem: 'pypi', isDev: false });
      }
    }

    // Poetry: [tool.poetry.dependencies] (prod) and [tool.poetry.dev-dependencies] (dev)
    for (const [section, isDev] of [
      ['tool\\.poetry\\.dependencies', false],
      ['tool\\.poetry\\.dev-dependencies', true],
      ['tool\\.poetry\\.group\\.dev\\.dependencies', true],
    ] as const) {
      const block = raw.match(new RegExp(`\\[${section}\\]([\\s\\S]*?)(?=\\[|$)`));
      if (!block) continue;
      for (const line of block[1].split('\n')) {
        const m = line.match(/^(\w[\w-]*)\s*=\s*["']([^"']+)["']/);
        // skip python version constraint line
        if (m && m[1] !== 'python') out.push({ name: m[1], version: m[2], ecosystem: 'pypi', isDev });
      }
    }

    return out;
  } catch { return []; }
}

async function parseRequirements(rootDir: string): Promise<ExternalPackage[]> {
  const candidates = ['requirements.txt', 'requirements/base.txt', 'requirements/prod.txt', 'requirements/dev.txt'];
  const out: ExternalPackage[] = [];
  for (const candidate of candidates) {
    try {
      const raw = await readFile(join(rootDir, candidate), 'utf-8');
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) continue;
        const m = trimmed.match(/^([a-zA-Z0-9_.-]+)\s*([>=<!][^\s;#]*)?/);
        if (m) out.push({ name: m[1], version: m[2]?.trim() ?? '*', ecosystem: 'pypi', isDev: false });
      }
    } catch { /* file absent */ }
  }
  return out;
}

async function parseCargo(rootDir: string): Promise<ExternalPackage[]> {
  try {
    const raw = await readFile(join(rootDir, 'Cargo.toml'), 'utf-8');
    const out: ExternalPackage[] = [];
    // [dependencies] and [dev-dependencies]
    for (const [section, isDev] of [['dependencies', false], ['dev-dependencies', true]] as const) {
      const block = raw.match(new RegExp(`\\[${section}\\]([\\s\\S]*?)(?=\\[|$)`));
      if (!block) continue;
      for (const line of block[1].split('\n')) {
        const simple = line.match(/^(\w[\w-]*)\s*=\s*["']([^"']+)["']/);
        if (simple) { out.push({ name: simple[1], version: simple[2], ecosystem: 'cargo', isDev }); continue; }
        const inline = line.match(/^(\w[\w-]*)\s*=\s*\{[^}]*version\s*=\s*["']([^"']+)["']/);
        if (inline) out.push({ name: inline[1], version: inline[2], ecosystem: 'cargo', isDev });
      }
    }
    return out;
  } catch { return []; }
}

async function parseGoMod(rootDir: string): Promise<ExternalPackage[]> {
  try {
    const raw = await readFile(join(rootDir, 'go.mod'), 'utf-8');
    const out: ExternalPackage[] = [];
    let inRequire = false;
    for (const line of raw.split('\n')) {
      if (line.match(/^require\s*\(/)) { inRequire = true; continue; }
      if (inRequire && line.trim() === ')') { inRequire = false; continue; }
      const singleReq = line.match(/^require\s+(\S+)\s+(\S+)/);
      if (singleReq) { out.push({ name: singleReq[1], version: singleReq[2], ecosystem: 'go', isDev: false }); continue; }
      if (inRequire) {
        const m = line.trim().match(/^(\S+)\s+(\S+)/);
        if (m && !m[1].startsWith('//')) {
          out.push({ name: m[1], version: m[2], ecosystem: 'go', isDev: false });
        }
      }
    }
    return out;
  } catch { return []; }
}

// ============================================================================
// PUBLIC API
// ============================================================================

export interface ExternalPackageSummary {
  total: number;
  byEcosystem: Partial<Record<PackageEcosystem, number>>;
  packages: ExternalPackage[];
}

export async function extractExternalPackages(rootDir: string): Promise<ExternalPackageSummary> {
  const results = await Promise.all([
    parseNpm(rootDir),
    parsePyproject(rootDir),
    parseRequirements(rootDir),
    parseCargo(rootDir),
    parseGoMod(rootDir),
  ]);

  // Deduplicate by name+ecosystem
  const seen = new Set<string>();
  const packages: ExternalPackage[] = [];
  for (const batch of results) {
    for (const pkg of batch) {
      const key = `${pkg.ecosystem}:${pkg.name}`;
      if (!seen.has(key)) { seen.add(key); packages.push(pkg); }
    }
  }

  const byEcosystem: Partial<Record<PackageEcosystem, number>> = {};
  for (const pkg of packages) {
    byEcosystem[pkg.ecosystem] = (byEcosystem[pkg.ecosystem] ?? 0) + 1;
  }

  return { total: packages.length, byEcosystem, packages };
}
