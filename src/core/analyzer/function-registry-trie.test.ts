import { describe, it, expect } from 'vitest';
import { FunctionRegistryTrie } from './function-registry-trie.js';
import type { FunctionNode } from './call-graph.js';

function makeNode(overrides: Partial<FunctionNode> & { name: string; filePath: string }): FunctionNode {
  return {
    id: overrides.className
      ? `${overrides.filePath}::${overrides.className}.${overrides.name}`
      : `${overrides.filePath}::${overrides.name}`,
    isAsync: false,
    language: 'Python',
    startIndex: 0,
    endIndex: 100,
    fanIn: 0,
    fanOut: 0,
    ...overrides,
  };
}

describe('FunctionRegistryTrie', () => {
  it('finds by simple name', () => {
    const trie = new FunctionRegistryTrie();
    const node = makeNode({ name: 'process', filePath: 'a.py' });
    trie.insert(node);
    expect(trie.findBySimpleName('process')).toHaveLength(1);
    expect(trie.findBySimpleName('missing')).toHaveLength(0);
  });

  it('finds by qualified name', () => {
    const trie = new FunctionRegistryTrie();
    trie.insert(makeNode({ name: 'handle', className: 'Handler', filePath: 'h.py' }));
    trie.insert(makeNode({ name: 'handle', className: 'OtherHandler', filePath: 'o.py' }));
    expect(trie.findByQualifiedName('Handler', 'handle')).toHaveLength(1);
    expect(trie.findByQualifiedName('Handler', 'handle')[0].filePath).toBe('h.py');
    expect(trie.findByQualifiedName('OtherHandler', 'handle')[0].filePath).toBe('o.py');
  });

  it('returns empty array for unknown qualified name', () => {
    const trie = new FunctionRegistryTrie();
    trie.insert(makeNode({ name: 'run', filePath: 'main.py' }));
    expect(trie.findByQualifiedName('NoSuchClass', 'run')).toHaveLength(0);
  });

  it('finds by full ID', () => {
    const trie = new FunctionRegistryTrie();
    const node = makeNode({ name: 'run', filePath: 'main.py' });
    trie.insert(node);
    expect(trie.findById(node.id)).toBe(node);
    expect(trie.findById('nope')).toBeUndefined();
  });

  it('allNodes returns every inserted node', () => {
    const trie = new FunctionRegistryTrie();
    const a = makeNode({ name: 'a', filePath: 'x.py' });
    const b = makeNode({ name: 'b', filePath: 'y.py' });
    trie.insert(a);
    trie.insert(b);
    expect(trie.allNodes()).toHaveLength(2);
  });

  it('same-name functions in different files are all returned', () => {
    const trie = new FunctionRegistryTrie();
    trie.insert(makeNode({ name: 'save', filePath: 'user.py' }));
    trie.insert(makeNode({ name: 'save', filePath: 'order.py' }));
    expect(trie.findBySimpleName('save')).toHaveLength(2);
  });
});
