import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStore } from '../store.js';
import { diffSnapshots } from '../temporal.js';
import type { MemoryNode, MemoryEdge } from '../types.js';

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

describe('Temporal: diffSnapshots', () => {
  let store: SqliteStore;

  before(() => {
    store = SqliteStore.open();
  });

  after(() => {
    store.close();
  });

  it('detects added nodes', () => {
    store.putNode(makeNode({ id: 'n1', label: 'Alpha' }));
    const snap1 = store.createSnapshot('manual');

    store.putNode(makeNode({ id: 'n2', label: 'Beta' }));
    const snap2 = store.createSnapshot('manual');

    const diff = diffSnapshots(store, snap1.id, snap2.id);

    assert.equal(diff.stats.nodesAdded, 1);
    assert.equal(diff.nodes.added[0].label, 'Beta');
    assert.equal(diff.stats.nodesRemoved, 0);
  });

  it('detects removed nodes', () => {
    const snap1 = store.createSnapshot('manual');

    store.deleteNode('n2');
    const snap2 = store.createSnapshot('manual');

    const diff = diffSnapshots(store, snap1.id, snap2.id);

    assert.equal(diff.stats.nodesRemoved, 1);
    assert.equal(diff.nodes.removed[0].label, 'Beta');
  });

  it('detects changed nodes', () => {
    store.putNode(makeNode({ id: 'n1', label: 'Alpha', mentionCount: 1 }));
    const snap1 = store.createSnapshot('manual');

    store.putNode(makeNode({ id: 'n1', label: 'Alpha', mentionCount: 5 }));
    const snap2 = store.createSnapshot('manual');

    const diff = diffSnapshots(store, snap1.id, snap2.id);

    assert.equal(diff.stats.nodesChanged, 1);
    assert.ok(diff.nodes.changed[0].changes.includes('mentionCount'));
    assert.equal((diff.nodes.changed[0].before as MemoryNode).mentionCount, 1);
    assert.equal((diff.nodes.changed[0].after as MemoryNode).mentionCount, 5);
  });

  it('detects added and removed edges', () => {
    store.putNode(makeNode({ id: 'n1', label: 'Alpha' }));
    store.putNode(makeNode({ id: 'n3', label: 'Gamma' }));
    store.putEdge(makeEdge({ id: 'e1', source: 'n1', target: 'n3', weight: 0.6 }));
    const snap1 = store.createSnapshot('manual');

    store.deleteEdge('e1');
    store.putEdge(makeEdge({ id: 'e2', source: 'n1', target: 'n3', weight: 0.9 }));
    const snap2 = store.createSnapshot('manual');

    const diff = diffSnapshots(store, snap1.id, snap2.id);

    assert.equal(diff.stats.edgesRemoved, 1);
    assert.equal(diff.stats.edgesAdded, 1);
  });

  it('detects strengthened and weakened edges', () => {
    store.putEdge(makeEdge({ id: 'e-str', source: 'n1', target: 'n3', weight: 0.3 }));
    store.putEdge(makeEdge({ id: 'e-wk', source: 'n3', target: 'n1', weight: 0.8 }));
    const snap1 = store.createSnapshot('manual');

    store.putEdge(makeEdge({ id: 'e-str', source: 'n1', target: 'n3', weight: 0.7 }));
    store.putEdge(makeEdge({ id: 'e-wk', source: 'n3', target: 'n1', weight: 0.4 }));
    const snap2 = store.createSnapshot('manual');

    const diff = diffSnapshots(store, snap1.id, snap2.id);

    assert.equal(diff.stats.edgesStrengthened, 1);
    assert.equal(diff.stats.edgesWeakened, 1);
    assert.equal(diff.edges.strengthened[0].id, 'e-str');
    assert.equal(diff.edges.weakened[0].id, 'e-wk');
  });

  it('computes net change correctly', () => {
    store.putNode(makeNode({ id: 'n1', label: 'Alpha' }));
    store.putNode(makeNode({ id: 'n3', label: 'Gamma' }));
    store.putEdge(makeEdge({ id: 'e-str', source: 'n1', target: 'n3' }));
    store.putEdge(makeEdge({ id: 'e-wk', source: 'n3', target: 'n1' }));
    const snap1 = store.createSnapshot('manual');

    store.putNode(makeNode({ id: 'n4', label: 'Delta' }));
    const snap2 = store.createSnapshot('manual');

    const diff = diffSnapshots(store, snap1.id, snap2.id);

    assert.equal(diff.stats.netChange, 1);
    store.deleteNode('n4');
  });
});

describe('Temporal: Entity History', () => {
  let store: SqliteStore;

  before(() => {
    store = SqliteStore.open();
  });

  after(() => {
    store.close();
  });

  it('tracks node evolution across snapshots', () => {
    store.putNode(makeNode({ id: 'h1', label: 'History', mentionCount: 1 }));
    store.createSnapshot('manual');

    store.putNode(makeNode({ id: 'h1', label: 'History', mentionCount: 3 }));
    store.createSnapshot('manual');

    store.putNode(makeNode({ id: 'h1', label: 'History', mentionCount: 7 }));
    store.createSnapshot('manual');

    const history = store.getNodeHistory('h1');

    assert.equal(history.entityId, 'h1');
    assert.equal(history.type, 'node');
    assert.equal(history.snapshots.length, 3);

    const mentions = history.snapshots.map(s => (s.state as MemoryNode).mentionCount);
    assert.deepEqual(mentions, [1, 3, 7]);
  });

  it('tracks edge weight evolution across snapshots', () => {
    store.putNode(makeNode({ id: 'ha', label: 'A' }));
    store.putNode(makeNode({ id: 'hb', label: 'B' }));

    store.putEdge(makeEdge({ id: 'he1', source: 'ha', target: 'hb', weight: 0.2 }));
    store.createSnapshot('manual');

    store.putEdge(makeEdge({ id: 'he1', source: 'ha', target: 'hb', weight: 0.5 }));
    store.createSnapshot('manual');

    store.putEdge(makeEdge({ id: 'he1', source: 'ha', target: 'hb', weight: 0.9 }));
    store.createSnapshot('manual');

    const history = store.getEdgeHistory('he1');

    assert.equal(history.entityId, 'he1');
    assert.equal(history.type, 'edge');
    assert.equal(history.snapshots.length, 3);

    const weights = history.snapshots.map(s => (s.state as MemoryEdge).weight);
    assert.deepEqual(weights, [0.2, 0.5, 0.9]);
  });

  it('returns empty history for unknown entity', () => {
    const history = store.getNodeHistory('nonexistent');
    assert.equal(history.snapshots.length, 0);
    assert.equal(history.entityId, 'nonexistent');
  });

  it('snapshots ordered by timestamp ascending', () => {
    const history = store.getNodeHistory('h1');
    for (let i = 1; i < history.snapshots.length; i++) {
      assert.ok(history.snapshots[i].timestamp >= history.snapshots[i - 1].timestamp);
    }
  });
});
