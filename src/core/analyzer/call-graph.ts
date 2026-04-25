/**
 * Call Graph Analyzer
 *
 * Performs static analysis of function calls across source files using tree-sitter.
 * Supports TypeScript/JavaScript, Python, Go, Rust, Ruby, Java, Swift — no LLM, pure AST.
 *
 * Produces:
 *  - FunctionNode[]  — all identified functions/methods
 *  - CallEdge[]      — resolved function→function call relationships
 *  - Hub functions   — high-fanIn nodes (called by many others)
 *  - Entry points    — functions with no internal callers
 *  - Layer violations — cross-layer calls in the wrong direction
 */

import Parser from 'tree-sitter';
import { FunctionRegistryTrie } from './function-registry-trie.js';
import type { ImportMap } from './import-resolver-bridge.js';
import { inferTypesFromSource, resolveViaTypeInference } from './type-inference-engine.js';
import { extractAllHttpEdges } from './http-route-parser.js';

// ============================================================================
// TYPES
// ============================================================================

export type EdgeConfidence =
  | 'self_cls'       // intra-class call via self/cls
  | 'type_inference' // receiver type resolved via type inference
  | 'import'         // callee was imported from a known file
  | 'http_endpoint'  // cross-language HTTP route match
  | 'same_file'      // multiple candidates; same-file wins
  | 'name_only'      // last-resort: pick first candidate by name
  | 'type_name'      // Swift/C++ capitalized receiver treated as type name
  | 'external';      // unresolved external/stdlib call (synthetic leaf node)

/** Broad relationship kind */
export type EdgeKind = 'calls' | 'tested_by';

/** Semantic nature of the call at the call site */
export type CallType =
  | 'direct'       // foo()
  | 'method'       // obj.method()
  | 'awaited'      // await foo() or await obj.method()
  | 'constructor'; // new Foo()

/** Internal raw edge before resolution */
interface RawEdge {
  callerId: string;
  calleeName: string;
  line: number;
  /** Receiver variable name in `obj.method()` calls */
  calleeObject?: string;
  /** Call type detected from AST shape at extraction time */
  callType?: CallType;
}

export interface FunctionNode {
  /** Unique ID: "filepath::ClassName.methodName" or "filepath::functionName" */
  id: string;
  name: string;
  filePath: string;
  className?: string;
  isAsync: boolean;
  language: string;
  /** Byte offset range in source (for call attribution) */
  startIndex: number;
  endIndex: number;
  fanIn: number;
  fanOut: number;
  /** First meaningful line of the doc comment / docstring, extracted from AST positions */
  docstring?: string;
  /** Declaration line(s) up to opening brace/colon, whitespace-normalized */
  signature?: string;
  /** True for synthetic nodes representing unresolved external/stdlib calls (e.g. fetch, https.request) */
  isExternal?: boolean;
  /** Classification of external node — used to filter stdlib noise from views */
  externalKind?: ExternalKind;
}

/** Broad category of an external (unresolved) call */
export type ExternalKind = 'http' | 'database' | 'filesystem' | 'stdlib' | 'unknown';

export interface CallEdge {
  callerId: string;
  /** Resolved callee ID */
  calleeId: string;
  /** Raw name as it appears in source */
  calleeName: string;
  line?: number;
  confidence: EdgeConfidence;
  /** Broad relationship kind — omitted on legacy/pre-existing edges, treated as 'calls' */
  kind?: EdgeKind;
  /** Semantic call type; only set when kind === 'calls' */
  callType?: CallType;
}

export interface LayerViolation {
  callerId: string;
  calleeId: string;
  callerLayer: string;
  calleeLayer: string;
  reason: string;
}

/**
 * A class or interface as a structural unit, grouping its methods.
 * Derived from FunctionNode.className after the call graph is built.
 */
export interface ClassNode {
  /** Unique ID: first filePath where the class is seen + "::" + className */
  id: string;
  name: string;
  filePath: string;
  language: string;
  /** Direct parent class names (from `extends` / Python base / C++ base) */
  parentClasses: string[];
  /** Implemented interfaces (TypeScript `implements`, Java `implements`) */
  interfaces: string[];
  /** IDs of FunctionNode members that belong to this class */
  methodIds: string[];
  /** Sum of method fanIn values */
  fanIn: number;
  /** Sum of method fanOut values */
  fanOut: number;
  /** True for synthetic file-level module nodes (free functions grouped by file) */
  isModule?: boolean;
}

/**
 * An inheritance or implementation edge between two ClassNodes in the graph.
 */
export interface InheritanceEdge {
  id: string;
  /** ClassNode id of the parent / base / interface */
  parentId: string;
  /** ClassNode id of the child / derived / implementor */
  childId: string;
  kind: 'extends' | 'implements' | 'embeds';
}

export interface CallGraphResult {
  nodes: Map<string, FunctionNode>;
  edges: CallEdge[];
  /** Class-level structural nodes, derived from FunctionNode.className grouping */
  classes: ClassNode[];
  /** Inheritance / implementation edges between ClassNodes */
  inheritanceEdges: InheritanceEdge[];
  /** Functions with fanIn >= HUB_THRESHOLD */
  hubFunctions: FunctionNode[];
  /** Functions with no internal callers (fanIn === 0) */
  entryPoints: FunctionNode[];
  layerViolations: LayerViolation[];
  stats: {
    totalNodes: number;
    totalEdges: number;
    avgFanIn: number;
    avgFanOut: number;
  };
}

/** Serializable version (Maps replaced by arrays) for JSON storage */
export interface SerializedCallGraph {
  nodes: FunctionNode[];
  edges: CallEdge[];
  classes: ClassNode[];
  inheritanceEdges: InheritanceEdge[];
  hubFunctions: FunctionNode[];
  entryPoints: FunctionNode[];
  layerViolations: LayerViolation[];
  stats: CallGraphResult['stats'];
}

// ============================================================================
// CONSTANTS
// ============================================================================

const HUB_THRESHOLD = 5;

/** Common builtins and stdlib names to ignore as call targets (across all languages) */
const IGNORED_CALLEES = new Set([
  // Python builtins
  'print', 'len', 'range', 'str', 'int', 'float', 'list', 'dict', 'set', 'tuple',
  'bool', 'type', 'isinstance', 'issubclass', 'hasattr', 'getattr', 'setattr',
  'enumerate', 'zip', 'map', 'filter', 'sorted', 'reversed', 'sum', 'min', 'max',
  'open', 'input', 'format', 'repr', 'id', 'hash', 'abs', 'round', 'pow',
  'super', 'object', 'property', 'staticmethod', 'classmethod',
  // JS/TS common
  'console', 'log', 'error', 'warn', 'JSON', 'parse', 'stringify',
  'Promise', 'resolve', 'reject', 'then', 'catch', 'finally',
  'Array', 'Object', 'String', 'Number', 'Boolean', 'Math', 'Date',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'require', 'import', 'exports',
  // Python control flow (used like functions sometimes)
  'assert', 'raise', 'return', 'yield', 'await', 'pass', 'del',
  // Node.js common
  'readFile', 'writeFile', 'mkdir', 'join', 'resolve', 'basename', 'dirname',
  'existsSync', 'readFileSync', 'writeFileSync',
  // Go builtins
  'make', 'new', 'append', 'copy', 'delete', 'close', 'panic', 'recover',
  'println', 'printf', 'sprintf', 'errorf', 'fprintf',
  // Rust macros / common stdlib
  'println', 'eprintln', 'format', 'vec', 'assert', 'unwrap', 'expect',
  'ok', 'err', 'some', 'none',
  // Ruby builtins
  'puts', 'print', 'p', 'raise', 'require', 'require_relative', 'include',
  'extend', 'attr_accessor', 'attr_reader', 'attr_writer',
  // Java common
  'toString', 'equals', 'hashCode', 'getClass', 'println', 'printf',
  // Swift stdlib / builtins
  'print', 'debugPrint', 'dump', 'fatalError', 'precondition', 'preconditionFailure',
  'assert', 'assertionFailure', 'withUnsafePointer', 'withUnsafeMutablePointer',
  'DispatchQueue', 'main', 'async', 'sync', 'append', 'remove', 'insert', 'contains',
  'map', 'filter', 'reduce', 'forEach', 'compactMap', 'flatMap', 'sorted', 'first', 'last',
  // C++ stdlib / builtins
  'cout', 'cin', 'cerr', 'endl', 'malloc', 'free', 'memcpy', 'memset', 'memcmp',
  'strlen', 'strcpy', 'strcat', 'strcmp', 'sprintf', 'snprintf', 'fprintf',
  'push_back', 'pop_back', 'emplace_back', 'begin', 'end', 'size', 'empty',
  'find', 'insert', 'erase', 'at', 'front', 'back', 'clear', 'reserve', 'resize',
  'make_shared', 'make_unique', 'move', 'forward', 'swap',
  'static_cast', 'dynamic_cast', 'reinterpret_cast', 'const_cast',
]);

/** Returns true if the name should be skipped as a call target. */
function isIgnoredCallee(name: string): boolean {
  if (IGNORED_CALLEES.has(name)) return true;
  // ALL_CAPS names (3+ chars) are almost certainly C/C++ macros, not functions
  if (/^[A-Z][A-Z0-9_]{2,}$/.test(name)) return true;
  return false;
}

// ============================================================================
// PARSER SINGLETONS (lazy init)
// ============================================================================

let _tsParser: Parser | undefined;
let _pyParser: Parser | undefined;
let _goParser: Parser | undefined;
let _rustParser: Parser | undefined;
let _rubyParser: Parser | undefined;
let _javaParser: Parser | undefined;
let _cppParser: Parser | undefined;
let _swiftParser: Parser | undefined;
let _TsLanguage: object | undefined;
let _PyLanguage: object | undefined;
let _GoLanguage: object | undefined;
let _RustLanguage: object | undefined;
let _RubyLanguage: object | undefined;
let _JavaLanguage: object | undefined;
let _CppLanguage: object | undefined;
let _SwiftLanguage: object | undefined;

