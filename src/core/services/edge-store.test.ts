import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EdgeStore } from './edge-store.js';
import type { CallEdge, FunctionNode, ClassNode } from '../analyzer/call-graph.js';

async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'edge-store-test-'));
}

const edgeAB: CallEdge = {
  callerId:   'src/a.ts::foo',
  calleeId:   'src/b.ts::bar',
  calleeName: 'bar',
  confidence: 'import',
};

const edgeCA: CallEdge = {
  callerId:   'src/c.ts::baz',
  calleeId:   'src/a.ts::foo',
  calleeName: 'foo',
  confidence: 'name_only',
  line:       12,
};

describe('EdgeStore', () => {
  let dir: string;
  let dbPath: string;
  let store: EdgeStore;

  beforeEach(async () => {
    dir = await makeTmpDir();
    dbPath = join(dir, 'call-graph.db');
    store = EdgeStore.open(dbPath);
    store.insertEdges([edgeAB, edgeCA]);
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  describe('exists / dbPath helpers', () => {
    it('exists() returns true when DB is present', () => {
      expect(EdgeStore.exists(dir)).toBe(true);
    });

    it('exists() returns false when no DB', async () => {
      const empty = await makeTmpDir();
      try {
        expect(EdgeStore.exists(empty)).toBe(false);
      } finally {
        await rm(empty, { recursive: true, force: true });
      }
    });

    it('dbPath() returns the correct path', () => {
      expect(EdgeStore.dbPath(dir)).toBe(join(dir, 'call-graph.db'));
    });
  });

  describe('getCallerFiles', () => {
    it('returns files that call into calleeFile', () => {
      const callers = store.getCallerFiles('src/b.ts');
      expect(callers).toContain('src/a.ts');
    });

    it('returns empty array when nothing calls the file', () => {
      expect(store.getCallerFiles('src/nonexistent.ts')).toEqual([]);
    });

    it('returns all distinct caller files (no duplicates)', () => {
      const extra: CallEdge = { callerId: 'src/a.ts::foo2', calleeId: 'src/b.ts::bar', calleeName: 'bar', confidence: 'import' };
      store.insertEdges([extra]);
      const callers = store.getCallerFiles('src/b.ts');
      expect(callers).toHaveLength(1);
      expect(callers[0]).toBe('src/a.ts');
    });
  });

  describe('getEdgesForFile', () => {
    it('returns outgoing edges for caller file', () => {
      const { outgoing } = store.getEdgesForFile('src/a.ts');
      expect(outgoing).toHaveLength(1);
      expect(outgoing[0].calleeId).toBe('src/b.ts::bar');
    });

    it('returns incoming edges for callee file', () => {
      const { incoming } = store.getEdgesForFile('src/b.ts');
      expect(incoming).toHaveLength(1);
      expect(incoming[0].callerId).toBe('src/a.ts::foo');
    });

    it('round-trips optional fields (line, confidence)', () => {
      const { outgoing } = store.getEdgesForFile('src/c.ts');
      expect(outgoing[0].line).toBe(12);
      expect(outgoing[0].confidence).toBe('name_only');
    });
  });

  describe('deleteEdgesForFile', () => {
    it('removes edges where file is caller', () => {
      store.deleteEdgesForFile('src/a.ts');
      expect(store.getEdgesForFile('src/a.ts').outgoing).toHaveLength(0);
    });

    it('removes edges where file is callee', () => {
      store.deleteEdgesForFile('src/b.ts');
      expect(store.getEdgesForFile('src/a.ts').outgoing).toHaveLength(0);
    });

    it('does not remove unrelated edges', () => {
      store.deleteEdgesForFile('src/b.ts');
      // edgeCA (c → a) is unrelated to b
      const { outgoing } = store.getEdgesForFile('src/c.ts');
      expect(outgoing).toHaveLength(1);
    });
  });

  describe('deleteOutgoingEdgesForFile', () => {
    it('removes only outgoing edges, leaving incoming intact', () => {
      // src/a.ts has outgoing edge to src/b.ts and incoming from src/c.ts
      store.deleteOutgoingEdgesForFile('src/a.ts');
      expect(store.getEdgesForFile('src/a.ts').outgoing).toHaveLength(0);
      // incoming from c → a should still be present
      expect(store.getEdgesForFile('src/a.ts').incoming).toHaveLength(1);
    });
  });

  describe('insertEdges', () => {
    it('inserts edges that are then queryable', () => {
      const newEdge: CallEdge = { callerId: 'src/d.ts::qux', calleeId: 'src/a.ts::foo', calleeName: 'foo', confidence: 'same_file' };
      store.insertEdges([newEdge]);
      const callers = store.getCallerFiles('src/a.ts');
      expect(callers).toContain('src/d.ts');
    });
  });

  describe('nodes', () => {
    const nodeA: FunctionNode = {
      id: 'src/a.ts::foo', name: 'foo', filePath: 'src/a.ts',
      isAsync: false, language: 'TypeScript', startIndex: 0, endIndex: 10,
      fanIn: 1, fanOut: 2,
    };
    const nodeB: FunctionNode = {
      id: 'src/b.ts::bar', name: 'bar', filePath: 'src/b.ts',
      isAsync: true, language: 'TypeScript', startIndex: 5, endIndex: 20,
      fanIn: 0, fanOut: 0,
    };
    const nodeExternal: FunctionNode = {
      id: 'src/b.ts::baz', name: 'baz', filePath: 'src/b.ts',
      isAsync: false, language: 'TypeScript', startIndex: 0, endIndex: 5,
      fanIn: 0, fanOut: 0, isExternal: true,
    };

    it('insertNodes + getNode round-trips basic fields', () => {
      store.insertNodes([nodeA]);
      const got = store.getNode(nodeA.id);
      expect(got?.name).toBe('foo');
      expect(got?.filePath).toBe('src/a.ts');
      expect(got?.isAsync).toBe(false);
      expect(got?.fanIn).toBe(1);
    });

    it('getNode returns null for unknown id', () => {
      expect(store.getNode('no::such')).toBeNull();
    });

    it('getNodesForFile returns all nodes in file', () => {
      store.insertNodes([nodeA, nodeB]);
      expect(store.getNodesForFile('src/a.ts')).toHaveLength(1);
      expect(store.getNodesForFile('src/b.ts')).toHaveLength(1);
    });

    it('deleteNodesForFile removes only that file', () => {
      store.insertNodes([nodeA, nodeB]);
      store.deleteNodesForFile('src/a.ts');
      expect(store.getNode(nodeA.id)).toBeNull();
      expect(store.getNode(nodeB.id)).not.toBeNull();
    });

    it('insertNodes stamps is_hub and is_entry_point from sets', () => {
      store.insertNodes([nodeA, nodeB], new Set([nodeA.id]), new Set([nodeB.id]));
      const hubs = store.getHubs(10);
      expect(hubs.some(n => n.id === nodeA.id)).toBe(true);
      const entries = store.getEntryPoints(10);
      expect(entries.some(n => n.id === nodeB.id)).toBe(true);
    });

    it('countNodes excludes external nodes', () => {
      store.insertNodes([nodeA, nodeB, nodeExternal]);
      expect(store.countNodes()).toBe(2); // nodeExternal excluded
    });

    it('searchNodes finds by name substring', () => {
      store.insertNodes([nodeA, nodeB]);
      const results = store.searchNodes('fo');
      expect(results.some(n => n.id === nodeA.id)).toBe(true);
    });

    it('getCallers returns edges where node is callee', () => {
      store.insertNodes([nodeA]);
      const callers = store.getCallers(nodeA.id);
      // edgeCA: src/c.ts::baz → src/a.ts::foo
      expect(callers.some(e => e.callerId === 'src/c.ts::baz')).toBe(true);
    });

    it('getCallees returns edges where node is caller', () => {
      store.insertNodes([nodeA]);
      const callees = store.getCallees(nodeA.id);
      // edgeAB: src/a.ts::foo → src/b.ts::bar
      expect(callees.some(e => e.calleeId === 'src/b.ts::bar')).toBe(true);
    });

    it('clearAll removes all nodes and edges', () => {
      store.insertNodes([nodeA, nodeB]);
      store.clearAll();
      expect(store.getNode(nodeA.id)).toBeNull();
      expect(store.getEdgesForFile('src/a.ts').outgoing).toHaveLength(0);
      expect(store.countNodes()).toBe(0);
    });
  });

  describe('classes', () => {
    const cls: ClassNode = {
      id: 'src/a.ts::Foo', name: 'Foo', filePath: 'src/a.ts',
      language: 'TypeScript', parentClasses: ['Base'], interfaces: ['IFoo'],
      methodIds: ['src/a.ts::Foo::method'], fanIn: 2, fanOut: 3,
    };

    it('insertClasses + getClass round-trips', () => {
      store.insertClasses([cls]);
      const got = store.getClass(cls.id);
      expect(got?.name).toBe('Foo');
      expect(got?.parentClasses).toEqual(['Base']);
      expect(got?.interfaces).toEqual(['IFoo']);
      expect(got?.methodIds).toEqual(['src/a.ts::Foo::method']);
    });

    it('getClassesForFile returns all classes in file', () => {
      store.insertClasses([cls]);
      expect(store.getClassesForFile('src/a.ts')).toHaveLength(1);
      expect(store.getClassesForFile('src/b.ts')).toHaveLength(0);
    });

    it('deleteClassesForFile removes only that file', () => {
      store.insertClasses([cls]);
      store.deleteClassesForFile('src/a.ts');
      expect(store.getClass(cls.id)).toBeNull();
    });
  });

  describe('file hash cache', () => {
    it('returns null when hash not set', () => {
      expect(store.getFileHash('src/a.ts')).toBeNull();
    });

    it('stores and retrieves a hash', () => {
      store.setFileHash('src/a.ts', 'abc123');
      expect(store.getFileHash('src/a.ts')).toBe('abc123');
    });

    it('overwrites an existing hash', () => {
      store.setFileHash('src/a.ts', 'old');
      store.setFileHash('src/a.ts', 'new');
      expect(store.getFileHash('src/a.ts')).toBe('new');
    });
  });
});
