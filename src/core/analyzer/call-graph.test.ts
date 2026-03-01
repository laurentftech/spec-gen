/**
 * Tests for CallGraphBuilder — all supported languages.
 *
 * Each language section verifies:
 *  - Function/method nodes are extracted
 *  - Call edges are resolved correctly
 *  - fanIn / fanOut are computed correctly
 *  - Hub functions and entry points are derived correctly
 */

import { describe, it, expect } from 'vitest';
import { CallGraphBuilder } from './call-graph.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nodeNames(result: Awaited<ReturnType<CallGraphBuilder['build']>>) {
  return Array.from(result.nodes.values()).map(n => n.name).sort();
}

function edgePairs(result: Awaited<ReturnType<CallGraphBuilder['build']>>) {
  return result.edges.map(e => {
    const callerName = result.nodes.get(e.callerId)?.name ?? e.callerId;
    const calleeName = result.nodes.get(e.calleeId)?.name ?? e.calleeId;
    return `${callerName}→${calleeName}`;
  }).sort();
}

function fanIn(result: Awaited<ReturnType<CallGraphBuilder['build']>>, name: string) {
  return Array.from(result.nodes.values()).find(n => n.name === name)?.fanIn;
}

function fanOut(result: Awaited<ReturnType<CallGraphBuilder['build']>>, name: string) {
  return Array.from(result.nodes.values()).find(n => n.name === name)?.fanOut;
}

// ---------------------------------------------------------------------------
// TypeScript
// ---------------------------------------------------------------------------

describe('CallGraphBuilder — TypeScript', () => {
  it('extracts top-level functions and resolves calls', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'src/main.ts',
      language: 'TypeScript',
      content: `
        function main() { greet(); emit(); }
        function greet() { emit(); }
        function emit() {}
      `,
    }]);

    expect(nodeNames(result)).toEqual(['emit', 'greet', 'main']);
    expect(edgePairs(result)).toEqual(['greet→emit', 'main→emit', 'main→greet'].sort());
    expect(fanIn(result, 'emit')).toBe(2);
    expect(fanOut(result, 'main')).toBe(2);
  });

  it('extracts class methods', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'src/service.ts',
      language: 'TypeScript',
      content: `
        class UserService {
          async getUser() { return this.fetch(); }
          private fetch() {}
        }
      `,
    }]);

    expect(nodeNames(result)).toEqual(['fetch', 'getUser']);
    expect(result.nodes.get('src/service.ts::UserService.getUser')?.isAsync).toBe(true);
    expect(result.nodes.get('src/service.ts::UserService.fetch')?.className).toBe('UserService');
  });

  it('resolves cross-file calls, preferring same-file candidates', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([
      {
        path: 'a.ts',
        language: 'TypeScript',
        content: `function helper() {} function main() { helper(); }`,
      },
      {
        path: 'b.ts',
        language: 'TypeScript',
        content: `function helper() {}`,
      },
    ]);

    // main should resolve to a.ts::helper (same file preference)
    const mainEdge = result.edges.find(e => result.nodes.get(e.callerId)?.name === 'main');
    expect(result.nodes.get(mainEdge!.calleeId)?.filePath).toBe('a.ts');
  });

  it('extracts arrow functions assigned to variables', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'utils.ts',
      language: 'TypeScript',
      content: `
        const transform = (x: number) => x * 2;
        const process = () => { transform(1); };
      `,
    }]);

    expect(nodeNames(result)).toContain('transform');
    expect(nodeNames(result)).toContain('process');
    expect(fanIn(result, 'transform')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// JavaScript
// ---------------------------------------------------------------------------

describe('CallGraphBuilder — JavaScript', () => {
  it('parses JS files using the TypeScript grammar', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'index.js',
      language: 'JavaScript',
      content: `
        function init() { setup(); }
        function setup() {}
      `,
    }]);

    expect(nodeNames(result)).toEqual(['init', 'setup']);
    expect(edgePairs(result)).toEqual(['init→setup']);
    expect(fanIn(result, 'setup')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

describe('CallGraphBuilder — Python', () => {
  it('extracts module-level functions and resolves direct calls', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'app.py',
      language: 'Python',
      content: `
def main():
    process()
    validate()

def process():
    validate()

def validate():
    pass
      `,
    }]);

    expect(nodeNames(result)).toEqual(['main', 'process', 'validate']);
    expect(fanIn(result, 'validate')).toBe(2);
    expect(fanOut(result, 'main')).toBe(2);
  });

  it('extracts class methods and resolves self.method() calls', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'service.py',
      language: 'Python',
      content: `
class DataService:
    def run(self):
        self.fetch()
        self.process()

    def fetch(self):
        pass

    def process(self):
        self.fetch()
      `,
    }]);

    expect(nodeNames(result)).toEqual(['fetch', 'process', 'run']);
    expect(fanIn(result, 'fetch')).toBe(2); // run + process
    expect(fanOut(result, 'run')).toBe(2);
  });

  it('does NOT create edges for external method calls like redis.get()', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'cache.py',
      language: 'Python',
      content: `
def get_value(redis_client, key):
    return redis_client.get(key)

def get():
    pass
      `,
    }]);

    // redis_client.get() should not resolve to the local get() function
    expect(fanIn(result, 'get')).toBe(0);
    expect(result.stats.totalEdges).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