async function getTSParser(): Promise<{ parser: Parser; lang: object }> {
  if (!_tsParser) {
    const tsModule = await import('tree-sitter-typescript');
    _TsLanguage = (tsModule.default as { typescript: object }).typescript;
    _tsParser = new Parser();
    (_tsParser as Parser).setLanguage(_TsLanguage as unknown as Parser.Language);
  }
  return { parser: _tsParser!, lang: _TsLanguage! };
}

async function getPyParser(): Promise<{ parser: Parser; lang: object }> {
  if (!_pyParser) {
    const pyModule = await import('tree-sitter-python');
    _PyLanguage = pyModule.default;
    _pyParser = new Parser();
    (_pyParser as Parser).setLanguage(_PyLanguage as unknown as Parser.Language);
  }
  return { parser: _pyParser!, lang: _PyLanguage! };
}

async function getGoParser(): Promise<{ parser: Parser; lang: object }> {
  if (!_goParser) {
    const goModule = await import('tree-sitter-go');
    _GoLanguage = goModule.default;
    _goParser = new Parser();
    (_goParser as Parser).setLanguage(_GoLanguage as unknown as Parser.Language);
  }
  return { parser: _goParser!, lang: _GoLanguage! };
}

async function getRustParser(): Promise<{ parser: Parser; lang: object }> {
  if (!_rustParser) {
    const rustModule = await import('tree-sitter-rust');
    _RustLanguage = rustModule.default;
    _rustParser = new Parser();
    (_rustParser as Parser).setLanguage(_RustLanguage as unknown as Parser.Language);
  }
  return { parser: _rustParser!, lang: _RustLanguage! };
}

async function getRubyParser(): Promise<{ parser: Parser; lang: object }> {
  if (!_rubyParser) {
    const rubyModule = await import('tree-sitter-ruby');
    _RubyLanguage = rubyModule.default;
    _rubyParser = new Parser();
    (_rubyParser as Parser).setLanguage(_RubyLanguage as unknown as Parser.Language);
  }
  return { parser: _rubyParser!, lang: _RubyLanguage! };
}

async function getJavaParser(): Promise<{ parser: Parser; lang: object }> {
  if (!_javaParser) {
    const javaModule = await import('tree-sitter-java');
    _JavaLanguage = javaModule.default;
    _javaParser = new Parser();
    (_javaParser as Parser).setLanguage(_JavaLanguage as unknown as Parser.Language);
  }
  return { parser: _javaParser!, lang: _JavaLanguage! };
}

async function getCppParser(): Promise<{ parser: Parser; lang: object }> {
  if (!_cppParser) {
    const cppModule = await import('tree-sitter-cpp');
    _CppLanguage = cppModule.default;
    _cppParser = new Parser();
    (_cppParser as Parser).setLanguage(_CppLanguage as unknown as Parser.Language);
  }
  return { parser: _cppParser!, lang: _CppLanguage! };
}

async function getSwiftParser(): Promise<{ parser: Parser; lang: object }> {
  if (!_swiftParser) {
    const swiftModule = await import('tree-sitter-swift');
    _SwiftLanguage = swiftModule.default;
    _swiftParser = new Parser();
    (_swiftParser as Parser).setLanguage(_SwiftLanguage as unknown as Parser.Language);
  }
  return { parser: _swiftParser!, lang: _SwiftLanguage! };
}

// ============================================================================
// ATTRIBUTION HELPER
// ============================================================================

/**
 * Given a list of function nodes (with startIndex/endIndex) and a call position,
 * find the narrowest enclosing function node.
 */
function findEnclosingFunction(
  nodes: FunctionNode[],
  callPos: number
): FunctionNode | undefined {
  let best: FunctionNode | undefined;
  let bestSize = Infinity;
  for (const n of nodes) {
    if (n.startIndex <= callPos && callPos < n.endIndex) {
      const size = n.endIndex - n.startIndex;
      if (size < bestSize) {
        bestSize = size;
        best = n;
      }
    }
  }
  return best;
}

// ============================================================================
// DOCSTRING / SIGNATURE EXTRACTION HELPERS
// ============================================================================

/**
 * Scan backward from `startIndex` in `source` to find the doc comment
 * immediately preceding the function declaration. Skip blank lines.
 *
 * For Python, docstrings are INSIDE the function body — scan forward from
 * `startIndex` past the `def name(...):` colon to find the triple-quoted string.
 *
 * Returns the first meaningful (non-empty, non-decorator) line of the comment.
 */
function extractDocstringBefore(
  source: string,
  startIndex: number,
  language: string
): string | undefined {
  // ── Python: scan forward past the colon into the function body ──────────
  if (language === 'Python') {
    // Find the colon that ends the `def` line
    let i = startIndex;
    while (i < source.length && source[i] !== ':') i++;
    // Skip past the colon
    i++;
    // Skip whitespace / newline
    while (i < source.length && (source[i] === ' ' || source[i] === '\t' || source[i] === '\n' || source[i] === '\r')) i++;
    // Check for triple-quoted docstring
    const tripleDouble = source.startsWith('"""', i);
    const tripleSingle = source.startsWith("'''", i);
    if (tripleDouble || tripleSingle) {
      const quote = tripleDouble ? '"""' : "'''";
      const bodyStart = i + 3;
      const closeIdx = source.indexOf(quote, bodyStart);
      if (closeIdx === -1) return undefined;
      const inner = source.slice(bodyStart, closeIdx);
      const firstLine = inner.split('\n').map(l => l.trim()).find(l => l.length > 0);
      return firstLine ?? undefined;
    }
    return undefined;
  }

  // ── All other languages: scan backward from startIndex ─────────────────
  // Move to the character just before startIndex
  let pos = startIndex - 1;

  // Skip trailing whitespace / newlines before the declaration
  while (pos >= 0 && (source[pos] === ' ' || source[pos] === '\t' || source[pos] === '\n' || source[pos] === '\r')) {
    pos--;
  }

  if (pos < 0) return undefined;

  // ── TypeScript / JavaScript / Java / C++: JSDoc block /** ... */ ────────
  if (
    language === 'TypeScript' || language === 'JavaScript' ||
    language === 'Java' || language === 'C++'
  ) {
    // Expect closing */ of a JSDoc block
    if (source[pos] === '/' && pos > 0 && source[pos - 1] === '*') {
      const closePos = pos - 1; // points at '*' of closing '*/'
      // Find opening /**
      const openIdx = source.lastIndexOf('/**', closePos);
      if (openIdx === -1) return undefined;
      const inner = source.slice(openIdx + 3, closePos - 0);
      // Remove leading * on each line, find first non-empty, non-@ line
      const firstLine = inner
        .split('\n')
        .map(l => l.replace(/^\s*\*\s?/, '').trim())
        .find(l => l.length > 0 && !l.startsWith('@'));
      return firstLine ?? undefined;
    }
    return undefined;
  }

  // ── Go: // comment lines immediately before ──────────────────────────────
  if (language === 'Go') {
    const lines: string[] = [];
    // Walk backward line by line
    let lineEnd = pos;
    while (lineEnd >= 0) {
      // Find start of this line
      let lineStart = lineEnd;
      while (lineStart > 0 && source[lineStart - 1] !== '\n') lineStart--;
      const line = source.slice(lineStart, lineEnd + 1).trimEnd();
      const trimmed = line.trim();
      if (trimmed.startsWith('//')) {
        lines.unshift(trimmed.slice(2).trim());
        lineEnd = lineStart - 1;
        // Skip over the newline
        while (lineEnd >= 0 && (source[lineEnd] === '\n' || source[lineEnd] === '\r')) lineEnd--;
      } else {
        break;
      }
    }
    return lines.find(l => l.length > 0) ?? undefined;
  }

  // ── Rust / Swift: /// doc comment lines immediately before ─────────────
  if (language === 'Rust' || language === 'Swift') {
    const lines: string[] = [];
    let lineEnd = pos;
    while (lineEnd >= 0) {
      let lineStart = lineEnd;
      while (lineStart > 0 && source[lineStart - 1] !== '\n') lineStart--;
      const line = source.slice(lineStart, lineEnd + 1).trimEnd();
      const trimmed = line.trim();
      if (trimmed.startsWith('///')) {
        lines.unshift(trimmed.slice(3).trim());
        lineEnd = lineStart - 1;
        while (lineEnd >= 0 && (source[lineEnd] === '\n' || source[lineEnd] === '\r')) lineEnd--;
      } else {
        break;
      }
    }
    return lines.find(l => l.length > 0) ?? undefined;
  }

  // ── Ruby: # comment lines immediately before ─────────────────────────────
  if (language === 'Ruby') {
    const lines: string[] = [];
    let lineEnd = pos;
    while (lineEnd >= 0) {
      let lineStart = lineEnd;
      while (lineStart > 0 && source[lineStart - 1] !== '\n') lineStart--;
      const line = source.slice(lineStart, lineEnd + 1).trimEnd();
      const trimmed = line.trim();
      if (trimmed.startsWith('#')) {
        lines.unshift(trimmed.slice(1).trim());
        lineEnd = lineStart - 1;
        while (lineEnd >= 0 && (source[lineEnd] === '\n' || source[lineEnd] === '\r')) lineEnd--;
      } else {
        break;
      }
    }
    return lines.find(l => l.length > 0) ?? undefined;
  }

  return undefined;
}

/**
 * Extract the function declaration (signature without body) from
 * `source.slice(startIndex, endIndex)`.
 *
 * Strategy:
 * - TS/JS/Java/C++/Go/Rust/Ruby: take everything up to the first `{` at depth 0
 * - Python: take everything up to the first `:` that ends the `def` line
 *
 * Whitespace is normalized (multiple spaces/newlines → single space).
 * Limited to 300 characters max.
 */
