/**
 * Signature Extractor
 *
 * Extracts function/class signatures and docstrings from source files
 * across multiple languages using regex patterns (no AST required).
 *
 * Used to build a compact semantic index of all project files for Stage 1,
 * replacing the simple file-path list with language-aware summaries.
 */

// ============================================================================
// TYPES
// ============================================================================

export interface ExtractedSignature {
  kind: 'class' | 'function' | 'method' | 'interface' | 'type';
  name: string;
  signature: string;   // compact one-liner
  docstring?: string;  // first meaningful line of doc comment
  decorator?: string;  // e.g. @router.get('/path') for FastAPI
}

export interface FileSignatureMap {
  path: string;        // relative path
  language: string;    // 'Python', 'TypeScript', 'JavaScript', 'Go', 'Rust', 'Ruby', 'unknown'
  entries: ExtractedSignature[];
}

// Max signatures per file to keep output compact
const MAX_SIGS_PER_FILE = 25;

// Max chars per Stage 1 chunk (~10k tokens, safe for all providers)
export const STAGE1_MAX_CHARS = 40_000;

// ============================================================================
// LANGUAGE DETECTION
// ============================================================================

export function detectLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'py':           return 'Python';
    case 'ts': case 'tsx': return 'TypeScript';
    case 'js': case 'jsx': return 'JavaScript';
    case 'go':           return 'Go';
    case 'rs':           return 'Rust';
    case 'rb':           return 'Ruby';
    case 'java':         return 'Java';
    case 'kt':           return 'Kotlin';
    case 'php':          return 'PHP';
    case 'cs':           return 'C#';
    case 'cpp': case 'cc': case 'cxx': return 'C++';
    case 'c':            return 'C';
    default:             return 'unknown';
  }
}

// ============================================================================
// PYTHON EXTRACTOR
// ============================================================================

function extractPython(content: string): ExtractedSignature[] {
  const entries: ExtractedSignature[] = [];
  const lines = content.split('\n');
  let pendingDecorator: string | undefined;
  let currentClass: string | undefined;
  let currentClassIndent = -1;

  for (let i = 0; i < lines.length && entries.length < MAX_SIGS_PER_FILE; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;

    // Track class context (methods vs module-level functions)
    if (indent === 0 && currentClass && indent <= currentClassIndent) {
      currentClass = undefined;
      currentClassIndent = -1;
    }

    // Decorator lines
    const decoratorMatch = trimmed.match(/^(@(?:[\w.]+)(?:\([^)]*\))?)/);
    if (decoratorMatch) {
      pendingDecorator = decoratorMatch[1];
      continue;
    }

    // Class declaration
    const classMatch = trimmed.match(/^class\s+(\w+)(?:\s*\(([^)]*)\))?\s*:/);
    if (classMatch && indent === 0) {
      const name = classMatch[1];
      const bases = classMatch[2] ? `(${classMatch[2]})` : '';
      const docstring = extractPythonDocstring(lines, i + 1);
      entries.push({
        kind: 'class',
        name,
        signature: `class ${name}${bases}:`,
        docstring,
      });
      currentClass = name;
      currentClassIndent = indent;
      pendingDecorator = undefined;
      continue;
    }

    // Function / method declaration
    const funcMatch = trimmed.match(/^(async\s+)?def\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*([^\n:]+))?\s*:/);
    if (funcMatch) {
      const isAsync = !!funcMatch[1];
      const name = funcMatch[2];
      const params = funcMatch[3].trim();
      const ret = funcMatch[4]?.trim() ?? '';

      // Skip private methods (leading underscore) unless very few entries so far
      if (name.startsWith('_') && name !== '__init__' && entries.length > 2) {
        pendingDecorator = undefined;
        continue;
      }

      const asyncPrefix = isAsync ? 'async ' : '';
      const returnSuffix = ret ? ` -> ${ret}` : '';
      // Compact params: remove 'self' from display
      const displayParams = params
        .split(',')
        .map(p => p.trim())
        .filter(p => p !== 'self' && p !== 'cls')
        .join(', ');
      const sig = `${asyncPrefix}def ${name}(${displayParams})${returnSuffix}`;

      const docstring = extractPythonDocstring(lines, i + 1);
      const kind: ExtractedSignature['kind'] = indent > 0 ? 'method' : 'function';

      entries.push({
        kind,
        name,
        signature: (indent > 0 ? '  ' : '') + sig,
        docstring,
        decorator: pendingDecorator,
      });

      pendingDecorator = undefined;
      continue;
    }

    // Reset decorator if line is neither decorator nor def/class
    if (trimmed && !trimmed.startsWith('#')) {
      pendingDecorator = undefined;
    }
  }

  return entries;
}

