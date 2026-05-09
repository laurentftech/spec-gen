import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { CallEdge, FunctionNode, ClassNode, InheritanceEdge } from '../analyzer/call-graph.js';
import { ARTIFACT_CALL_GRAPH_DB } from '../../constants.js';

const require = createRequire(import.meta.url);

function openDatabase(dbPath: string): import('better-sqlite3').Database {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
  const DatabaseCtor = require('better-sqlite3') as any;
  const db: import('better-sqlite3').Database = new DatabaseCtor(dbPath) as import('better-sqlite3').Database;
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  return db;
}

/** Bump when schema changes. Old DBs are dropped and rebuilt on next analyze --force. */
const SCHEMA_VERSION = 2;

export class EdgeStore {
  private constructor(private readonly db: import('better-sqlite3').Database) {
    this.initSchema();
  }

  private initSchema(): void {
    // Version check — if schema changed, wipe and rebuild (analyze --force repopulates).
    this.db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`);
    const row = this.db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | undefined;
    if (row === undefined) {
      this.db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
    } else if (row.version !== SCHEMA_VERSION) {
      this.db.exec(`
        DROP TABLE IF EXISTS edges;
        DROP TABLE IF EXISTS inheritance_edges;
        DROP TABLE IF EXISTS nodes;
        DROP TABLE IF EXISTS classes;
        DROP TABLE IF EXISTS file_hashes;
        DROP TABLE IF EXISTS schema_version;
        CREATE TABLE schema_version (version INTEGER NOT NULL);
      `);
      this.db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS edges (
        caller_id   TEXT NOT NULL,
        caller_file TEXT NOT NULL,
        callee_id   TEXT NOT NULL,
        callee_file TEXT,
        callee_name TEXT NOT NULL,
        line        INTEGER,
        confidence  TEXT,
        kind        TEXT,
        call_type   TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_caller_id   ON edges(caller_id);
      CREATE INDEX IF NOT EXISTS idx_callee_id   ON edges(callee_id);
      CREATE INDEX IF NOT EXISTS idx_caller_file ON edges(caller_file);
      CREATE INDEX IF NOT EXISTS idx_callee_file ON edges(callee_file);

      CREATE TABLE IF NOT EXISTS inheritance_edges (
        parent_id TEXT NOT NULL,
        child_id  TEXT NOT NULL,
        kind      TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_inh_parent ON inheritance_edges(parent_id);
      CREATE INDEX IF NOT EXISTS idx_inh_child  ON inheritance_edges(child_id);

      CREATE TABLE IF NOT EXISTS nodes (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        file_path     TEXT NOT NULL,
        class_name    TEXT,
        is_async      INTEGER NOT NULL DEFAULT 0,
        language      TEXT NOT NULL DEFAULT '',
        start_index   INTEGER NOT NULL DEFAULT 0,
        end_index     INTEGER NOT NULL DEFAULT 0,
        fan_in        INTEGER NOT NULL DEFAULT 0,
        fan_out       INTEGER NOT NULL DEFAULT 0,
        docstring     TEXT,
        signature     TEXT,
        is_external   INTEGER NOT NULL DEFAULT 0,
        external_kind TEXT,
        is_hub        INTEGER NOT NULL DEFAULT 0,
        is_entry_point INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_node_file ON nodes(file_path);
      CREATE INDEX IF NOT EXISTS idx_node_name ON nodes(name);

      CREATE TABLE IF NOT EXISTS classes (
        id             TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        file_path      TEXT NOT NULL,
        language       TEXT NOT NULL DEFAULT '',
        parent_classes TEXT NOT NULL DEFAULT '[]',
        interfaces     TEXT NOT NULL DEFAULT '[]',
        method_ids     TEXT NOT NULL DEFAULT '[]',
        fan_in         INTEGER NOT NULL DEFAULT 0,
        fan_out        INTEGER NOT NULL DEFAULT 0,
        is_module      INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_class_file ON classes(file_path);
      CREATE INDEX IF NOT EXISTS idx_class_name ON classes(name);

      CREATE TABLE IF NOT EXISTS file_hashes (
        file_path    TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        updated_at   INTEGER NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(node_id UNINDEXED, name, tokenize='trigram');
    `);
  }

  // ── Edge queries ──────────────────────────────────────────────────────────────

  /** All distinct files that call into calleeFile (reverse lookup before delete). */
  getCallerFiles(calleeFile: string): string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT caller_file FROM edges WHERE callee_file = ?')
      .all(calleeFile) as Array<{ caller_file: string }>;
    return rows.map(r => r.caller_file);
  }

  /** All outgoing + incoming edges touching a file. */
  getEdgesForFile(file: string): { outgoing: CallEdge[]; incoming: CallEdge[] } {
    const outgoing = (
      this.db.prepare('SELECT * FROM edges WHERE caller_file = ?').all(file) as RawEdge[]
    ).map(rawToCallEdge);
    const incoming = (
      this.db.prepare('SELECT * FROM edges WHERE callee_file = ?').all(file) as RawEdge[]
    ).map(rawToCallEdge);
    return { outgoing, incoming };
  }

  /** Outgoing edges from a node ID (its direct callees). */
  getCallees(nodeId: string): CallEdge[] {
    return (
      this.db.prepare('SELECT * FROM edges WHERE caller_id = ?').all(nodeId) as RawEdge[]
    ).map(rawToCallEdge);
  }

  /** Incoming edges to a node ID (its direct callers). */
  getCallers(nodeId: string): CallEdge[] {
    return (
      this.db.prepare('SELECT * FROM edges WHERE callee_id = ?').all(nodeId) as RawEdge[]
    ).map(rawToCallEdge);
  }

  /** Batch: outgoing edges for a set of caller IDs — one query instead of N. */
  getCalleesForIds(callerIds: string[]): CallEdge[] {
    if (callerIds.length === 0) return [];
    const placeholders = callerIds.map(() => '?').join(',');
    return (
      this.db.prepare(`SELECT * FROM edges WHERE caller_id IN (${placeholders})`).all(...callerIds) as RawEdge[]
    ).map(rawToCallEdge);
  }

  /** Batch: incoming edges for a set of callee IDs — one query instead of N. */
  getCallersForIds(calleeIds: string[]): CallEdge[] {
    if (calleeIds.length === 0) return [];
    const placeholders = calleeIds.map(() => '?').join(',');
    return (
      this.db.prepare(`SELECT * FROM edges WHERE callee_id IN (${placeholders})`).all(...calleeIds) as RawEdge[]
    ).map(rawToCallEdge);
  }

  // ── Edge mutations ────────────────────────────────────────────────────────────

  /** Remove all edges where this file is caller or callee. */
  deleteEdgesForFile(file: string): void {
    this.db.prepare('DELETE FROM edges WHERE caller_file = ? OR callee_file = ?').run(file, file);
  }

  /** Remove only outgoing edges from this file (incoming edges remain). */
  deleteOutgoingEdgesForFile(file: string): void {
    this.db.prepare('DELETE FROM edges WHERE caller_file = ?').run(file);
  }

  /** Bulk-insert edges in a single transaction. */
  insertEdges(edges: CallEdge[]): void {
    const stmt = this.db.prepare(`
      INSERT INTO edges (caller_id, caller_file, callee_id, callee_file, callee_name, line, confidence, kind, call_type)
      VALUES (@callerId, @callerFile, @calleeId, @calleeFile, @calleeName, @line, @confidence, @kind, @callType)
    `);
    const insert = this.db.transaction((batch: CallEdge[]) => {
      for (const e of batch) {
        const callerFile = e.callerId.includes('::') ? e.callerId.split('::')[0] : e.callerId;
        const calleeFile = e.calleeId.includes('::') ? e.calleeId.split('::')[0] : null;
        stmt.run({
          callerId:   e.callerId,
          callerFile,
          calleeId:   e.calleeId,
          calleeFile,
          calleeName: e.calleeName,
          line:       e.line ?? null,
          confidence: e.confidence,
          kind:       e.kind ?? null,
          callType:   e.callType ?? null,
        });
      }
    });
    insert(edges);
  }

  /** Bulk-insert inheritance edges in a single transaction. */
  insertInheritanceEdges(edges: InheritanceEdge[]): void {
    const stmt = this.db.prepare(
      'INSERT INTO inheritance_edges (parent_id, child_id, kind) VALUES (@parentId, @childId, @kind)'
    );
    const insert = this.db.transaction((batch: InheritanceEdge[]) => {
      for (const e of batch) {
        stmt.run({ parentId: e.parentId, childId: e.childId, kind: e.kind ?? null });
      }
    });
    insert(edges);
  }

  // ── Node queries ──────────────────────────────────────────────────────────────

  getNode(id: string): FunctionNode | null {
    const row = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as RawNode | undefined;
    return row ? rawToFunctionNode(row) : null;
  }

  getNodesForFile(file: string): FunctionNode[] {
    return (
      this.db.prepare('SELECT * FROM nodes WHERE file_path = ?').all(file) as RawNode[]
    ).map(rawToFunctionNode);
  }

  /** Case-insensitive substring search on node name. FTS5 trigram for ≥3 chars, LIKE fallback otherwise. */
  searchNodes(pattern: string, limit = 50): FunctionNode[] {
    if (pattern.length >= 3) {
      return (
        this.db
          .prepare(`
            SELECT n.* FROM nodes_fts f
            JOIN nodes n ON n.id = f.node_id
            WHERE nodes_fts MATCH ? AND n.is_external = 0
            LIMIT ?
          `)
          .all(pattern, limit) as RawNode[]
      ).map(rawToFunctionNode);
    }
    return (
      this.db
        .prepare('SELECT * FROM nodes WHERE name LIKE ? AND is_external = 0 LIMIT ?')
        .all(`%${pattern}%`, limit) as RawNode[]
    ).map(rawToFunctionNode);
  }

  getHubs(limit = 25): FunctionNode[] {
    return (
      this.db
        .prepare('SELECT * FROM nodes WHERE is_hub = 1 AND is_external = 0 ORDER BY fan_in DESC LIMIT ?')
        .all(limit) as RawNode[]
    ).map(rawToFunctionNode);
  }

  getEntryPoints(limit = 50): FunctionNode[] {
    return (
      this.db
        .prepare('SELECT * FROM nodes WHERE is_entry_point = 1 AND is_external = 0 ORDER BY fan_out DESC LIMIT ?')
        .all(limit) as RawNode[]
    ).map(rawToFunctionNode);
  }

  countNodes(): number {
    const row = this.db.prepare('SELECT COUNT(*) as n FROM nodes WHERE is_external = 0').get() as { n: number };
    return row.n;
  }

  // ── Node mutations ────────────────────────────────────────────────────────────

  deleteNodesForFile(file: string): void {
    const ids = (
      this.db.prepare('SELECT id FROM nodes WHERE file_path = ?').all(file) as Array<{ id: string }>
    ).map(r => r.id);
    this.db.prepare('DELETE FROM nodes WHERE file_path = ?').run(file);
    if (ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',');
      this.db.prepare(`DELETE FROM nodes_fts WHERE node_id IN (${placeholders})`).run(...ids);
    }
  }

  /**
   * Bulk-insert nodes. hubIds/entryIds are optional sets used to mark flags;
   * omit them during incremental watcher updates (flags preserved from last analyze).
   */
  insertNodes(nodes: FunctionNode[], hubIds?: Set<string>, entryIds?: Set<string>): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO nodes
        (id, name, file_path, class_name, is_async, language, start_index, end_index,
         fan_in, fan_out, docstring, signature, is_external, external_kind, is_hub, is_entry_point)
      VALUES
        (@id, @name, @filePath, @className, @isAsync, @language, @startIndex, @endIndex,
         @fanIn, @fanOut, @docstring, @signature, @isExternal, @externalKind, @isHub, @isEntryPoint)
    `);
    const ftsStmt = this.db.prepare('INSERT OR REPLACE INTO nodes_fts (node_id, name) VALUES (?, ?)');
    const insert = this.db.transaction((batch: FunctionNode[]) => {
      for (const n of batch) {
        stmt.run({
          id:           n.id,
          name:         n.name,
          filePath:     n.filePath,
          className:    n.className ?? null,
          isAsync:      n.isAsync ? 1 : 0,
          language:     n.language,
          startIndex:   n.startIndex,
          endIndex:     n.endIndex,
          fanIn:        n.fanIn,
          fanOut:       n.fanOut,
          docstring:    n.docstring ?? null,
          signature:    n.signature ?? null,
          isExternal:   n.isExternal ? 1 : 0,
          externalKind: n.externalKind ?? null,
          isHub:        hubIds ? (hubIds.has(n.id) ? 1 : 0) : 0,
          isEntryPoint: entryIds ? (entryIds.has(n.id) ? 1 : 0) : 0,
        });
        if (!n.isExternal) ftsStmt.run(n.id, n.name);
      }
    });
    insert(nodes);
  }

  // ── Class queries ─────────────────────────────────────────────────────────────

  getClass(id: string): ClassNode | null {
    const row = this.db.prepare('SELECT * FROM classes WHERE id = ?').get(id) as RawClass | undefined;
    return row ? rawToClassNode(row) : null;
  }

  getClassesForFile(file: string): ClassNode[] {
    return (
      this.db.prepare('SELECT * FROM classes WHERE file_path = ?').all(file) as RawClass[]
    ).map(rawToClassNode);
  }

  // ── Class mutations ───────────────────────────────────────────────────────────

  deleteClassesForFile(file: string): void {
    this.db.prepare('DELETE FROM classes WHERE file_path = ?').run(file);
  }

  insertClasses(classes: ClassNode[]): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO classes
        (id, name, file_path, language, parent_classes, interfaces, method_ids, fan_in, fan_out, is_module)
      VALUES
        (@id, @name, @filePath, @language, @parentClasses, @interfaces, @methodIds, @fanIn, @fanOut, @isModule)
    `);
    const insert = this.db.transaction((batch: ClassNode[]) => {
      for (const c of batch) {
        stmt.run({
          id:            c.id,
          name:          c.name,
          filePath:      c.filePath,
          language:      c.language,
          parentClasses: JSON.stringify(c.parentClasses),
          interfaces:    JSON.stringify(c.interfaces),
          methodIds:     JSON.stringify(c.methodIds),
          fanIn:         c.fanIn,
          fanOut:        c.fanOut,
          isModule:      c.isModule ? 1 : 0,
        });
      }
    });
    insert(classes);
  }

  // ── Content-hash cache ────────────────────────────────────────────────────────

  getFileHash(filePath: string): string | null {
    const row = this.db
      .prepare('SELECT content_hash FROM file_hashes WHERE file_path = ?')
      .get(filePath) as { content_hash: string } | undefined;
    return row?.content_hash ?? null;
  }

  setFileHash(filePath: string, hash: string): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO file_hashes (file_path, content_hash, updated_at) VALUES (?, ?, ?)'
      )
      .run(filePath, hash, Date.now());
  }

  /** Drop all graph data — used by full analyze rebuild. */
  clearAll(): void {
    this.db.exec('DELETE FROM edges; DELETE FROM inheritance_edges; DELETE FROM nodes; DELETE FROM classes; DELETE FROM nodes_fts; DELETE FROM file_hashes;');
  }

  /** Run fn inside a single SQLite transaction. Nested calls use savepoints. */
  transaction(fn: () => void): void {
    this.db.transaction(fn)();
  }

  close(): void {
    this.db.close();
  }

  // ── Factory ───────────────────────────────────────────────────────────────────

  static open(dbPath: string): EdgeStore {
    return new EdgeStore(openDatabase(dbPath));
  }

  static exists(outputDir: string): boolean {
    return existsSync(join(outputDir, ARTIFACT_CALL_GRAPH_DB));
  }

  static dbPath(outputDir: string): string {
    return join(outputDir, ARTIFACT_CALL_GRAPH_DB);
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

interface RawEdge {
  caller_id:   string;
  caller_file: string;
  callee_id:   string;
  callee_file: string | null;
  callee_name: string;
  line:        number | null;
  confidence:  string;
  kind:        string | null;
  call_type:   string | null;
}

interface RawNode {
  id:             string;
  name:           string;
  file_path:      string;
  class_name:     string | null;
  is_async:       number;
  language:       string;
  start_index:    number;
  end_index:      number;
  fan_in:         number;
  fan_out:        number;
  docstring:      string | null;
  signature:      string | null;
  is_external:    number;
  external_kind:  string | null;
  is_hub:         number;
  is_entry_point: number;
}

interface RawClass {
  id:             string;
  name:           string;
  file_path:      string;
  language:       string;
  parent_classes: string;
  interfaces:     string;
  method_ids:     string;
  fan_in:         number;
  fan_out:        number;
  is_module:      number;
}

function rawToCallEdge(r: RawEdge): CallEdge {
  return {
    callerId:   r.caller_id,
    calleeId:   r.callee_id,
    calleeName: r.callee_name,
    ...(r.line !== null && { line: r.line }),
    confidence: r.confidence as CallEdge['confidence'],
    ...(r.kind      && { kind:     r.kind     as CallEdge['kind'] }),
    ...(r.call_type && { callType: r.call_type as CallEdge['callType'] }),
  };
}

function rawToFunctionNode(r: RawNode): FunctionNode {
  return {
    id:          r.id,
    name:        r.name,
    filePath:    r.file_path,
    ...(r.class_name && { className: r.class_name }),
    isAsync:     r.is_async === 1,
    language:    r.language,
    startIndex:  r.start_index,
    endIndex:    r.end_index,
    fanIn:       r.fan_in,
    fanOut:      r.fan_out,
    ...(r.docstring    && { docstring:    r.docstring }),
    ...(r.signature    && { signature:    r.signature }),
    ...(r.is_external  && { isExternal:   true }),
    ...(r.external_kind && { externalKind: r.external_kind as FunctionNode['externalKind'] }),
  };
}

function rawToClassNode(r: RawClass): ClassNode {
  return {
    id:            r.id,
    name:          r.name,
    filePath:      r.file_path,
    language:      r.language,
    parentClasses: JSON.parse(r.parent_classes) as string[],
    interfaces:    JSON.parse(r.interfaces) as string[],
    methodIds:     JSON.parse(r.method_ids) as string[],
    fanIn:         r.fan_in,
    fanOut:        r.fan_out,
    ...(r.is_module && { isModule: true }),
  };
}