function extractDeclaration(
  source: string,
  startIndex: number,
  endIndex: number,
  language: string
): string {
  const slice = source.slice(startIndex, Math.min(endIndex, startIndex + 1500));

  let decl: string;

  if (language === 'Python') {
    // Take up to (not including) the first `:` that ends the def line
    // We scan for `:` while tracking parenthesis depth to avoid matching
    // colons inside type annotations (e.g., def f(x: int) -> dict[str, int]:)
    let depth = 0;
    let end = -1;
    for (let i = 0; i < slice.length; i++) {
      const ch = slice[i];
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') depth--;
      else if (ch === ':' && depth === 0) {
        end = i;
        break;
      }
    }
    decl = end !== -1 ? slice.slice(0, end) : slice.slice(0, 300);
  } else {
    // Find first `{` at brace depth 0
    let depth = 0;
    let end = -1;
    for (let i = 0; i < slice.length; i++) {
      const ch = slice[i];
      if (ch === '{') {
        if (depth === 0) { end = i; break; }
        depth++;
      } else if (ch === '}') {
        depth--;
      }
    }
    decl = end !== -1 ? slice.slice(0, end) : slice.slice(0, 300);
  }

  // Normalize whitespace
  return decl.replace(/\s+/g, ' ').trim().slice(0, 300);
}

// ============================================================================
// TYPESCRIPT EXTRACTOR
// ============================================================================

const TS_FN_QUERY = `
  (function_declaration
    name: (identifier) @fn.name) @fn.node

  (export_statement
    declaration: (function_declaration
      name: (identifier) @fn.name)) @fn.node

  (method_definition
    name: (property_identifier) @fn.name) @fn.node

  (lexical_declaration
    (variable_declarator
      name: (identifier) @fn.name
      value: [(arrow_function) (function_expression)] @fn.value)) @fn.node
`;

const TS_CALL_QUERY = `
  (call_expression
    function: [(identifier) @call.name
               (member_expression
                 object: (identifier) @call.object
                 property: (property_identifier) @call.name)]) @call.node
`;

async function extractTSGraph(
  filePath: string,
  content: string
): Promise<{ nodes: FunctionNode[]; rawEdges: RawEdge[] }> {
  const { parser, lang } = await getTSParser();
  const tree = (parser as Parser).parse(content);

  const fnQuery = new Parser.Query(lang as unknown as Parser.Language, TS_FN_QUERY);
  const callQuery = new Parser.Query(lang as unknown as Parser.Language, TS_CALL_QUERY);

  // --- Extract function nodes ---
  const nodes: FunctionNode[] = [];
  const fnMatches = fnQuery.matches(tree.rootNode);

  for (const match of fnMatches) {
    const nameCapture = match.captures.find(c => c.name === 'fn.name');
    const nodeCapture = match.captures.find(c => c.name === 'fn.node');
    if (!nameCapture || !nodeCapture) continue;

    const name = nameCapture.node.text;
    const fnNode = nodeCapture.node;

    // Find enclosing class (walk up — skip class_body, its children are methods not the name)
    let className: string | undefined;
    let cursor = fnNode.parent;
    while (cursor) {
      if (cursor.type === 'class_declaration') {
        const classNameNode = cursor.children.find(c => c.type === 'type_identifier' || c.type === 'identifier');
        if (classNameNode) className = classNameNode.text;
        break;
      }
      cursor = cursor.parent;
    }

    // Detect async (method_definition has 'async' as first named child keyword)
    const isAsync = fnNode.children.some(c => c.type === 'async') ||
      fnNode.text.startsWith('async ');

    const id = className
      ? `${filePath}::${className}.${name}`
      : `${filePath}::${name}`;

    nodes.push({
      id,
      name,
      filePath,
      className,
      isAsync,
      language: 'TypeScript',
      startIndex: fnNode.startIndex,
      endIndex: fnNode.endIndex,
      fanIn: 0,
      fanOut: 0,
      docstring: extractDocstringBefore(content, fnNode.startIndex, 'TypeScript'),
      signature: extractDeclaration(content, fnNode.startIndex, fnNode.endIndex, 'TypeScript'),
    });
  }

  // --- Extract calls ---
  const rawEdges: RawEdge[] = [];
  const callMatches = callQuery.matches(tree.rootNode);

  for (const match of callMatches) {
    const nameCapture = match.captures.find(c => c.name === 'call.name');
    const nodeCapture = match.captures.find(c => c.name === 'call.node');
    const objectCapture = match.captures.find(c => c.name === 'call.object');
    if (!nameCapture || !nodeCapture) continue;

    const calleeName = nameCapture.node.text;
    if (isIgnoredCallee(calleeName)) continue;

    const callPos = nodeCapture.node.startIndex;
    const caller = findEnclosingFunction(nodes, callPos);
    if (!caller) continue;

    // Detect call type from AST parent context
    let callType: CallType = objectCapture ? 'method' : 'direct';
    const parentType = nodeCapture.node.parent?.type;
    if (parentType === 'await_expression') callType = 'awaited';
    else if (parentType === 'new_expression') callType = 'constructor';

    rawEdges.push({
      callerId: caller.id,
      calleeName,
      line: nodeCapture.node.startPosition.row + 1,
      calleeObject: objectCapture?.node.text,
      callType,
    });
  }

  return { nodes, rawEdges };
}

// ============================================================================
// PYTHON EXTRACTOR
// ============================================================================

const PY_FN_QUERY = `
  (function_definition
    name: (identifier) @fn.name) @fn.node

  (decorated_definition
    (function_definition
      name: (identifier) @fn.name)) @fn.node
`;

/**
 * Direct function calls: foo(), bar(x)
 * We keep this separate from attribute calls so we can filter attribute calls
 * by object name (only self/cls are resolved to internal functions).
 */
const PY_DIRECT_CALL_QUERY = `
  (call
    function: (identifier) @call.name) @call.node
`;

/**
 * Method calls on an object: obj.method()
 * We capture the object name so we can restrict resolution to self/cls.
 * Calls like redis.get(), dict.get(), os.environ.get() are NOT resolved —
 * only self.method() and cls.method() are tracked as internal edges.
 */
const PY_METHOD_CALL_QUERY = `
  (call
    function: (attribute
      object: (identifier) @call.object
      attribute: (identifier) @call.name)) @call.node
`;

async function extractPyGraph(
  filePath: string,
  content: string
): Promise<{ nodes: FunctionNode[]; rawEdges: RawEdge[] }> {
  const { parser, lang } = await getPyParser();
  const tree = (parser as Parser).parse(content);

  const fnQuery = new Parser.Query(lang as unknown as Parser.Language, PY_FN_QUERY);

  // --- Extract function nodes ---
  const nodes: FunctionNode[] = [];
  const seen = new Set<number>(); // avoid duplicates from decorated_definition + function_definition
  const fnMatches = fnQuery.matches(tree.rootNode);

  for (const match of fnMatches) {
    const nameCapture = match.captures.find(c => c.name === 'fn.name');
    const nodeCapture = match.captures.find(c => c.name === 'fn.node');
    if (!nameCapture || !nodeCapture) continue;

    const name = nameCapture.node.text;
    const fnNode = nodeCapture.node;

    // Deduplicate by name node position (decorated_definition wraps the function_definition)
    if (seen.has(nameCapture.node.startIndex)) continue;
    seen.add(nameCapture.node.startIndex);

    // Find enclosing class
    let className: string | undefined;
    let cursor = fnNode.parent;
    while (cursor) {
      if (cursor.type === 'class_definition') {
        const classNameNode = cursor.children.find(c => c.type === 'identifier');
        if (classNameNode) className = classNameNode.text;
        break;
      }
      cursor = cursor.parent;
    }

    // Skip private methods (underscore prefix) unless they're __init__ or there are very few nodes
    if (name.startsWith('_') && name !== '__init__') continue;

    const isAsync = fnNode.text.startsWith('async ') ||
      (fnNode.type === 'function_definition' && fnNode.children[0]?.text === 'async');

    const id = className
      ? `${filePath}::${className}.${name}`
      : `${filePath}::${name}`;

    nodes.push({
      id,
      name,
      filePath,
      className,
      isAsync,
      language: 'Python',
      startIndex: fnNode.startIndex,
      endIndex: fnNode.endIndex,
      fanIn: 0,
      fanOut: 0,
      docstring: extractDocstringBefore(content, fnNode.startIndex, 'Python'),
      signature: extractDeclaration(content, fnNode.startIndex, fnNode.endIndex, 'Python'),
    });
  }

  // --- Extract calls ---
  const rawEdges: RawEdge[] = [];

  const directCallQuery = new Parser.Query(lang as unknown as Parser.Language, PY_DIRECT_CALL_QUERY);
  const methodCallQuery = new Parser.Query(lang as unknown as Parser.Language, PY_METHOD_CALL_QUERY);

  // Direct calls: foo(), bar(x) — resolve across all files
  for (const match of directCallQuery.matches(tree.rootNode)) {
    const nameCapture = match.captures.find(c => c.name === 'call.name');
    const nodeCapture = match.captures.find(c => c.name === 'call.node');
    if (!nameCapture || !nodeCapture) continue;

    const calleeName = nameCapture.node.text;
    if (isIgnoredCallee(calleeName)) continue;

    const callPos = nodeCapture.node.startIndex;
    const caller = findEnclosingFunction(nodes, callPos);
    if (!caller) continue;

    // In Python tree-sitter, `await expr` wraps the call: parent type is 'await'
    const callType: CallType = nodeCapture.node.parent?.type === 'await' ? 'awaited' : 'direct';
    rawEdges.push({
      callerId: caller.id,
      calleeName,
      line: nodeCapture.node.startPosition.row + 1,
      callType,
    });
  }

  // Method calls: obj.method() — capture receiver for type-inference-based resolution
  for (const match of methodCallQuery.matches(tree.rootNode)) {
    const objectCapture = match.captures.find(c => c.name === 'call.object');
    const nameCapture = match.captures.find(c => c.name === 'call.name');
    const nodeCapture = match.captures.find(c => c.name === 'call.node');
    if (!objectCapture || !nameCapture || !nodeCapture) continue;

    const calleeName = nameCapture.node.text;
    if (isIgnoredCallee(calleeName)) continue;

    const callPos = nodeCapture.node.startIndex;
    const caller = findEnclosingFunction(nodes, callPos);
    if (!caller) continue;

    const methodCallType: CallType = nodeCapture.node.parent?.type === 'await' ? 'awaited' : 'method';
    rawEdges.push({
      callerId: caller.id,
      calleeName,
      line: nodeCapture.node.startPosition.row + 1,
      calleeObject: objectCapture.node.text,
      callType: methodCallType,
    });
  }

  return { nodes, rawEdges };
}