describe('CallGraphBuilder — Go', () => {
  it('extracts top-level functions and resolves calls', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'main.go',
      language: 'Go',
      content: `
package main

func main() {
  greet()
  logMessage()
}

func greet() {
  logMessage()
}

func logMessage() {}
      `,
    }]);

    expect(nodeNames(result)).toEqual(['greet', 'logMessage', 'main']);
    expect(fanIn(result, 'logMessage')).toBe(2);
    expect(fanOut(result, 'main')).toBe(2);
  });

  it('extracts receiver methods', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'server.go',
      language: 'Go',
      content: `
package main

type Server struct{}

func (s *Server) Start() { s.listen() }
func (s *Server) listen() {}
      `,
    }]);

    expect(nodeNames(result)).toEqual(['Start', 'listen']);
    const startNode = Array.from(result.nodes.values()).find(n => n.name === 'Start');
    expect(startNode?.className).toBe('Server');
  });

  it('ignores Go builtins like make, append, close', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'util.go',
      language: 'Go',
      content: `
package main

func build() []int {
  s := make([]int, 0)
  s = append(s, 1)
  return s
}
      `,
    }]);

    expect(result.stats.totalEdges).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Rust
// ---------------------------------------------------------------------------

describe('CallGraphBuilder — Rust', () => {
  it('extracts free functions and resolves calls', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'lib.rs',
      language: 'Rust',
      content: `
fn process() {
    validate();
    format_output();
}

fn validate() {}

fn format_output() {
    validate();
}
      `,
    }]);

    expect(nodeNames(result)).toEqual(['format_output', 'process', 'validate']);
    expect(fanIn(result, 'validate')).toBe(2);
    expect(fanOut(result, 'process')).toBe(2);
  });

  it('extracts impl methods and assigns className from impl block', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'engine.rs',
      language: 'Rust',
      content: `
struct Engine {}

impl Engine {
    async fn start(&self) { self.run(); }
    fn run(&self) {}
}
      `,
    }]);

    expect(nodeNames(result)).toEqual(['run', 'start']);
    const startNode = Array.from(result.nodes.values()).find(n => n.name === 'start');
    expect(startNode?.className).toBe('Engine');
    expect(startNode?.isAsync).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Ruby
// ---------------------------------------------------------------------------

