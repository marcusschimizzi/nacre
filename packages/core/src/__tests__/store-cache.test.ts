import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../store.js';
import type { MemoryNode, MemoryEdge } from '../types.js';

function node(id: string, label: string, aliases: string[] = []): MemoryNode {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    id,
    label,
    type: 'concept',
    aliases,
    firstSeen: now,
    lastReinforced: now,
    mentionCount: 1,
    reinforcementCount: 0,
    sourceFiles: ['t.md'],
    excerpts: [{ file: 't.md', text: label, date: '2026-01-01' }],
  };
}

function edge(source: string, target: string): MemoryEdge {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    id: `${source}--${target}`,
    source,
    target,
    type: 'co-occurrence',
    directed: false,
    weight: 0.5,
    baseWeight: 0.5,
    reinforcementCount: 0,
    firstFormed: now,
    lastReinforced: now,
    stability: 1,
    evidence: [],
  };
}

describe('store read-cache invalidation (same instance)', () => {
  let store: SqliteStore;

  before(() => {
    store = SqliteStore.open(':memory:');
  });
  after(() => {
    store.close();
  });

  it('getFullGraph reflects a putNode made after a prior read', () => {
    store.getFullGraph(); // prime the cache
    store.putNode(node('a', 'Alpha'));
    assert.ok(store.getFullGraph().nodes.a, 'new node must be visible');
  });

  it('getAdjacencyMap reflects a putEdge made after a prior read', () => {
    store.putNode(node('b', 'Beta'));
    store.getAdjacencyMap(); // prime
    store.putEdge(edge('a', 'b'));
    const adj = store.getAdjacencyMap();
    assert.ok(
      adj.a?.some((e) => e.neighborId === 'b'),
      'new edge must be in adjacency',
    );
  });

  it('deleteNode is visible in getFullGraph and clears the alias index', () => {
    store.putNode(node('c', 'Gamma', ['γ-alias']));
    assert.ok(store.findNode('γ-alias'), 'alias resolves before delete');
    store.deleteNode('c');
    assert.equal(store.getFullGraph().nodes.c, undefined);
    assert.equal(store.findNode('γ-alias'), undefined, 'alias index must be invalidated');
  });

  it('importGraph replaces the cached graph', () => {
    store.getFullGraph(); // prime
    store.importGraph({
      version: 2,
      lastConsolidated: '',
      processedFiles: [],
      nodes: { z: node('z', 'Zeta') },
      edges: {},
      config: store.getFullGraph().config,
    });
    const g = store.getFullGraph();
    assert.ok(g.nodes.z);
    assert.equal(g.nodes.a, undefined, 'old nodes gone after import');
  });
});

describe('store read-cache cross-connection coherency', () => {
  const dbPath = join(tmpdir(), `nacre-cache-${process.pid}-${Date.now()}.db`);

  after(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      const p = dbPath + suffix;
      if (existsSync(p)) unlinkSync(p);
    }
  });

  it('sees a write committed by another connection (PRAGMA data_version)', () => {
    const a = SqliteStore.open(dbPath);
    const b = SqliteStore.open(dbPath);
    try {
      a.getFullGraph(); // build A's cache (empty)
      b.putNode(node('x', 'Xray')); // committed by a DIFFERENT connection
      assert.ok(a.getFullGraph().nodes.x, 'A must not serve a stale cache after B writes');
    } finally {
      a.close();
      b.close();
    }
  });
});