// ============================================================================
// GO EXTRACTOR
// ============================================================================

const GO_FN_QUERY = `
  (function_declaration
    name: (identifier) @fn.name) @fn.node

  (method_declaration
    name: (field_identifier) @fn.name) @fn.node
`;

const GO_CALL_QUERY = `
  (call_expression
    function: (identifier) @call.name) @call.node

  (call_expression
    function: (selector_expression
      operand: (identifier) @call.object
      field: (field_identifier) @call.name)) @call.node
`;

async function extractGoGraph(
  filePath: string,
  content: string
): Promise<{ nodes: FunctionNode[]; rawEdges: RawEdge[] }> {
  const { parser, lang } = await getGoParser();
  const tree = (parser as Parser).parse(content);

  const fnQuery = new Parser.Query(lang as unknown as Parser.Language, GO_FN_QUERY);
  const callQuery = new Parser.Query(lang as unknown as Parser.Language, GO_CALL_QUERY);

  const nodes: FunctionNode[] = [];
  for (const match of fnQuery.matches(tree.rootNode)) {
    const nameCapture = match.captures.find(c => c.name === 'fn.name');
    const nodeCapture = match.captures.find(c => c.name === 'fn.node');
    if (!nameCapture || !nodeCapture) continue;

    const name = nameCapture.node.text;
    const fnNode = nodeCapture.node;

    // Receiver type for method_declaration → use as className
    let className: string | undefined;
    if (fnNode.type === 'method_declaration') {
      const receiver = fnNode.children.find(c => c.type === 'parameter_list');
      if (receiver) {
        // Extract type name from receiver: (r *MyStruct) → MyStruct
        const typeNode = receiver.descendantsOfType('type_identifier')[0]
          ?? receiver.descendantsOfType('pointer_type')[0];
        if (typeNode) className = typeNode.text.replace(/^\*/, '');
      }
    }

    const id = className ? `${filePath}::${className}.${name}` : `${filePath}::${name}`;
    nodes.push({
      id, name, filePath, className,
      isAsync: false, // Go has goroutines, not async/await
      language: 'Go',
      startIndex: fnNode.startIndex,
      endIndex: fnNode.endIndex,
      fanIn: 0, fanOut: 0,
      docstring: extractDocstringBefore(content, fnNode.startIndex, 'Go'),
      signature: extractDeclaration(content, fnNode.startIndex, fnNode.endIndex, 'Go'),
    });
  }

  const rawEdges: RawEdge[] = [];
  for (const match of callQuery.matches(tree.rootNode)) {
    const nameCapture = match.captures.find(c => c.name === 'call.name');
    const nodeCapture = match.captures.find(c => c.name === 'call.node');
    const objectCapture = match.captures.find(c => c.name === 'call.object');
    if (!nameCapture || !nodeCapture) continue;

    const calleeName = nameCapture.node.text;
    if (isIgnoredCallee(calleeName)) continue;

    const caller = findEnclosingFunction(nodes, nodeCapture.node.startIndex);
    if (!caller) continue;

    rawEdges.push({ callerId: caller.id, calleeName, line: nodeCapture.node.startPosition.row + 1, calleeObject: objectCapture?.node.text });
  }

  return { nodes, rawEdges };
}

// ============================================================================
// RUST EXTRACTOR
// ============================================================================

const RUST_FN_QUERY = `
  (function_item
    name: (identifier) @fn.name) @fn.node
`;

const RUST_CALL_QUERY = `
  (call_expression
    function: (identifier) @call.name) @call.node

  (call_expression
    function: (field_expression
      value: (identifier) @call.object
      field: (field_identifier) @call.name)) @call.node
`;

async function extractRustGraph(
  filePath: string,
  content: string
): Promise<{ nodes: FunctionNode[]; rawEdges: RawEdge[] }> {
  const { parser, lang } = await getRustParser();
  const tree = (parser as Parser).parse(content);

  const fnQuery = new Parser.Query(lang as unknown as Parser.Language, RUST_FN_QUERY);
  const callQuery = new Parser.Query(lang as unknown as Parser.Language, RUST_CALL_QUERY);

  const nodes: FunctionNode[] = [];
  for (const match of fnQuery.matches(tree.rootNode)) {
    const nameCapture = match.captures.find(c => c.name === 'fn.name');
    const nodeCapture = match.captures.find(c => c.name === 'fn.node');
    if (!nameCapture || !nodeCapture) continue;

    const name = nameCapture.node.text;
    const fnNode = nodeCapture.node;

    // Find enclosing impl block → use as className
    let className: string | undefined;
    let cursor = fnNode.parent;
    while (cursor) {
      if (cursor.type === 'impl_item') {
        const typeNode = cursor.children.find(c => c.type === 'type_identifier');
        if (typeNode) className = typeNode.text;
        break;
      }
      cursor = cursor.parent;
    }

    // Rust: async keyword lives inside a function_modifiers child
    const isAsync = fnNode.children.some(
      c => c.type === 'function_modifiers' && c.text.includes('async')
    );
    const id = className ? `${filePath}::${className}.${name}` : `${filePath}::${name}`;
    nodes.push({
      id, name, filePath, className,
      isAsync,
      language: 'Rust',
      startIndex: fnNode.startIndex,
      endIndex: fnNode.endIndex,
      fanIn: 0, fanOut: 0,
      docstring: extractDocstringBefore(content, fnNode.startIndex, 'Rust'),
      signature: extractDeclaration(content, fnNode.startIndex, fnNode.endIndex, 'Rust'),
    });
  }

  const rawEdges: RawEdge[] = [];
  for (const match of callQuery.matches(tree.rootNode)) {
    const nameCapture = match.captures.find(c => c.name === 'call.name');
    const nodeCapture = match.captures.find(c => c.name === 'call.node');
    const objectCapture = match.captures.find(c => c.name === 'call.object');
    if (!nameCapture || !nodeCapture) continue;

    const calleeName = nameCapture.node.text;
    if (isIgnoredCallee(calleeName)) continue;

    const caller = findEnclosingFunction(nodes, nodeCapture.node.startIndex);
    if (!caller) continue;

    rawEdges.push({ callerId: caller.id, calleeName, line: nodeCapture.node.startPosition.row + 1, calleeObject: objectCapture?.node.text });
  }

  return { nodes, rawEdges };
}

// ============================================================================
// RUBY EXTRACTOR
// ============================================================================

const RUBY_FN_QUERY = `
  (method
    name: (identifier) @fn.name) @fn.node

  (singleton_method
    name: (identifier) @fn.name) @fn.node
`;

// Explicit calls: fn(), obj.method()
const RUBY_CALL_QUERY = `
  (call
    receiver: (identifier) @call.object
    method: (identifier) @call.name) @call.node

  (call
    method: (identifier) @call.name) @call.node
`;

// Bareword calls: Ruby allows calling methods without parentheses.
// An identifier at statement level inside a body_statement is almost always
// a method call (variable usage appears in assignments/expressions, not alone).
const RUBY_BAREWORD_QUERY = `
  (body_statement
    (identifier) @call.name)
`;

async function extractRubyGraph(
  filePath: string,
  content: string
): Promise<{ nodes: FunctionNode[]; rawEdges: RawEdge[] }> {
  const { parser, lang } = await getRubyParser();
  const tree = (parser as Parser).parse(content);

  const fnQuery = new Parser.Query(lang as unknown as Parser.Language, RUBY_FN_QUERY);
  const callQuery = new Parser.Query(lang as unknown as Parser.Language, RUBY_CALL_QUERY);
  const barewordQuery = new Parser.Query(lang as unknown as Parser.Language, RUBY_BAREWORD_QUERY);

  const nodes: FunctionNode[] = [];
  for (const match of fnQuery.matches(tree.rootNode)) {
    const nameCapture = match.captures.find(c => c.name === 'fn.name');
    const nodeCapture = match.captures.find(c => c.name === 'fn.node');
    if (!nameCapture || !nodeCapture) continue;

    const name = nameCapture.node.text;
    const fnNode = nodeCapture.node;

    // Find enclosing class/module
    let className: string | undefined;
    let cursor = fnNode.parent;
    while (cursor) {
      if (cursor.type === 'class' || cursor.type === 'module') {
        const nameNode = cursor.children.find(c => c.type === 'constant' || c.type === 'scope_resolution');
        if (nameNode) className = nameNode.text;
        break;
      }
      cursor = cursor.parent;
    }

    const id = className ? `${filePath}::${className}.${name}` : `${filePath}::${name}`;
    nodes.push({
      id, name, filePath, className,
      isAsync: false,
      language: 'Ruby',
      startIndex: fnNode.startIndex,
      endIndex: fnNode.endIndex,
      fanIn: 0, fanOut: 0,
      docstring: extractDocstringBefore(content, fnNode.startIndex, 'Ruby'),
      signature: extractDeclaration(content, fnNode.startIndex, fnNode.endIndex, 'Ruby'),
    });
  }

  const rawEdges: RawEdge[] = [];

  // Explicit calls: fn(), obj.method()
  for (const match of callQuery.matches(tree.rootNode)) {
    const nameCapture = match.captures.find(c => c.name === 'call.name');
    const nodeCapture = match.captures.find(c => c.name === 'call.node');
    const objectCapture = match.captures.find(c => c.name === 'call.object');
    if (!nameCapture || !nodeCapture) continue;

    const calleeName = nameCapture.node.text;
    if (isIgnoredCallee(calleeName)) continue;

    const caller = findEnclosingFunction(nodes, nodeCapture.node.startIndex);
    if (!caller) continue;

    rawEdges.push({ callerId: caller.id, calleeName, line: nodeCapture.node.startPosition.row + 1, calleeObject: objectCapture?.node.text });
  }

  // Bareword calls: identifier at statement level, no parens
  for (const match of barewordQuery.matches(tree.rootNode)) {
    const nameCapture = match.captures.find(c => c.name === 'call.name');
    if (!nameCapture) continue;

    const calleeName = nameCapture.node.text;
    if (isIgnoredCallee(calleeName)) continue;

    const caller = findEnclosingFunction(nodes, nameCapture.node.startIndex);
    if (!caller) continue;

    rawEdges.push({ callerId: caller.id, calleeName, line: nameCapture.node.startPosition.row + 1 });
  }

  return { nodes, rawEdges };
}

