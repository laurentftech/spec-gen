/**
 * Environment Variable Extractor
 *
 * Detects env vars used in a project from two complementary sources:
 *   1. Declaration files — .env.example, .env.local, .env (with optional comments)
 *   2. Source code — process.env.X (JS/TS), os.environ["X"] (Python),
 *      os.Getenv("X") (Go), ENV["X"] (Ruby)
 *
 * Variables found in declaration files are marked hasDefault=true when the
 * declaration line has a non-empty value. Variables found only in source code
 * are marked required=true (no known default).
 */

import { readFile } from 'node:fs/promises';
import { extname, relative, basename } from 'node:path';

// ============================================================================
// TYPES
// ============================================================================

export interface EnvVar {
  /** Environment variable name, e.g. DATABASE_URL */
  name: string;
  /** Relative path(s) where the variable was found */
  files: string[];
  /** True when declared in .env.example with a non-empty value */
  hasDefault: boolean;
  /** True when used in source code without a fallback (process.env.X without ?? or ||) */
  required: boolean;
  /** Inline comment from .env.example, if present */
  description?: string;
}

// ============================================================================
// ENV FILE PARSER
// ============================================================================

function parseEnvFile(content: string, relPath: string): EnvVar[] {
  const vars: EnvVar[] = [];
  let pendingComment = '';

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();

    // Accumulate comment lines as description
    if (line.startsWith('#')) {
      pendingComment = line.replace(/^#+\s*/, '');
      continue;
    }

    if (!line) {
      pendingComment = '';
      continue;
    }

    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) { pendingComment = ''; continue; }

    const name = line.slice(0, eqIdx).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) { pendingComment = ''; continue; }

    const rawValue = line.slice(eqIdx + 1).trim();
    // Strip inline comment from value
    const valueWithoutComment = rawValue.replace(/#.*$/, '').trim();
    const inlineComment = rawValue.includes('#')
      ? rawValue.slice(rawValue.indexOf('#') + 1).trim()
      : '';

    const hasDefault = valueWithoutComment.length > 0;
    const description = inlineComment || pendingComment || undefined;

    vars.push({ name, files: [relPath], hasDefault, required: false, description });
    pendingComment = '';
  }

  return vars;
}

// ============================================================================
// SOURCE CODE SCANNERS
// ============================================================================