function extractPythonDocstring(lines: string[], startIdx: number): string | undefined {
  const next = lines[startIdx]?.trimStart() ?? '';
  if (next.startsWith('"""') || next.startsWith("'''")) {
    const quote = next.startsWith('"""') ? '"""' : "'''";
    const inner = next.slice(3);
    // Single-line docstring: """Text"""
    if (inner.includes(quote)) {
      return inner.slice(0, inner.indexOf(quote)).trim() || undefined;
    }
    // Multi-line: take the first non-empty line
    return inner.trim() || lines[startIdx + 1]?.trim() || undefined;
  }
  return undefined;
}

// ============================================================================
// TYPESCRIPT / JAVASCRIPT EXTRACTOR
// ============================================================================

function extractTypeScript(content: string): ExtractedSignature[] {
  const entries: ExtractedSignature[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length && entries.length < MAX_SIGS_PER_FILE; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();

    // Collect JSDoc comment above the declaration
    let jsDoc: string | undefined;
    if (i > 0) {
      jsDoc = extractJSDoc(lines, i);
    }

    // export class / export abstract class
    const classMatch = trimmed.match(/^export\s+(?:default\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+([\w<>, .]+?))?(?:\s+implements\s+[\w<>, .]+)?\s*\{?/);
    if (classMatch) {
      const name = classMatch[1];
      const ext = classMatch[2] ? ` extends ${classMatch[2].trim()}` : '';
      entries.push({ kind: 'class', name, signature: `export class ${name}${ext}`, docstring: jsDoc });
      continue;
    }

    // export interface
    const ifaceMatch = trimmed.match(/^export\s+(?:default\s+)?interface\s+(\w+)(?:\s+extends\s+[\w<>, .]+)?\s*\{?/);
    if (ifaceMatch) {
      entries.push({ kind: 'interface', name: ifaceMatch[1], signature: `export interface ${ifaceMatch[1]}`, docstring: jsDoc });
      continue;
    }

    // export type
    const typeMatch = trimmed.match(/^export\s+type\s+(\w+)\s*(?:<[^>]*>)?\s*=/);
    if (typeMatch) {
      entries.push({ kind: 'type', name: typeMatch[1], signature: `export type ${typeMatch[1]}`, docstring: jsDoc });
      continue;
    }

    // export function / export async function / export default function
    const fnMatch = trimmed.match(/^export\s+(?:default\s+)?(?:async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)(?:\s*:\s*([^{]+))?/);
    if (fnMatch) {
      const name = fnMatch[1];
      const params = compactParams(fnMatch[2]);
      const ret = fnMatch[3]?.trim().replace(/\s+/g, ' ') ?? '';
      const sig = `export function ${name}(${params})${ret ? ': ' + ret : ''}`;
      entries.push({ kind: 'function', name, signature: sig, docstring: jsDoc });
      continue;
    }

    // export const foo = (...) => / export const foo: Type = (...)
    const arrowMatch = trimmed.match(/^export\s+const\s+(\w+)(?:\s*:\s*[\w<>[\], |&]+)?\s*=\s*(?:async\s+)?\(/);
    if (arrowMatch) {
      entries.push({ kind: 'function', name: arrowMatch[1], signature: `export const ${arrowMatch[1]} = (...)`, docstring: jsDoc });
      continue;
    }

    // Public class methods (indented, not private/protected/#)
    const methodMatch = trimmed.match(/^(?:public\s+|static\s+|override\s+|async\s+)*(?:public\s+)?(?:static\s+)?(?:async\s+)?(\w+)\s*\(([^)]*)\)(?:\s*:\s*([^{]+))?.*\{/);
    if (methodMatch && line.startsWith('  ') && !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('private') && !trimmed.startsWith('#')) {
      const name = methodMatch[1];
      if (/^[a-z]/.test(name) && name !== 'if' && name !== 'for' && name !== 'while' && name !== 'switch' && name !== 'return') {
        const params = compactParams(methodMatch[2]);
        const ret = methodMatch[3]?.trim().replace(/\s+/g, ' ') ?? '';
        entries.push({ kind: 'method', name, signature: `  ${name}(${params})${ret ? ': ' + ret : ''}`, docstring: jsDoc });
      }
    }
  }

  return entries;
}

function extractJSDoc(lines: string[], declLineIdx: number): string | undefined {
  // Walk backwards to find */ then /**
  let endIdx = declLineIdx - 1;
  // Skip blank lines
  while (endIdx >= 0 && lines[endIdx].trim() === '') endIdx--;
  if (endIdx < 0 || !lines[endIdx].trim().endsWith('*/')) return undefined;

  let startIdx = endIdx;
  while (startIdx >= 0 && !lines[startIdx].trim().startsWith('/**')) startIdx--;
  if (startIdx < 0) return undefined;

  // Find first meaningful @description or plain text line
  for (let j = startIdx + 1; j <= endIdx; j++) {
    const t = lines[j].replace(/^\s*\*\s?/, '').trim();
    if (t && !t.startsWith('@')) return t;
  }
  return undefined;
}

function compactParams(params: string): string {
  return params
    .split(',')
    .map(p => p.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .join(', ');
}

// ============================================================================
// GO EXTRACTOR
// ============================================================================

function extractGo(content: string): ExtractedSignature[] {
  const entries: ExtractedSignature[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length && entries.length < MAX_SIGS_PER_FILE; i++) {
    const line = lines[i];
    // func (r *Receiver) Name(args) ret or func Name(args) ret
    const match = line.match(/^func\s+(?:\([^)]+\)\s+)?(\w+)\s*\(([^)]*)\)(?:\s*(?:\([^)]*\)|[\w*[\], ]+))?/);
    if (match) {
      const name = match[1];
      if (name === 'init' || name.startsWith('test') || name.startsWith('Test')) continue;
      // Grab comment above
      const comment = lines[i - 1]?.trim().startsWith('//') ? lines[i - 1].trim().slice(2).trim() : undefined;
      entries.push({ kind: 'function', name, signature: line.trim().replace(/\s*\{.*$/, ''), docstring: comment });
    }

    // type Foo struct or type Foo interface
    const typeMatch = line.match(/^type\s+(\w+)\s+(struct|interface)\s*\{?/);
    if (typeMatch) {
      entries.push({ kind: typeMatch[2] === 'interface' ? 'interface' : 'class', name: typeMatch[1], signature: `type ${typeMatch[1]} ${typeMatch[2]}` });
    }
  }

  return entries;
}

// ============================================================================
// RUST EXTRACTOR
// ============================================================================

function extractRust(content: string): ExtractedSignature[] {
  const entries: ExtractedSignature[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length && entries.length < MAX_SIGS_PER_FILE; i++) {
    const line = lines[i];

    // pub fn / pub async fn
    const fnMatch = line.match(/^\s*pub(?:\(crate\))?\s+(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)(?:\s*->\s*([^{]+))?/);
    if (fnMatch) {
      const name = fnMatch[1];
      const params = compactParams(fnMatch[2]);
      const ret = fnMatch[3]?.trim() ?? '';
      const sig = `pub fn ${name}(${params})${ret ? ' -> ' + ret : ''}`;
      const comment = lines[i - 1]?.trim().startsWith('///') ? lines[i - 1].trim().slice(3).trim() : undefined;
      entries.push({ kind: 'function', name, signature: sig, docstring: comment });
    }

    // pub struct / pub enum
    const typeMatch = line.match(/^\s*pub(?:\(crate\))?\s+(struct|enum)\s+(\w+)/);
    if (typeMatch) {
      entries.push({ kind: 'class', name: typeMatch[2], signature: `pub ${typeMatch[1]} ${typeMatch[2]}` });
    }
  }

  return entries;
}

// ============================================================================
// RUBY EXTRACTOR
// ============================================================================

function extractRuby(content: string): ExtractedSignature[] {
  const entries: ExtractedSignature[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length && entries.length < MAX_SIGS_PER_FILE; i++) {
    const line = lines[i].trim();

    const classMatch = line.match(/^class\s+(\w+)(?:\s*<\s*(\w+))?/);
    if (classMatch) {
      const name = classMatch[1];
      const parent = classMatch[2] ? ` < ${classMatch[2]}` : '';
      entries.push({ kind: 'class', name, signature: `class ${name}${parent}` });
      continue;
    }

    const methodMatch = line.match(/^def\s+(\w+)(?:\s*\(([^)]*)\))?/);
    if (methodMatch) {
      const name = methodMatch[1];
      const params = methodMatch[2] ? `(${methodMatch[2]})` : '';
      entries.push({ kind: 'function', name, signature: `def ${name}${params}` });
    }
  }

  return entries;
}

// ============================================================================
// GENERIC FALLBACK EXTRACTOR
// ============================================================================

function extractGeneric(content: string): ExtractedSignature[] {
  const entries: ExtractedSignature[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length && entries.length < MAX_SIGS_PER_FILE; i++) {
    const line = lines[i];
    // Generic: lines that look like declarations (function/class/def keywords)
    const match = line.match(/^\s*(?:public|private|protected|export|static|async)?\s*(?:function|class|def|func|fn|sub|procedure)\s+(\w+)/);
    if (match) {
      entries.push({ kind: 'function', name: match[1], signature: line.trim().slice(0, 120) });
    }
  }

  return entries;
}

// ============================================================================
// MAIN EXTRACTOR
// ============================================================================

export function extractSignatures(filePath: string, content: string): FileSignatureMap {
  const language = detectLanguage(filePath);
  let entries: ExtractedSignature[];

  switch (language) {
    case 'Python':
      entries = extractPython(content);
      break;
    case 'TypeScript':
    case 'JavaScript':
      entries = extractTypeScript(content);
      break;
    case 'Go':
      entries = extractGo(content);
      break;
    case 'Rust':
      entries = extractRust(content);
      break;
    case 'Ruby':
      entries = extractRuby(content);
      break;
    default:
      entries = extractGeneric(content);
      break;
  }

  return { path: filePath, language, entries };
}

// ============================================================================
// FORMATTER
// ============================================================================

/**
 * Format signature maps as compact text blocks for Stage 1 LLM prompt.
 * Returns an array of chunk strings — 1 element if total fits within maxChars,
 * N elements if chunking is needed. Files are never split across chunks.
 */
export function formatSignatureMaps(
  maps: FileSignatureMap[],
  maxChars = STAGE1_MAX_CHARS
): string[] {
  // Filter out files with no signatures
  const meaningful = maps.filter(m => m.entries.length > 0);

  const chunks: string[] = [];
  let current = '';

  for (const map of meaningful) {
    const block = formatSingleFile(map);
    // If adding this block would exceed the limit, flush current chunk
    if (current.length > 0 && current.length + block.length > maxChars) {
      chunks.push(current.trim());
      current = '';
    }
    current += block + '\n';
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks.length > 0 ? chunks : ['(no signatures extracted)'];
}

function formatSingleFile(map: FileSignatureMap): string {
  const lines: string[] = [`=== ${map.path} [${map.language}] ===`];

  for (const entry of map.entries) {
    if (entry.decorator) {
      lines.push(entry.decorator);
    }
    lines.push(entry.signature);
    if (entry.docstring) {
      const indent = entry.signature.startsWith('  ') ? '    ' : '  ';
      lines.push(`${indent}"""${entry.docstring}"""`);
    }
  }

  return lines.join('\n') + '\n';
}