// ============================================================================
// JAVA EXTRACTOR
// ============================================================================

const JAVA_FN_QUERY = `
  (method_declaration
    name: (identifier) @fn.name) @fn.node

  (constructor_declaration
    name: (identifier) @fn.name) @fn.node
`;

const JAVA_CALL_QUERY = `
  (method_invocation
    object: (identifier) @call.object
    name: (identifier) @call.name) @call.node

  (method_invocation
    name: (identifier) @call.name) @call.node
`;

async function extractJavaGraph(
  filePath: string,
  content: string
): Promise<{ nodes: FunctionNode[]; rawEdges: RawEdge[] }> {
  const { parser, lang } = await getJavaParser();
  const tree = (parser as Parser).parse(content);

  const fnQuery = new Parser.Query(lang as unknown as Parser.Language, JAVA_FN_QUERY);
  const callQuery = new Parser.Query(lang as unknown as Parser.Language, JAVA_CALL_QUERY);

  const nodes: FunctionNode[] = [];
  for (const match of fnQuery.matches(tree.rootNode)) {
    const nameCapture = match.captures.find(c => c.name === 'fn.name');
    const nodeCapture = match.captures.find(c => c.name === 'fn.node');
    if (!nameCapture || !nodeCapture) continue;

    const name = nameCapture.node.text;
    const fnNode = nodeCapture.node;

    // Find enclosing class/interface/enum
    let className: string | undefined;
    let cursor = fnNode.parent;
    while (cursor) {
      if (cursor.type === 'class_declaration' || cursor.type === 'interface_declaration' || cursor.type === 'enum_declaration') {
        const nameNode = cursor.children.find(c => c.type === 'identifier');
        if (nameNode) className = nameNode.text;
        break;
      }
      cursor = cursor.parent;
    }

    const isAsync = false; // Java uses Future/CompletableFuture, not async keyword
    const id = className ? `${filePath}::${className}.${name}` : `${filePath}::${name}`;
    nodes.push({
      id, name, filePath, className,
      isAsync,
      language: 'Java',
      startIndex: fnNode.startIndex,
      endIndex: fnNode.endIndex,
      fanIn: 0, fanOut: 0,
      docstring: extractDocstringBefore(content, fnNode.startIndex, 'Java'),
      signature: extractDeclaration(content, fnNode.startIndex, fnNode.endIndex, 'Java'),
    });
  }

  const rawEdges: RawEdge[] = [];
  for (const match of callQuery.matches(tree.rootNode)) {
    const nameCapture = match.captures.find(c => c.name === 'call.name');
    const nodeCapture = match.captures.find(c => c.name === 'call.node');
    const objectCapture = match.captures.find(c => c.name === 'call.object');
    if (!nameCapture || !nodeCapture) continue;

    const calleeName = nameCapture.node.text;
    if (isIgnoredCallee(calleeName)) continue;

    const caller = findEnclosingFunction(nodes, nodeCapture.node.startIndex);
    if (!caller) continue;

    rawEdges.push({ callerId: caller.id, calleeName, line: nodeCapture.node.startPosition.row + 1, calleeObject: objectCapture?.node.text });
  }

  return { nodes, rawEdges };
}

// ============================================================================
// C++ EXTRACTOR
// ============================================================================

/**
 * Safely run a tree-sitter query, returning [] if the S-expression is invalid
 * for the grammar. C++ grammar has many edge cases (templates, operators,
 * pointer declarators) that can make certain queries fail.
 */
function safeQuery(
  lang: object,
  queryStr: string,
  root: Parser.SyntaxNode
): Parser.QueryMatch[] {
  try {
    const q = new Parser.Query(lang as unknown as Parser.Language, queryStr);
    return q.matches(root);
  } catch {
    return [];
  }
}

/** Free functions and inline class methods with a simple identifier name */
const CPP_FN_BASIC_QUERY = `
  (function_definition
    declarator: (function_declarator
      declarator: (identifier) @fn.name)) @fn.node

  (function_definition
    declarator: (function_declarator
      declarator: (field_identifier) @fn.name)) @fn.node
`;

/** Out-of-class definitions: void Foo::bar() {} */
const CPP_FN_QUALIFIED_QUERY = `
  (function_definition
    declarator: (function_declarator
      declarator: (qualified_identifier
        name: (identifier) @fn.name))) @fn.node
`;

/** Plain function calls: foo() */
const CPP_CALL_DIRECT_QUERY = `
  (call_expression
    function: (identifier) @call.name) @call.node
`;

/** Member calls: obj.method() and ptr->method() — captures receiver */
const CPP_CALL_MEMBER_QUERY = `
  (call_expression
    function: (field_expression
      argument: (identifier) @call.object
      field: (field_identifier) @call.name)) @call.node
`;

async function extractCppGraph(
  filePath: string,
  content: string
): Promise<{ nodes: FunctionNode[]; rawEdges: RawEdge[] }> {
  const { parser, lang } = await getCppParser();
  const tree = (parser as Parser).parse(content);

  const nodes: FunctionNode[] = [];
  const seen = new Set<number>(); // deduplicate by name-node start position

  for (const queryStr of [CPP_FN_BASIC_QUERY, CPP_FN_QUALIFIED_QUERY]) {
    for (const match of safeQuery(lang, queryStr, tree.rootNode)) {
      const nameCapture = match.captures.find(c => c.name === 'fn.name');
      const nodeCapture = match.captures.find(c => c.name === 'fn.node');
      if (!nameCapture || !nodeCapture) continue;

      if (seen.has(nameCapture.node.startIndex)) continue;
      seen.add(nameCapture.node.startIndex);

      const name = nameCapture.node.text;
      // Skip ALL_CAPS names — these are almost certainly macros, not functions
      if (/^[A-Z][A-Z0-9_]{2,}$/.test(name)) continue;
      const fnNode = nodeCapture.node;

      // Find enclosing class (inline method defined inside class body)
      let className: string | undefined;
      let cursor = fnNode.parent;
      while (cursor) {
        if (cursor.type === 'class_specifier' || cursor.type === 'struct_specifier') {
          const nameNode = cursor.children.find(c => c.type === 'type_identifier');
          if (nameNode) className = nameNode.text;
          break;
        }
        cursor = cursor.parent;
      }

      // For out-of-class: void Foo::bar() — extract class from qualified_identifier scope
      if (!className) {
        const fnDeclarator = fnNode.children.find(c => c.type === 'function_declarator');
        if (fnDeclarator) {
          const qualNode = fnDeclarator.children.find(c => c.type === 'qualified_identifier');
          if (qualNode) {
            const scopeNode = qualNode.children.find(
              c => c.type === 'namespace_identifier' || c.type === 'type_identifier'
            );
            if (scopeNode) className = scopeNode.text;
          }
        }
      }

      const id = className ? `${filePath}::${className}.${name}` : `${filePath}::${name}`;
      nodes.push({
        id, name, filePath, className,
        isAsync: false, // C++ has no async keyword at language level
        language: 'C++',
        startIndex: fnNode.startIndex,
        endIndex: fnNode.endIndex,
        fanIn: 0, fanOut: 0,
        docstring: extractDocstringBefore(content, fnNode.startIndex, 'C++'),
        signature: extractDeclaration(content, fnNode.startIndex, fnNode.endIndex, 'C++'),
      });
    }
  }

  const rawEdges: RawEdge[] = [];

  // Plain calls: foo()
  for (const match of safeQuery(lang, CPP_CALL_DIRECT_QUERY, tree.rootNode)) {
    const nameCapture = match.captures.find(c => c.name === 'call.name');
    const nodeCapture = match.captures.find(c => c.name === 'call.node');
    if (!nameCapture || !nodeCapture) continue;

    const calleeName = nameCapture.node.text;
    if (isIgnoredCallee(calleeName)) continue;

    const caller = findEnclosingFunction(nodes, nodeCapture.node.startIndex);
    if (!caller) continue;

    rawEdges.push({ callerId: caller.id, calleeName, line: nodeCapture.node.startPosition.row + 1 });
  }

  // Member calls: obj.method() / ptr->method()
  for (const match of safeQuery(lang, CPP_CALL_MEMBER_QUERY, tree.rootNode)) {
    const nameCapture = match.captures.find(c => c.name === 'call.name');
    const nodeCapture = match.captures.find(c => c.name === 'call.node');
    const objectCapture = match.captures.find(c => c.name === 'call.object');
    if (!nameCapture || !nodeCapture) continue;

    const calleeName = nameCapture.node.text;
    if (isIgnoredCallee(calleeName)) continue;

    const caller = findEnclosingFunction(nodes, nodeCapture.node.startIndex);
    if (!caller) continue;

    rawEdges.push({ callerId: caller.id, calleeName, line: nodeCapture.node.startPosition.row + 1, calleeObject: objectCapture?.node.text });
  }

  return { nodes, rawEdges };
}

// ============================================================================
// SWIFT EXTRACTOR
// ============================================================================

// function_declaration covers free functions and methods inside class_body
const SWIFT_FN_QUERY = `
  (function_declaration
    name: (simple_identifier) @fn.name) @fn.node

  (init_declaration) @fn.node
`;

// Direct calls: foo()
const SWIFT_CALL_DIRECT_QUERY = `
  (call_expression
    (simple_identifier) @call.name) @call.node
`;

// Method calls: obj.method() / self.method()
const SWIFT_CALL_NAV_QUERY = `
  (call_expression
    (navigation_expression
      (navigation_suffix
        (simple_identifier) @call.name))) @call.node
`;