// JS/TS: process.env.VAR_NAME or process.env['VAR_NAME'] or process.env["VAR_NAME"]
const TS_ENV_RE = /process\.env\.([A-Z_][A-Z0-9_]*)|process\.env\[['"]([A-Z_][A-Z0-9_]*)['"]]/g;
// Fallback detection: process.env.X ?? 'default' or process.env.X || 'default'
const TS_HAS_FALLBACK_RE = /process\.env\.(?:[A-Z_][A-Z0-9_]*|\[['"][A-Z_][A-Z0-9_]*['"]])\s*(?:\?\?|(?<!\|)\|\|)/;

// Python: os.environ["X"], os.environ['X'], os.environ.get("X"), os.getenv("X")
const PY_ENV_RE = /os\.environ\[['"]([A-Z_][A-Z0-9_]*)['"]|os\.environ\.get\(['"]([A-Z_][A-Z0-9_]*)['"]|os\.getenv\(['"]([A-Z_][A-Z0-9_]*)['"]/g;

// Go: os.Getenv("X")
const GO_ENV_RE = /os\.Getenv\("([A-Z_][A-Z0-9_]*)"\)/g;

// Ruby: ENV["X"], ENV['X'], ENV.fetch("X")
const RUBY_ENV_RE = /ENV\[['"]([A-Z_][A-Z0-9_]*)['"]|ENV\.fetch\(['"]([A-Z_][A-Z0-9_]*)['"]/g;

function extractFromSource(source: string, relPath: string, ext: string): Array<{ name: string; required: boolean }> {
  const found: Array<{ name: string; required: boolean }> = [];

  let re: RegExp;
  let hasFallback = false;

  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
    re = new RegExp(TS_ENV_RE.source, 'g');
    hasFallback = TS_HAS_FALLBACK_RE.test(source);
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const name = m[1] ?? m[2];
      if (name) found.push({ name, required: !hasFallback });
    }
  } else if (['.py', '.pyw'].includes(ext)) {
    re = new RegExp(PY_ENV_RE.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const name = m[1] ?? m[2] ?? m[3];
      // os.environ.get and os.getenv have optional defaults → not strictly required
      const isStrict = m[1] !== undefined; // only os.environ["X"] is strict
      if (name) found.push({ name, required: isStrict });
    }
  } else if (ext === '.go') {
    re = new RegExp(GO_ENV_RE.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      if (m[1]) found.push({ name: m[1], required: false }); // Go always uses string return, caller checks
    }
  } else if (ext === '.rb') {
    re = new RegExp(RUBY_ENV_RE.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const name = m[1] ?? m[2];
      const isStrict = m[1] !== undefined; // ENV.fetch has optional default
      if (name) found.push({ name, required: isStrict });
    }
  }

  return found;
}

// ============================================================================
// PUBLIC API
// ============================================================================

const ENV_DECLARATION_FILES = new Set(['.env', '.env.example', '.env.local', '.env.test', '.env.production']);
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.pyw', '.go', '.rb']);
const SKIP_DIRS = ['/node_modules/', '/.openlore/', '/dist/', '/build/', '/coverage/'];

/**
 * Extract all environment variables referenced or declared in the project.
 */
export async function extractEnvVars(
  filePaths: string[],
  rootDir: string
): Promise<EnvVar[]> {
  const map = new Map<string, EnvVar>();

  function upsert(name: string, relPath: string, patch: Partial<EnvVar>): void {
    const existing = map.get(name);
    if (existing) {
      if (!existing.files.includes(relPath)) existing.files.push(relPath);
      if (patch.hasDefault) existing.hasDefault = true;
      if (patch.required) existing.required = true;
      if (patch.description && !existing.description) existing.description = patch.description;
    } else {
      map.set(name, {
        name,
        files: [relPath],
        hasDefault: patch.hasDefault ?? false,
        required: patch.required ?? false,
        description: patch.description,
      });
    }
  }

  await Promise.all(
    filePaths.map(async fp => {
      if (SKIP_DIRS.some(d => fp.replace(/\\/g, '/').includes(d))) return;

      const name = basename(fp);
      const ext = extname(fp).toLowerCase();
      const rel = relative(rootDir, fp);

      let source: string;
      try {
        source = await readFile(fp, 'utf-8');
      } catch {
        return;
      }

      // Env declaration files
      if (ENV_DECLARATION_FILES.has(name)) {
        for (const v of parseEnvFile(source, rel)) {
          upsert(v.name, rel, { hasDefault: v.hasDefault, description: v.description });
        }
        return;
      }

      // Source files
      if (!SOURCE_EXTENSIONS.has(ext)) return;
      // Skip test files
      if (fp.includes('.test.') || fp.includes('.spec.') || fp.includes('_test.') || fp.includes('_spec.')) return;

      for (const { name: varName, required } of extractFromSource(source, rel, ext)) {
        upsert(varName, rel, { required });
      }
    })
  );

  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Return a compact summary string for LLM prompts.
 */
export function summarizeEnvVars(vars: EnvVar[]): string {
  if (vars.length === 0) return '';
  const lines = vars.map(v => {
    const flags: string[] = [];
    if (v.required) flags.push('required');
    if (v.hasDefault) flags.push('has-default');
    const suffix = flags.length > 0 ? ` [${flags.join(', ')}]` : '';
    const desc = v.description ? ` — ${v.description}` : '';
    return `  ${v.name}${suffix}${desc}`;
  });
  return `Environment variables (${vars.length}):\n${lines.join('\n')}`;
}
