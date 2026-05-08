import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { CallEdge, InheritanceEdge } from '../analyzer/call-graph.js';
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

export class EdgeStore {
  private constructor(private readonly db: import('better-sqlite3').Database) {
    this.initSchema();
  }

  private initSchema(): void {
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

      CREATE TABLE IF NOT EXISTS file_hashes (
        file_path    TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        updated_at   INTEGER NOT NULL
      );
    `);
  }

  // ── Queries ──────────────────────────────────────────────────────────────────

  /** All distinct files that call into calleeFile (for reverse lookup before delete). */
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

  // ── Mutations ────────────────────────────────────────────────────────────────

  /** Remove all edges where this file is caller or callee. */
  deleteEdgesForFile(file: string): void {
    this.db.prepare('DELETE FROM edges WHERE caller_file = ? OR callee_file = ?').run(file, file);
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

  close(): void {
    this.db.close();
  }

  // ── Factory ──────────────────────────────────────────────────────────────────

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