async function extractSwiftGraph(
  filePath: string,
  content: string
): Promise<{ nodes: FunctionNode[]; rawEdges: RawEdge[] }> {
  const { parser, lang } = await getSwiftParser();
  const tree = (parser as Parser).parse(content);

  const fnQuery = new Parser.Query(lang as unknown as Parser.Language, SWIFT_FN_QUERY);
  const directCallQuery = new Parser.Query(lang as unknown as Parser.Language, SWIFT_CALL_DIRECT_QUERY);
  const navCallQuery = new Parser.Query(lang as unknown as Parser.Language, SWIFT_CALL_NAV_QUERY);

  const nodes: FunctionNode[] = [];
  for (const match of fnQuery.matches(tree.rootNode)) {
    const nameCapture = match.captures.find(c => c.name === 'fn.name');
    const nodeCapture = match.captures.find(c => c.name === 'fn.node');
    if (!nodeCapture) continue;

    const fnNode = nodeCapture.node;
    const name = nameCapture?.node.text ?? 'init';

    // Find enclosing class/struct/actor/enum/extension (all are class_declaration in this grammar)
    let className: string | undefined;
    let cursor = fnNode.parent;
    while (cursor) {
      if (cursor.type === 'class_declaration') {
        const nameNode = cursor.children.find(c => c.type === 'type_identifier');
        if (nameNode) className = nameNode.text;
        break;
      }
      cursor = cursor.parent;
    }

    const isAsync = content.slice(fnNode.startIndex, fnNode.endIndex).includes(' async ');
    const id = className ? `${filePath}::${className}.${name}` : `${filePath}::${name}`;

    nodes.push({
      id, name, filePath, className,
      isAsync,
      language: 'Swift',
      startIndex: fnNode.startIndex,
      endIndex: fnNode.endIndex,
      fanIn: 0, fanOut: 0,
      docstring: extractDocstringBefore(content, fnNode.startIndex, 'Swift'),
      signature: extractDeclaration(content, fnNode.startIndex, fnNode.endIndex, 'Swift'),
    });
  }

  const rawEdges: RawEdge[] = [];

  // Direct calls: foo()
  for (const match of directCallQuery.matches(tree.rootNode)) {
    const nameCapture = match.captures.find(c => c.name === 'call.name');
    const nodeCapture = match.captures.find(c => c.name === 'call.node');
    if (!nameCapture || !nodeCapture) continue;

    const calleeName = nameCapture.node.text;
    if (isIgnoredCallee(calleeName)) continue;

    const caller = findEnclosingFunction(nodes, nodeCapture.node.startIndex);
    if (!caller) continue;

    rawEdges.push({ callerId: caller.id, calleeName, line: nodeCapture.node.startPosition.row + 1 });
  }

  // Method calls: obj.method() / self.method()
  for (const match of navCallQuery.matches(tree.rootNode)) {
    const nameCapture = match.captures.find(c => c.name === 'call.name');
    const nodeCapture = match.captures.find(c => c.name === 'call.node');
    if (!nameCapture || !nodeCapture) continue;

    const calleeName = nameCapture.node.text;
    if (isIgnoredCallee(calleeName)) continue;

    const caller = findEnclosingFunction(nodes, nodeCapture.node.startIndex);
    if (!caller) continue;

    // Extract the receiver object (first child of navigation_expression)
    const navExpr = nodeCapture.node.firstChild;
    const objText = navExpr?.firstChild?.type === 'self_expression'
      ? 'self'
      : navExpr?.firstChild?.text;

    rawEdges.push({ callerId: caller.id, calleeName, line: nodeCapture.node.startPosition.row + 1, calleeObject: objText });
  }

  return { nodes, rawEdges };
}

// ============================================================================
// CLASS HIERARCHY EXTRACTION
// ============================================================================

/**
 * Extract parent class / interface relationships from source files using
 * tree-sitter.  Returns a map from `filePath::ClassName` → relationship info.
 * Uses safeQuery so any query that doesn't match a grammar version is silently
 * skipped rather than crashing.
 */
async function extractClassRelationships(
  files: Array<{ path: string; content: string; language: string }>,
): Promise<Map<string, { parentClasses: string[]; interfaces: string[] }>> {
  const out = new Map<string, { parentClasses: string[]; interfaces: string[] }>();

  // Helper to merge into map keyed by `filePath::ClassName`
  function merge(
    filePath: string,
    className: string,
    parents: string[],
    ifaces: string[],
  ) {
    const key = `${filePath}::${className}`;
    const existing = out.get(key) ?? { parentClasses: [], interfaces: [] };
    for (const p of parents) if (!existing.parentClasses.includes(p)) existing.parentClasses.push(p);
    for (const i of ifaces)  if (!existing.interfaces.includes(i))   existing.interfaces.push(i);
    out.set(key, existing);
  }

  for (const file of files) {
    try {
      if (file.language === 'TypeScript' || file.language === 'JavaScript') {
        const { parser, lang } = await getTSParser();
        const tree = (parser as Parser).parse(file.content);

        // class Foo extends Bar implements Baz, Qux
        const EXTENDS_Q = `
          (class_declaration
            name: (type_identifier) @cls
            (class_heritage (extends_clause value: (identifier) @parent)))`;
        const IMPLEMENTS_Q = `
          (class_declaration
            name: (type_identifier) @cls
            (class_heritage (implements_clause (type_identifier) @iface)))`;

        for (const m of safeQuery(lang, EXTENDS_Q, tree.rootNode)) {
          const cls    = m.captures.find(c => c.name === 'cls')?.node.text;
          const parent = m.captures.find(c => c.name === 'parent')?.node.text;
          if (cls && parent) merge(file.path, cls, [parent], []);
        }
        for (const m of safeQuery(lang, IMPLEMENTS_Q, tree.rootNode)) {
          const cls  = m.captures.find(c => c.name === 'cls')?.node.text;
          const iface = m.captures.find(c => c.name === 'iface')?.node.text;
          if (cls && iface) merge(file.path, cls, [], [iface]);
        }

      } else if (file.language === 'Python') {
        const { parser, lang } = await getPyParser();
        const tree = (parser as Parser).parse(file.content);

        // class Foo(Bar, Baz):
        const Q = `
          (class_definition
            name: (identifier) @cls
            superclasses: (argument_list (identifier) @parent))`;
        for (const m of safeQuery(lang, Q, tree.rootNode)) {
          const cls    = m.captures.find(c => c.name === 'cls')?.node.text;
          const parent = m.captures.find(c => c.name === 'parent')?.node.text;
          if (cls && parent && parent !== 'object') merge(file.path, cls, [parent], []);
        }

      } else if (file.language === 'Java') {
        const { parser, lang } = await getJavaParser();
        const tree = (parser as Parser).parse(file.content);

        const EXTENDS_Q = `
          (class_declaration
            name: (identifier) @cls
            (superclass (type_identifier) @parent))`;
        const IMPLEMENTS_Q = `
          (class_declaration
            name: (identifier) @cls
            (super_interfaces (type_list (type_identifier) @iface)))`;

        for (const m of safeQuery(lang, EXTENDS_Q, tree.rootNode)) {
          const cls    = m.captures.find(c => c.name === 'cls')?.node.text;
          const parent = m.captures.find(c => c.name === 'parent')?.node.text;
          if (cls && parent) merge(file.path, cls, [parent], []);
        }
        for (const m of safeQuery(lang, IMPLEMENTS_Q, tree.rootNode)) {
          const cls  = m.captures.find(c => c.name === 'cls')?.node.text;
          const iface = m.captures.find(c => c.name === 'iface')?.node.text;
          if (cls && iface) merge(file.path, cls, [], [iface]);
        }

      } else if (file.language === 'C++') {
        const { parser, lang } = await getCppParser();
        const tree = (parser as Parser).parse(file.content);

        // class Foo : public Bar
        const Q = `
          (class_specifier
            name: (type_identifier) @cls
            (base_class_clause (type_identifier) @parent))`;
        for (const m of safeQuery(lang, Q, tree.rootNode)) {
          const cls    = m.captures.find(c => c.name === 'cls')?.node.text;
          const parent = m.captures.find(c => c.name === 'parent')?.node.text;
          if (cls && parent) merge(file.path, cls, [parent], []);
        }

      } else if (file.language === 'Ruby') {
        const { parser, lang } = await getRubyParser();
        const tree = (parser as Parser).parse(file.content);

        // class Foo < Bar
        const Q = `
          (class
            name: (constant) @cls
            superclass: (superclass (constant) @parent))`;
        for (const m of safeQuery(lang, Q, tree.rootNode)) {
          const cls    = m.captures.find(c => c.name === 'cls')?.node.text;
          const parent = m.captures.find(c => c.name === 'parent')?.node.text;
          if (cls && parent) merge(file.path, cls, [parent], []);
        }

      } else if (file.language === 'Go') {
        // Go has no inheritance but has struct embedding; treat as 'embeds' edges
        const { parser, lang } = await getGoParser();
        const tree = (parser as Parser).parse(file.content);

        // Anonymous (embedded) field in a struct: type Foo struct { Bar }
        const Q = `
          (type_declaration
            (type_spec
              name: (type_identifier) @cls
              type: (struct_type
                (field_declaration_list
                  (field_declaration
                    type: (type_identifier) @embedded)))))`;
        for (const m of safeQuery(lang, Q, tree.rootNode)) {
          const cls      = m.captures.find(c => c.name === 'cls')?.node.text;
          const embedded = m.captures.find(c => c.name === 'embedded')?.node.text;
          if (cls && embedded) {
            const key = `${file.path}::${cls}`;
            const existing = out.get(key) ?? { parentClasses: [], interfaces: [] };
            // Store Go embeds as parentClasses (will be tagged as 'embeds' when building edges)
            if (!existing.parentClasses.includes(embedded)) existing.parentClasses.push(embedded);
            out.set(key, existing);
          }
        }
      }
      // Rust: trait impls are structural but less like OOP inheritance; skip for now
    } catch {
      // Best-effort; skip unparseable files
    }
  }

  return out;
}

