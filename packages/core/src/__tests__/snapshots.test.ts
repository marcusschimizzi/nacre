import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStore } from '../store.js';
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

describe('Snapshots', () => {
  let store: SqliteStore;

  before(() => {
    store = SqliteStore.open();
  });

  after(() => {
    store.close();
  });

  describe('createSnapshot', () => {
    it('captures current graph state', () => {
      store.putNode(makeNode({ id: 'n1', label: 'TypeScript', type: 'tool' }));
      store.putNode(makeNode({ id: 'n2', label: 'Nacre', type: 'project' }));
      store.putEdge(makeEdge({ id: 'e1', source: 'n1', target: 'n2', weight: 0.8 }));

      const snapshot = store.createSnapshot('consolidation');

      assert.ok(snapshot.id);
      assert.equal(snapshot.trigger, 'consolidation');
      assert.equal(snapshot.nodeCount, 2);
      assert.equal(snapshot.edgeCount, 1);
      assert.equal(snapshot.episodeCount, 0);
    });

    it('supports manual trigger with metadata', () => {
      const meta = { reason: 'pre-deploy checkpoint' };
      const snapshot = store.createSnapshot('manual', meta);

      assert.equal(snapshot.trigger, 'manual');
      assert.deepEqual(snapshot.metadata, meta);
    });
  });

  describe('getSnapshot', () => {
    it('retrieves a snapshot by id', () => {
      const created = store.createSnapshot('manual');
      const fetched = store.getSnapshot(created.id);

      assert.ok(fetched);
      assert.equal(fetched.id, created.id);
      assert.equal(fetched.trigger, 'manual');
      assert.equal(fetched.nodeCount, created.nodeCount);
    });

    it('returns undefined for nonexistent id', () => {
      const result = store.getSnapshot('nonexistent');
      assert.equal(result, undefined);
    });
  });

  describe('listSnapshots', () => {
    it('lists all snapshots ordered by date desc', () => {
      const list = store.listSnapshots();
      assert.ok(list.length >= 3);
      for (let i = 1; i < list.length; i++) {
        assert.ok(list[i - 1].createdAt >= list[i].createdAt);
      }
    });

    it('filters by limit', () => {
      const list = store.listSnapshots({ limit: 1 });
      assert.equal(list.length, 1);
    });
  });

  describe('getSnapshotGraph', () => {
    it('reconstructs the full graph from snapshot data', () => {
      const graph = store.getSnapshotGraph(store.listSnapshots({ limit: 1 })[0].id);

      assert.ok(graph.nodes['n1']);
      assert.equal(graph.nodes['n1'].label, 'TypeScript');
      assert.ok(graph.nodes['n2']);
      assert.equal(graph.nodes['n2'].label, 'Nacre');
      assert.ok(graph.edges['e1']);
      assert.equal(graph.edges['e1'].weight, 0.8);
    });

    it('throws for nonexistent snapshot', () => {
      assert.throws(() => {
        store.getSnapshotGraph('nonexistent');
      }, /Snapshot not found/);
    });
  });

  describe('deleteSnapshot', () => {
    it('removes a snapshot and its data', () => {
      const snap = store.createSnapshot('manual');
      assert.ok(store.getSnapshot(snap.id));

      store.deleteSnapshot(snap.id);

      assert.equal(store.getSnapshot(snap.id), undefined);
    });
  });

  describe('snapshot isolation', () => {
    it('captures graph state at creation time, not live state', () => {
      const snap1 = store.createSnapshot('manual');

      store.putNode(makeNode({ id: 'n3', label: 'NewNode', type: 'concept' }));

      const snap2 = store.createSnapshot('manual');

      const graph1 = store.getSnapshotGraph(snap1.id);
      const graph2 = store.getSnapshotGraph(snap2.id);

      assert.equal(graph1.nodes['n3'], undefined);
      assert.ok(graph2.nodes['n3']);
      assert.equal(graph2.nodes['n3'].label, 'NewNode');

      store.deleteNode('n3');
    });
  });
});
