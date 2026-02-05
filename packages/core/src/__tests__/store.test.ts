import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStore } from '../store.js';
import type { MemoryNode, MemoryEdge, NacreGraph } from '../types.js';
import { DEFAULT_CONFIG } from '../types.js';

function makeNode(overrides: Partial<MemoryNode> & { id: string; label: string }): MemoryNode {
  return {
    type: 'concept',
    aliases: [],
    firstSeen: '2026-01-01',
    lastReinforced: '2026-01-15',
    mentionCount: 1,
    reinforcementCount: 0,
    sourceFiles: [],
    excerpts: [],
    ...overrides,
  };
}

function makeEdge(overrides: Partial<MemoryEdge> & { id: string; source: string; target: string }): MemoryEdge {
  return {
    type: 'co-occurrence',
    directed: false,
    weight: 0.5,
    baseWeight: 0.5,
    reinforcementCount: 0,
    firstFormed: '2026-01-01',
    lastReinforced: '2026-01-15',
    stability: 1.0,
    evidence: [],
    ...overrides,
  };
}

describe('SqliteStore', () => {
  let store: SqliteStore;

  before(async () => {
    store = await SqliteStore.open(null); // in-memory
  });

  after(() => {
    store.close();
  });

  describe('node operations', () => {
    it('puts and gets a node', () => {
      const node = makeNode({ id: 'n1', label: 'TypeScript', type: 'tool' });
      store.putNode(node);
      const result = store.getNode('n1');
      assert.ok(result);
      assert.equal(result.label, 'TypeScript');
      assert.equal(result.type, 'tool');
    });

    it('returns undefined for missing node', () => {
      const result = store.getNode('nonexistent');
      assert.equal(result, undefined);
    });

    it('finds node by label', () => {
      const node = makeNode({ id: 'n2', label: 'Marcus', type: 'person' });
      store.putNode(node);
      const result = store.findNode('marcus'); // case-insensitive
      assert.ok(result);
      assert.equal(result.id, 'n2');
    });

    it('finds node by alias', () => {
      const node = makeNode({ id: 'n3', label: 'Node.js', type: 'tool', aliases: ['node', 'nodejs'] });
      store.putNode(node);
      const result = store.findNode('node');
      assert.ok(result);
      assert.equal(result.id, 'n3');
    });

    it('lists nodes with type filter', () => {
      store.putNode(makeNode({ id: 'n4', label: 'Vite', type: 'tool' }));
      store.putNode(makeNode({ id: 'n5', label: 'nacre', type: 'project' }));

      const tools = store.listNodes({ type: 'tool' });
      assert.ok(tools.length >= 2); // n1 + n4 at minimum
      assert.ok(tools.every(n => n.type === 'tool'));
    });

    it('lists nodes with label filter', () => {
      const results = store.listNodes({ label: 'type' });
      assert.ok(results.some(n => n.label === 'TypeScript'));
    });

    it('updates node via put (upsert)', () => {
      store.putNode(makeNode({ id: 'n1', label: 'TypeScript', type: 'tool', mentionCount: 5 }));
      const result = store.getNode('n1');
      assert.equal(result?.mentionCount, 5);
    });

    it('deletes a node and its edges', () => {
      store.putNode(makeNode({ id: 'del1', label: 'DeleteMe', type: 'concept' }));
      store.putNode(makeNode({ id: 'del2', label: 'Other', type: 'concept' }));
      store.putEdge(makeEdge({ id: 'del1--del2--co-occurrence', source: 'del1', target: 'del2' }));

      store.deleteNode('del1');
      assert.equal(store.getNode('del1'), undefined);
      assert.equal(store.getEdge('del1--del2--co-occurrence'), undefined);
    });

    it('counts nodes', () => {
      const count = store.nodeCount();
      assert.ok(count > 0);
    });
  });

  describe('edge operations', () => {
    it('puts and gets an edge', () => {
      const edge = makeEdge({
        id: 'n1--n2--co-occurrence',
        source: 'n1',
        target: 'n2',
        weight: 0.8,
      });
      store.putEdge(edge);
      const result = store.getEdge('n1--n2--co-occurrence');
      assert.ok(result);
      assert.equal(result.weight, 0.8);
      assert.equal(result.source, 'n1');
    });

    it('returns undefined for missing edge', () => {
      assert.equal(store.getEdge('nope'), undefined);
    });

    it('lists edges with source filter', () => {
      store.putEdge(makeEdge({ id: 'n1--n5--explicit', source: 'n1', target: 'n5', type: 'explicit' }));
      const edges = store.listEdges({ source: 'n1' });
      assert.ok(edges.length >= 1);
      assert.ok(edges.every(e => e.source === 'n1'));
    });

    it('lists edges with type filter', () => {
      const explicit = store.listEdges({ type: 'explicit' });
      assert.ok(explicit.every(e => e.type === 'explicit'));
    });

    it('lists edges with minWeight filter', () => {
      store.putEdge(makeEdge({ id: 'n2--n4--co-occurrence', source: 'n2', target: 'n4', weight: 0.1 }));
      const heavy = store.listEdges({ minWeight: 0.5 });
      assert.ok(heavy.every(e => e.weight >= 0.5));
    });

    it('deletes an edge', () => {
      store.putEdge(makeEdge({ id: 'e-del', source: 'n1', target: 'n2', type: 'temporal' }));
      store.deleteEdge('e-del');
      assert.equal(store.getEdge('e-del'), undefined);
    });

    it('counts edges', () => {
      const count = store.edgeCount();
      assert.ok(count > 0);
    });
  });

  describe('file tracking', () => {
    it('puts and gets file hash', () => {
      store.putFileHash({ path: '/notes/2026-01-15.md', hash: 'abc123', lastProcessed: '2026-01-15' });
      const result = store.getFileHash('/notes/2026-01-15.md');
      assert.ok(result);
      assert.equal(result.hash, 'abc123');
    });

    it('returns undefined for untracked file', () => {
      assert.equal(store.getFileHash('/nope.md'), undefined);
    });

    it('lists all file hashes', () => {
      store.putFileHash({ path: '/notes/2026-01-16.md', hash: 'def456', lastProcessed: '2026-01-16' });
      const all = store.listFileHashes();
      assert.ok(all.length >= 2);
    });
  });

  describe('metadata', () => {
    it('sets and gets metadata', () => {
      store.setMeta('test_key', 'test_value');
      assert.equal(store.getMeta('test_key'), 'test_value');
    });

    it('returns undefined for missing key', () => {
      assert.equal(store.getMeta('nope'), undefined);
    });

    it('overwrites existing metadata', () => {
      store.setMeta('test_key', 'new_value');
      assert.equal(store.getMeta('test_key'), 'new_value');
    });
  });

  describe('bulk operations', () => {
    it('exports full graph', () => {
      const graph = store.getFullGraph();
      assert.ok(graph.nodes);
      assert.ok(graph.edges);
      assert.equal(graph.version, 2);
      assert.ok(Object.keys(graph.nodes).length > 0);
    });

    it('imports a graph', async () => {
      const fresh = await SqliteStore.open(null);
      
      const graph: NacreGraph = {
        version: 2,
        lastConsolidated: '2026-01-20',
        processedFiles: [{ path: '/test.md', hash: 'xyz', lastProcessed: '2026-01-20' }],
        nodes: {
          'imp1': makeNode({ id: 'imp1', label: 'Imported', type: 'concept' }),
          'imp2': makeNode({ id: 'imp2', label: 'Also Imported', type: 'tool' }),
        },
        edges: {
          'imp1--imp2--co-occurrence': makeEdge({ id: 'imp1--imp2--co-occurrence', source: 'imp1', target: 'imp2' }),
        },
        config: DEFAULT_CONFIG,
      };

      fresh.importGraph(graph);

      assert.equal(fresh.nodeCount(), 2);
      assert.equal(fresh.edgeCount(), 1);
      assert.ok(fresh.getNode('imp1'));
      assert.ok(fresh.getEdge('imp1--imp2--co-occurrence'));
      assert.equal(fresh.getMeta('last_consolidated'), '2026-01-20');
      assert.ok(fresh.getFileHash('/test.md'));

      fresh.close();
    });
  });

  describe('serialization roundtrip', () => {
    it('preserves node data through put/get cycle', () => {
      const node = makeNode({
        id: 'rt1',
        label: 'Roundtrip Test',
        type: 'decision',
        aliases: ['rt', 'roundtrip'],
        firstSeen: '2026-01-01T00:00:00Z',
        lastReinforced: '2026-02-01T12:00:00Z',
        mentionCount: 42,
        reinforcementCount: 7,
        sourceFiles: ['/a.md', '/b.md'],
        excerpts: [{ file: '/a.md', text: 'test excerpt', date: '2026-01-01' }],
      });

      store.putNode(node);
      const result = store.getNode('rt1')!;

      assert.deepEqual(result.aliases, ['rt', 'roundtrip']);
      assert.equal(result.mentionCount, 42);
      assert.equal(result.reinforcementCount, 7);
      assert.deepEqual(result.sourceFiles, ['/a.md', '/b.md']);
      assert.equal(result.excerpts[0].text, 'test excerpt');
    });

    it('preserves edge data through put/get cycle', () => {
      const edge = makeEdge({
        id: 'rt1--rt2--causal',
        source: 'rt1',
        target: 'rt2',
        type: 'causal',
        directed: true,
        weight: 0.95,
        baseWeight: 0.8,
        reinforcementCount: 3,
        stability: 2.5,
        evidence: [{ file: '/a.md', date: '2026-01-01', context: 'caused by' }],
      });

      store.putEdge(edge);
      const result = store.getEdge('rt1--rt2--causal')!;

      assert.equal(result.type, 'causal');
      assert.equal(result.directed, true);
      assert.equal(result.weight, 0.95);
      assert.equal(result.baseWeight, 0.8);
      assert.equal(result.stability, 2.5);
      assert.equal(result.evidence[0].context, 'caused by');
    });
  });
});