/**
 * Build ClassNode[] from the set of extracted FunctionNodes (which carry
 * `className`), enriched with inheritance data from `extractClassRelationships`.
 *
 * Functions without a className are grouped by file into synthetic module nodes
 * (e.g. `[call-graph]`) so every function appears in the class graph, not just
 * class methods. This is essential for codebases that use mostly module-level
 * exports rather than OOP classes.
 */
function buildClassNodes(
  allNodes: Map<string, FunctionNode>,
  relationships: Map<string, { parentClasses: string[]; interfaces: string[] }>,
): { classes: ClassNode[]; inheritanceEdges: InheritanceEdge[] } {
  // Group FunctionNodes by (filePath, className).
  // Free functions use a synthetic "[basename]" module name keyed by filePath alone.
  const groups = new Map<string, {
    name: string; filePath: string; language: string; isModule: boolean; methods: FunctionNode[]
  }>();

  for (const fn of allNodes.values()) {
    let key: string;
    let name: string;
    let isModule: boolean;
    if (fn.className) {
      key = `${fn.filePath}::${fn.className}`;
      name = fn.className;
      isModule = false;
    } else {
      // Synthetic module node — one per file
      key = fn.filePath;
      const base = fn.filePath.split('/').pop() ?? fn.filePath;
      name = '[' + base.replace(/\.[^.]+$/, '') + ']';
      isModule = true;
    }
    if (!groups.has(key)) {
      groups.set(key, { name, filePath: fn.filePath, language: fn.language, isModule, methods: [] });
    }
    groups.get(key)!.methods.push(fn);
  }

  // Build ClassNode[]
  const classMap = new Map<string, ClassNode>();
  for (const [id, g] of groups) {
    const rel = relationships.get(id) ?? { parentClasses: [], interfaces: [] };
    const cls: ClassNode = {
      id,
      name: g.name,
      filePath: g.filePath,
      language: g.language,
      parentClasses: rel.parentClasses,
      interfaces: rel.interfaces,
      methodIds: g.methods.map(m => m.id),
      fanIn:  g.methods.reduce((s, m) => s + m.fanIn, 0),
      fanOut: g.methods.reduce((s, m) => s + m.fanOut, 0),
      isModule: g.isModule,
    };
    classMap.set(id, cls);
  }

  // Build InheritanceEdge[] — only when both parent and child are in our graph
  // Parent lookup: match by class name across all ClassNodes (first match wins)
  const byName = new Map<string, ClassNode>();
  for (const cls of classMap.values()) {
    if (!byName.has(cls.name)) byName.set(cls.name, cls);
  }

  const inheritanceEdges: InheritanceEdge[] = [];
  const seenEdges = new Set<string>();

  for (const cls of classMap.values()) {
    for (const parentName of cls.parentClasses) {
      const parent = byName.get(parentName);
      if (!parent) continue;
      const edgeId = `${parent.id}->${cls.id}`;
      if (seenEdges.has(edgeId)) continue;
      seenEdges.add(edgeId);
      // Go embedding vs OOP inheritance
      const kind = cls.language === 'Go' ? 'embeds' : 'extends';
      inheritanceEdges.push({ id: edgeId, parentId: parent.id, childId: cls.id, kind });
    }
    for (const ifaceName of cls.interfaces) {
      const parent = byName.get(ifaceName);
      if (!parent) continue;
      const edgeId = `${parent.id}->${cls.id}`;
      if (seenEdges.has(edgeId)) continue;
      seenEdges.add(edgeId);
      inheritanceEdges.push({ id: edgeId, parentId: parent.id, childId: cls.id, kind: 'implements' });
    }
  }

  return { classes: Array.from(classMap.values()), inheritanceEdges };
}

// ============================================================================
// EXTERNAL NODE HELPER
// ============================================================================

const TEST_FILE_PATTERNS = [
  /\.test\.[tj]sx?$/, /\.spec\.[tj]sx?$/,
  /_test\.py$/, /test_[^/]+\.py$/,
  /_spec\.rb$/, /_test\.go$/, /[A-Z][^/]*Test\.java$/,
];

function isTestFile(filePath: string): boolean {
  return TEST_FILE_PATTERNS.some(p => p.test(filePath));
}

const EXTERNAL_HTTP_RE = /^(fetch|axios|got|superagent|node-fetch|ky|request|https?|xmlhttprequest|grpc|undici|requests|aiohttp|httpx|urllib|urllib2|urllib3|curl|curleasy|pycurl)$/;
const EXTERNAL_DB_RE = /^(pg|mysql|mysql2|sqlite|sqlite3|redis|ioredis|mongoose|mongo|mongodb|prisma|knex|sequelize|typeorm|drizzle|cassandra|dynamodb|firestore|supabase|neo4j|influxdb|clickhouse|kysely|psycopg2|psycopg|sqlalchemy|pymysql|asyncpg|motor|aiomysql|tortoise)$/;
const EXTERNAL_FS_RE = /^(fs|fsp|readfile|writefile|readdir|stat|mkdir|unlink|rename|copyfile|createreadstream|createwritestream|open|fopen|fread|fwrite|fclose|remove|ifstream|ofstream|fstream)$/;
const EXTERNAL_STDLIB_BASES = new Set([
  // JavaScript / Node.js
  'array', 'object', 'string', 'number', 'math', 'json', 'date', 'regexp',
  'promise', 'map', 'set', 'weakmap', 'weakset', 'symbol', 'reflect', 'proxy',
  'console', 'error', 'buffer', 'process', 'int8array', 'uint8array',
  // Python
  'os', 'sys', 're', 'io', 'abc', 'ast', 'csv', 'copy', 'enum', 'glob',
  'gzip', 'hmac', 'html', 'http', 'logging', 'operator', 'pathlib', 'pickle',
  'pprint', 'queue', 'random', 'shutil', 'signal', 'socket', 'ssl', 'struct',
  'subprocess', 'tempfile', 'threading', 'time', 'traceback', 'typing', 'uuid',
  'warnings', 'collections', 'functools', 'itertools', 'contextlib',
  'dataclasses', 'unittest', 'hashlib', 'base64', 'binascii', 'codecs',
  'inspect', 'importlib', 'weakref', 'gc', 'platform', 'shlex', 'textwrap',
  // C / C++
  'std', 'printf', 'fprintf', 'sprintf', 'snprintf', 'scanf', 'malloc',
  'calloc', 'realloc', 'free', 'memcpy', 'memmove', 'memset', 'memcmp',
  'strlen', 'strcpy', 'strncpy', 'strcat', 'strcmp', 'strncmp', 'strstr',
  'assert', 'abort', 'exit', 'atexit',
]);
const EXTERNAL_NOISE_RECEIVERS = new Set([
  'response', 'body', 't', 'err', 'error', 'buf', 'str', 'res', 'req', 'data', 'result',
]);

function classifyExternal(name: string): ExternalKind {
  const base = name.split('.')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
  if (EXTERNAL_HTTP_RE.test(base)) return 'http';
  if (EXTERNAL_DB_RE.test(base)) return 'database';
  if (EXTERNAL_FS_RE.test(base)) return 'filesystem';
  if (EXTERNAL_STDLIB_BASES.has(base)) return 'stdlib';
  if (name.includes('.') && EXTERNAL_NOISE_RECEIVERS.has(name.split('.')[0].toLowerCase())) return 'stdlib';
  return 'unknown';
}

function getOrCreateExternalNode(name: string, nodes: Map<string, FunctionNode>): FunctionNode {
  const id = `external::${name}`;
  if (!nodes.has(id)) {
    nodes.set(id, {
      id, name, filePath: 'external', isExternal: true,
      externalKind: classifyExternal(name),
      isAsync: false, language: 'external',
      startIndex: 0, endIndex: 0, fanIn: 0, fanOut: 0,
    });
  }
  return nodes.get(id)!;
}

// ============================================================================
// CALL GRAPH BUILDER
// ============================================================================