describe('CallGraphBuilder — Ruby', () => {
  it('extracts methods and resolves direct calls', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'app.rb',
      language: 'Ruby',
      content: `
def run
  fetch
  process
end

def fetch; end

def process
  fetch
end
      `,
    }]);

    expect(nodeNames(result)).toEqual(['fetch', 'process', 'run']);
    expect(fanIn(result, 'fetch')).toBe(2);
    expect(fanOut(result, 'run')).toBe(2);
  });

  it('extracts class methods and assigns className', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'service.rb',
      language: 'Ruby',
      content: `
class UserService
  def create(params)
    validate(params)
    persist(params)
  end

  def validate(params); end
  def persist(params); end
end
      `,
    }]);

    expect(nodeNames(result)).toEqual(['create', 'persist', 'validate']);
    const createNode = Array.from(result.nodes.values()).find(n => n.name === 'create');
    expect(createNode?.className).toBe('UserService');
    expect(fanIn(result, 'validate')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Java
// ---------------------------------------------------------------------------

describe('CallGraphBuilder — Java', () => {
  it('extracts methods and resolves calls', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'Main.java',
      language: 'Java',
      content: `
public class Main {
    public void run() {
        fetch();
        process();
    }

    private void fetch() {}

    private void process() {
        fetch();
    }
}
      `,
    }]);

    expect(nodeNames(result)).toEqual(['fetch', 'process', 'run']);
    expect(fanIn(result, 'fetch')).toBe(2);
    expect(fanOut(result, 'run')).toBe(2);
  });

  it('assigns className from enclosing class declaration', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'Service.java',
      language: 'Java',
      content: `
public class OrderService {
    public void createOrder() { validate(); }
    private void validate() {}
}
      `,
    }]);

    const createNode = Array.from(result.nodes.values()).find(n => n.name === 'createOrder');
    expect(createNode?.className).toBe('OrderService');
  });

  it('extracts constructors as nodes', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'Repo.java',
      language: 'Java',
      content: `
public class UserRepository {
    public UserRepository() { init(); }
    private void init() {}
}
      `,
    }]);

    expect(nodeNames(result)).toContain('UserRepository');
    expect(nodeNames(result)).toContain('init');
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: stats, hub functions, entry points
// ---------------------------------------------------------------------------

describe('CallGraphBuilder — stats and derived metrics', () => {
  it('computes hub functions (fanIn >= 5)', async () => {
    const builder = new CallGraphBuilder();
    // Create a shared utility called from 5 different functions
    const callers = Array.from({ length: 5 }, (_, i) => `function f${i}() { shared(); }`).join('\n');
    const result = await builder.build([{
      path: 'hub.ts',
      language: 'TypeScript',
      content: `${callers}\nfunction shared() {}`,
    }]);

    expect(result.hubFunctions.map(n => n.name)).toContain('shared');
    expect(fanIn(result, 'shared')).toBe(5);
  });

  it('computes entry points (fanIn === 0)', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'entry.ts',
      language: 'TypeScript',
      content: `
        function main() { helper(); }
        function helper() {}
      `,
    }]);

    const entryNames = result.entryPoints.map(n => n.name);
    expect(entryNames).toContain('main');
    expect(entryNames).not.toContain('helper');
  });

  it('handles mixed-language project', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([
      { path: 'server.ts', language: 'TypeScript', content: `function serve() { handle(); } function handle() {}` },
      { path: 'worker.py', language: 'Python', content: `def run():\n    process()\ndef process():\n    pass` },
      { path: 'main.go', language: 'Go', content: `package main\nfunc main() { start() }\nfunc start() {}` },
    ]);

    expect(result.stats.totalNodes).toBe(6);
    expect(result.stats.totalEdges).toBe(3);
  });

  it('returns zero stats for empty input', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([]);

    expect(result.stats.totalNodes).toBe(0);
    expect(result.stats.totalEdges).toBe(0);
    expect(result.hubFunctions).toHaveLength(0);
    expect(result.entryPoints).toHaveLength(0);
  });

  it('skips unsupported languages silently', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([
      { path: 'script.sh', language: 'Shell', content: `echo hello` },
      { path: 'query.sql', language: 'SQL', content: `SELECT 1` },
      { path: 'known.ts', language: 'TypeScript', content: `function ok() {}` },
    ]);

    expect(result.stats.totalNodes).toBe(1);
    expect(nodeNames(result)).toEqual(['ok']);
  });
});