export class CallGraphBuilder {
  /**
   * Build a call graph from a list of source files.
   *
   * @param files       Source files with path, content, and language
   * @param layers      Optional layer map { layerName: [path prefix, ...] }
   * @param importMap   Optional per-file import map (from ImportResolverBridge)
   */
  async build(
    files: Array<{ path: string; content: string; language: string }>,
    layers?: Record<string, string[]>,
    importMap?: ImportMap,
  ): Promise<CallGraphResult> {
    const allNodes = new Map<string, FunctionNode>();
    const allRawEdges: RawEdge[] = [];

    // Pass 1: Extract nodes and raw edges from each file
    for (const file of files) {
      try {
        let result: { nodes: FunctionNode[]; rawEdges: RawEdge[] };

        if (file.language === 'Python') {
          result = await extractPyGraph(file.path, file.content);
        } else if (file.language === 'TypeScript' || file.language === 'JavaScript') {
          result = await extractTSGraph(file.path, file.content);
        } else if (file.language === 'Go') {
          result = await extractGoGraph(file.path, file.content);
        } else if (file.language === 'Rust') {
          result = await extractRustGraph(file.path, file.content);
        } else if (file.language === 'Ruby') {
          result = await extractRubyGraph(file.path, file.content);
        } else if (file.language === 'Java') {
          result = await extractJavaGraph(file.path, file.content);
        } else if (file.language === 'C++') {
          result = await extractCppGraph(file.path, file.content);
        } else if (file.language === 'Swift') {
          result = await extractSwiftGraph(file.path, file.content);
        } else {
          continue;
        }

        for (const node of result.nodes) {
          allNodes.set(node.id, node);
        }
        allRawEdges.push(...result.rawEdges);
      } catch (error) {
        // Skip files that fail to parse (syntax errors, encoding issues, etc.)
        if (process.env.DEBUG) {
          console.debug(`[call-graph] Failed to parse ${file.path}: ${(error as Error).message}`);
        }
      }
    }

    // Pass 2: Resolve raw edges — multi-strategy resolution
    const trie = new FunctionRegistryTrie();
    for (const node of allNodes.values()) trie.insert(node);

    // Build per-function-body content slices for type inference (keyed by functionId)
    const fileContents = new Map<string, string>();
    for (const file of files) fileContents.set(file.path, file.content);

    const edges: CallEdge[] = [];
    for (const raw of allRawEdges) {
      const callerNode = allNodes.get(raw.callerId);
      if (!callerNode) continue;

      let calleeNode: FunctionNode | undefined;
      let confidence: EdgeConfidence = 'name_only';

      // Strategy 1 — self/cls intra-class (Python self.*, cls.* or same-class method)
      if (raw.calleeObject === 'self' || raw.calleeObject === 'cls') {
        if (callerNode.className) {
          const candidates = trie.findByQualifiedName(callerNode.className, raw.calleeName);
          if (candidates.length > 0) { calleeNode = candidates[0]; confidence = 'self_cls'; }
        }
      }

      // Strategy 1b — Swift/C++ type-name resolution (capitalized receiver = type/class reference)
      // In Swift and C++, there are no intra-module imports, so cross-file calls appear as
      // TypeName.method() or TypeName::method(). A capitalized receiver with no same-file
      // class of that name is a reliable signal for a cross-file type reference.
      if (!calleeNode && raw.calleeObject && (callerNode.language === 'Swift' || callerNode.language === 'C++')) {
        const ch = raw.calleeObject.charCodeAt(0);
        const isCapitalized = ch >= 65 && ch <= 90; // A-Z
        if (isCapitalized) {
          const candidates = trie.findByQualifiedName(raw.calleeObject, raw.calleeName);
          if (candidates.length > 0) { calleeNode = candidates[0]; confidence = 'type_name'; }
        }
      }

      // Strategy 2 — type inference on receiver variable
      if (!calleeNode && raw.calleeObject) {
        const fileContent = fileContents.get(callerNode.filePath);
        if (fileContent) {
          const bodySlice = fileContent.slice(callerNode.startIndex, callerNode.endIndex);
          const inferredTypes = inferTypesFromSource(bodySlice, callerNode.language);
          const resolved = resolveViaTypeInference(raw.calleeObject, raw.calleeName, inferredTypes, trie);
          if (resolved) { calleeNode = resolved; confidence = 'type_inference'; }
        }
      }

      // Strategy 3 — import resolution (TS/JS/Python/Go/Rust/Ruby/Java)
      if (!calleeNode && importMap) {
        const importedFile = importMap.get(callerNode.filePath)?.get(raw.calleeName)
          ?? (raw.calleeObject ? importMap.get(callerNode.filePath)?.get(raw.calleeObject) : undefined);
        if (importedFile) {
          const candidates = trie.findBySimpleName(raw.calleeName).filter(n => n.filePath.startsWith(importedFile));
          if (candidates.length > 0) { calleeNode = candidates[0]; confidence = 'import'; }
        }
      }

      // Strategy 4 — same-file preference (only for calls without a typed receiver)
      // When a receiver is explicitly present but unresolvable (e.g. redis_client.get()),
      // skip name_only fallback to avoid false-positive edges.
      if (!calleeNode && !raw.calleeObject) {
        const candidates = trie.findBySimpleName(raw.calleeName);
        if (candidates.length === 0) {
          // Unresolved bare call — create a synthetic external leaf node
          calleeNode = getOrCreateExternalNode(raw.calleeName, allNodes);
          confidence = 'external';
        } else {
          const sameFile = candidates.find(c => c.filePath === callerNode.filePath);
          if (sameFile) { calleeNode = sameFile; confidence = 'same_file'; }
          else { calleeNode = candidates[0]; confidence = 'name_only'; }
        }
      }

      if (!calleeNode) {
        // Unresolved receiver-based call (e.g. redis_client.get()) — synthetic external node
        const label = raw.calleeObject
          ? `${raw.calleeObject}.${raw.calleeName}`
          : raw.calleeName;
        calleeNode = getOrCreateExternalNode(label, allNodes);
        confidence = 'external';
      }

      const callType: CallType = raw.callType
        ?? (raw.calleeObject ? 'method' : 'direct');

      edges.push({
        callerId: raw.callerId,
        calleeId: calleeNode.id,
        calleeName: raw.calleeName,
        line: raw.line,
        confidence,
        kind: 'calls',
        callType,
      });
    }

    // Pass 2b: HTTP cross-language edges (JS/TS caller → Python handler)
    try {
      const filePaths = files.map(f => f.path);
      const { edges: httpEdges } = await extractAllHttpEdges(filePaths);
      for (const he of httpEdges) {
        // Find callee: handler function by name in handlerFile
        const calleeNode = trie.findBySimpleName(he.route.handlerName)
          .find(n => n.filePath === he.handlerFile);
        if (!calleeNode) continue;

        // Find caller: any function in callerFile that encloses the HTTP call's line
        const callerContent = fileContents.get(he.callerFile);
        const callerNode = callerContent
          ? (() => {
              let offset = 0;
              const lines = callerContent.split('\n');
              for (let i = 0; i < he.call.line - 1 && i < lines.length; i++) {
                offset += lines[i].length + 1;
              }
              const candidates = Array.from(allNodes.values())
                .filter(n => n.filePath === he.callerFile);
              return findEnclosingFunction(candidates, offset);
            })()
          : undefined;
        if (!callerNode) continue;

        edges.push({
          callerId: callerNode.id,
          calleeId: calleeNode.id,
          calleeName: he.route.handlerName,
          line: he.call.line,
          confidence: 'http_endpoint',
          kind: 'calls',
          callType: 'direct',
        });
      }
    } catch {
      // HTTP edge extraction is best-effort; don't fail the whole build
    }

    // Pass 3: Calculate fanIn / fanOut (count unique caller→callee pairs, not call sites)
    const seenPairs = new Set<string>();
    for (const edge of edges) {
      const pairKey = `${edge.callerId}\0${edge.calleeId}`;
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);
      const caller = allNodes.get(edge.callerId);
      const callee = allNodes.get(edge.calleeId);
      if (caller) caller.fanOut++;
      if (callee) callee.fanIn++;
    }

    // Pass 3b: Derive tested_by edges — reverse edges from production fn ← test fn
    const callsEdges = edges.filter(e => !e.kind || e.kind === 'calls');
    for (const edge of callsEdges) {
      const caller = allNodes.get(edge.callerId);
      if (!caller || !isTestFile(caller.filePath)) continue;
      edges.push({
        kind: 'tested_by',
        callerId: edge.calleeId,
        calleeId: edge.callerId,
        calleeName: caller.name,
        confidence: edge.confidence,
        callType: undefined,
      });
    }

    // Pass 4: Derive hub functions, entry points, layer violations
    // External nodes are excluded from structural stats — they are leaf placeholders
    const nodes = Array.from(allNodes.values());
    const internalNodes = nodes.filter(n => !n.isExternal);

    const hubFunctions = internalNodes
      .filter(n => n.fanIn >= HUB_THRESHOLD)
      .sort((a, b) => b.fanIn - a.fanIn);

    const calledIds = new Set(edges.map(e => e.calleeId));
    const entryPoints = internalNodes
      .filter(n => !calledIds.has(n.id))
      .sort((a, b) => b.fanOut - a.fanOut);

    const layerViolations = layers
      ? this.detectLayerViolations(edges, allNodes, layers)
      : [];

    const totalFanIn = internalNodes.reduce((s, n) => s + n.fanIn, 0);
    const totalFanOut = internalNodes.reduce((s, n) => s + n.fanOut, 0);

    // Pass 5: Build class hierarchy (inheritance + grouping)
    const relationships = await extractClassRelationships(files);
    const { classes, inheritanceEdges } = buildClassNodes(allNodes, relationships);

    return {
      nodes: allNodes,
      edges,
      classes,
      inheritanceEdges,
      hubFunctions,
      entryPoints,
      layerViolations,
      stats: {
        totalNodes: internalNodes.length,
        totalEdges: edges.filter(e => !e.kind || e.kind === 'calls').length,
        avgFanIn: internalNodes.length > 0 ? totalFanIn / internalNodes.length : 0,
        avgFanOut: internalNodes.length > 0 ? totalFanOut / internalNodes.length : 0,
      },
    };
  }

  private detectLayerViolations(
    edges: CallEdge[],
    nodes: Map<string, FunctionNode>,
    layers: Record<string, string[]>
  ): LayerViolation[] {
    // Build ordered layer list (index 0 = top layer, higher index = lower layer)
    const layerOrder = Object.keys(layers);

    const getLayer = (filePath: string): string | undefined => {
      for (const [layerName, prefixes] of Object.entries(layers)) {
        if (prefixes.some(p => filePath.includes(p))) return layerName;
      }
      return undefined;
    };

    const violations: LayerViolation[] = [];
    for (const edge of edges) {
      const caller = nodes.get(edge.callerId);
      const callee = nodes.get(edge.calleeId);
      if (!caller || !callee) continue;

      const callerLayer = getLayer(caller.filePath);
      const calleeLayer = getLayer(callee.filePath);
      if (!callerLayer || !calleeLayer || callerLayer === calleeLayer) continue;

      const callerIdx = layerOrder.indexOf(callerLayer);
      const calleeIdx = layerOrder.indexOf(calleeLayer);
      if (callerIdx === -1 || calleeIdx === -1) continue;
      if (callerIdx > calleeIdx) {
        // Lower layer calling upper layer — violation
        violations.push({
          callerId: edge.callerId,
          calleeId: edge.calleeId,
          callerLayer,
          calleeLayer,
          reason: `${callerLayer} calls ${calleeLayer} (${caller.name} → ${callee.name})`,
        });
      }
    }

    return violations;
  }
}

// ============================================================================
// SERIALIZATION HELPER
// ============================================================================

export function serializeCallGraph(result: CallGraphResult): SerializedCallGraph {
  return {
    nodes: Array.from(result.nodes.values()),
    edges: result.edges,
    classes: result.classes,
    inheritanceEdges: result.inheritanceEdges,
    hubFunctions: result.hubFunctions,
    entryPoints: result.entryPoints,
    layerViolations: result.layerViolations,
    stats: result.stats,
  };
}
