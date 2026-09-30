import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  SqliteStore,
  type EntityHistory,
  type MemoryEdge,
  type MemoryNode,
  type Snapshot,
} from '@nacre/core';
import { temporalRoutes } from '../api/routes/temporal.js';

const timestamp = '2026-01-01T00:00:00.000Z';

function makeNode(id: string, scope?: string, shared = false): MemoryNode {
  return {
    id,
    label: `${id} before`,
    type: 'concept',
    aliases: [],
    firstSeen: timestamp,
    lastReinforced: timestamp,
    mentionCount: 1,
    reinforcementCount: 0,
    sourceFiles: [],
    excerpts: [],
    scope,
    ...(shared ? {} : { status: 'candidate' as const }),
  };
}

function makeEdge(source: string, target: string, weight = 0.5): MemoryEdge {
  return {
    id: `${source}-${target}`,
    source,
    target,
    type: 'explicit',
    directed: false,
    weight,
    baseWeight: weight,
    stability: 1,
    firstFormed: timestamp,
    lastReinforced: timestamp,
    reinforcementCount: 0,
    evidence: [],
  };
}

describe('Historical API scope isolation', () => {
  let store: SqliteStore;
  let app: ReturnType<typeof temporalRoutes>;
  let before: Snapshot;
  let after: Snapshot;

  beforeEach(() => {
    store = SqliteStore.open(':memory:');
    for (const [id, scope] of [
      ['a', 'project/a'],
      ['b', 'project/b'],
      ['user', 'user'],
      ['agent', 'agent'],
      ['legacy', undefined],
      ['moving-in', 'project/b'],
      ['moving-out', 'project/a'],
    ] as const) {
      store.putNode(makeNode(id, scope));
      store.putEdge(makeEdge(id, 'shared'));
    }
    store.putNode(makeNode('shared', undefined, true));
    store.putEdge(makeEdge('a', 'b'));
    store.putEpisode({
      id: 'hidden-episode',
      title: 'hidden episode',
      content: 'session-only content',
      timestamp,
      type: 'observation',
      sequence: 0,
      participants: [],
      topics: [],
      importance: 0.5,
      accessCount: 0,
      lastAccessed: timestamp,
      source: 'test',
      sourceType: 'api',
      scope: 'session',
    });
    before = store.createSnapshot('manual', { note: 'private project/b metadata' }, timestamp);
    for (const [id, scope] of [
      ['a', 'project/a'],
      ['b', 'project/b'],
      ['moving-in', 'project/a'],
      ['moving-out', 'project/b'],
    ]) {
      store.putNode({ ...makeNode(id, scope), label: `${id} after` });
    }
    store.putEdge(makeEdge('a', 'shared', 0.8));
    store.putEdge(makeEdge('b', 'shared', 0.8));
    after = store.createSnapshot('manual', undefined, '2026-01-02T00:00:00.000Z');
    app = temporalRoutes(store);
  });

  afterEach(() => store.close());

  async function get(path: string) {
    const response = await app.request(path);
    assert.equal(response.status, 200, path);
    return (await response.json()).data;
  }

  const cases: Array<[string, string[]]> = [
    ['', ['a', 'agent', 'b', 'legacy', 'moving-in', 'moving-out', 'shared', 'user']],
    ['?scopes=%20,%20', ['a', 'agent', 'b', 'legacy', 'moving-in', 'moving-out', 'shared', 'user']],
    ['?scopes=project/a', ['a', 'moving-out', 'shared']],
    ['?scopes=agent', ['agent', 'legacy', 'shared']],
    ['?scopes=user,%20project/b', ['b', 'moving-in', 'shared', 'user']],
    ['?scopes=session', ['shared']],
    ['?scopes=unknown-scratch', ['shared']],
  ];

  for (const [query, ids] of cases) {
    it(`filters snapshot graphs and summaries with ${query || 'default scopes'}`, async () => {
      const result = await get(`/snapshots/${before.id}/graph${query}`);
      assert.deepEqual(Object.keys(result.graph.nodes).sort(), ids);
      for (const edge of Object.values(result.graph.edges) as MemoryEdge[]) {
        assert.ok(ids.includes(edge.source));
        assert.ok(ids.includes(edge.target));
      }
      const detail = await get(`/snapshots/${before.id}${query}`);
      const listed = (await get(`/snapshots${query}`)).find(
        (snapshot: Snapshot) => snapshot.id === before.id,
      );
      for (const summary of [result.snapshot, detail, listed]) {
        assert.equal(summary.nodeCount, ids.length);
        assert.equal(summary.edgeCount, Object.keys(result.graph.edges).length);
        assert.ok(!('episodeCount' in summary));
        assert.ok(!('metadata' in summary));
      }
      assert.equal(store.getSnapshot(before.id)?.episodeCount, 1);
      assert.deepEqual(store.getSnapshot(before.id)?.metadata, {
        note: 'private project/b metadata',
      });
    });
  }

  it('keeps snapshot list time and limit filters', async () => {
    const recent = await get('/snapshots?scopes=project/a&since=2026-01-02&limit=1');
    assert.deepEqual(
      recent.map((snapshot: Snapshot) => snapshot.id),
      [after.id],
    );
    const older = await get('/snapshots?scopes=project/a&until=2026-01-01T23:59:59Z');
    assert.deepEqual(
      older.map((snapshot: Snapshot) => snapshot.id),
      [before.id],
    );
  });

  it('filters a newly created snapshot response without changing the stored snapshot', async () => {
    const response = await app.request('/snapshots?scopes=project/a', { method: 'POST' });
    assert.equal(response.status, 201);
    const { data } = await response.json();
    assert.equal(data.nodeCount, 3);
    assert.equal(data.edgeCount, 2);
    assert.ok(!('episodeCount' in data));
    assert.equal(store.getSnapshot(data.id)?.nodeCount, 8);
    assert.equal(store.getSnapshot(data.id)?.episodeCount, 1);
  });

  it('uses each historical node scope despite later scope moves or live deletion', async () => {
    store.deleteNode('moving-in');
    store.deleteNode('moving-out');
    const incoming = await get('/history/node/moving-in?scopes=project/a');
    assert.deepEqual(
      incoming.snapshots.map((entry: { snapshotId: string }) => entry.snapshotId),
      [after.id],
    );
    assert.equal(incoming.snapshots[0].state.label, 'moving-in after');
    const outgoing = await get('/history/node/moving-out?scopes=project/a');
    assert.deepEqual(
      outgoing.snapshots.map((entry: { snapshotId: string }) => entry.snapshotId),
      [before.id],
    );
    assert.equal(outgoing.snapshots[0].state.label, 'moving-out before');
    for (const id of ['b', 'missing']) {
      assert.deepEqual((await get(`/history/node/${id}?scopes=project/a`)).snapshots, []);
    }
  });

  it('uses same-snapshot endpoint scopes for edge history, never live endpoints', async () => {
    store.deleteNode('moving-in');
    store.deleteNode('moving-out');
    for (const [id, snapshot] of [
      ['moving-in-shared', after],
      ['moving-out-shared', before],
    ] as const) {
      const history = await get(`/history/edge/${id}?scopes=project/a`);
      assert.deepEqual(
        history.snapshots.map((entry: { snapshotId: string }) => entry.snapshotId),
        [snapshot.id],
      );
    }
    for (const id of ['a-b', 'b-shared', 'missing']) {
      assert.deepEqual((await get(`/history/edge/${id}?scopes=project/a`)).snapshots, []);
    }
  });

  it('diffs filtered historical states, treating scope moves as additions and removals', async () => {
    const diff = await get(`/diff/${before.id}/${after.id}?scopes=project/a`);
    assert.deepEqual(
      diff.nodes.added.map((node: MemoryNode) => node.id),
      ['moving-in'],
    );
    assert.equal(diff.nodes.added[0].label, 'moving-in after');
    assert.deepEqual(
      diff.nodes.removed.map((node: MemoryNode) => node.id),
      ['moving-out'],
    );
    assert.equal(diff.nodes.removed[0].label, 'moving-out before');
    assert.deepEqual(
      diff.nodes.changed.map((pair: { after: MemoryNode }) => pair.after.id),
      ['a'],
    );
    assert.deepEqual(
      diff.edges.added.map((edge: MemoryEdge) => edge.id),
      ['moving-in-shared'],
    );
    assert.deepEqual(
      diff.edges.removed.map((edge: MemoryEdge) => edge.id),
      ['moving-out-shared'],
    );
    assert.deepEqual(
      diff.edges.strengthened.map((edge: MemoryEdge) => edge.id),
      ['a-shared'],
    );
    assert.deepEqual(diff.stats, {
      nodesAdded: 1,
      nodesRemoved: 1,
      nodesChanged: 1,
      edgesAdded: 1,
      edgesRemoved: 1,
      edgesStrengthened: 1,
      edgesWeakened: 0,
      netChange: 0,
    });
    assert.ok(!JSON.stringify(diff).includes('moving-in before'));
    assert.ok(!JSON.stringify(diff).includes('moving-out after'));
    assert.ok(!JSON.stringify(diff).includes('project/b'));
    const empty = await get(`/diff/${before.id}/${after.id}?scopes=project/missing`);
    assert.equal(empty.stats.nodesChanged, 0);
    assert.equal(empty.stats.netChange, 0);
  });

  it('hides scratch from legacy node history by default, but allows explicit scratch reads', async () => {
    // Historical stores can predate snapshot scratch exclusion. Model the
    // stored historical states directly so this also tests those old snapshots.
    const history: EntityHistory = {
      entityId: 'scratch',
      type: 'node',
      snapshots: [
        { snapshotId: before.id, timestamp, state: makeNode('scratch', 'session') },
        { snapshotId: after.id, timestamp, state: makeNode('scratch', 'unknown-scratch') },
      ],
    };
    store.getNodeHistory = () => history;
    for (const query of ['', '?scopes=%20,%20', '?scopes=agent']) {
      assert.deepEqual((await get(`/history/node/scratch${query}`)).snapshots, []);
    }
    assert.equal((await get('/history/node/scratch?scopes=session')).snapshots.length, 1);
    assert.equal((await get('/history/node/scratch?scopes=unknown-scratch')).snapshots.length, 1);
    assert.equal(history.snapshots.length, 2);
  });

  it('filters legacy scratch graphs, diffs, and edge history using historical ownership', async () => {
    const originalGraph = store.getSnapshotGraph.bind(store);
    store.getSnapshotGraph = (id) => {
      const graph = originalGraph(id);
      const scratch = makeNode('scratch', 'session');
      scratch.label = id === before.id ? 'scratch before' : 'scratch after';
      return {
        ...graph,
        nodes: {
          ...graph.nodes,
          scratch,
          unknown: makeNode('unknown', 'unknown-scratch'),
        },
        edges: {
          ...graph.edges,
          'scratch-shared': makeEdge('scratch', 'shared'),
          'unknown-shared': makeEdge('unknown', 'shared'),
          'scratch-missing': makeEdge('scratch', 'missing'),
        },
      };
    };
    store.getEdgeHistory = (id) => ({
      entityId: id,
      type: 'edge',
      snapshots: [before, after].map((snapshot) => ({
        snapshotId: snapshot.id,
        timestamp: snapshot.createdAt,
        state: makeEdge('scratch', id === 'scratch-missing' ? 'missing' : 'shared'),
      })),
    });
    const graph = (await get(`/snapshots/${before.id}/graph`)).graph;
    assert.ok(!graph.nodes.scratch);
    assert.ok(!graph.nodes.unknown);
    assert.ok(!graph.edges['scratch-shared']);
    const explicit = (await get(`/snapshots/${before.id}/graph?scopes=session`)).graph;
    assert.deepEqual(Object.keys(explicit.nodes).sort(), ['scratch', 'shared']);
    assert.deepEqual(Object.keys(explicit.edges), ['scratch-shared']);
    const unknown = (await get(`/snapshots/${before.id}/graph?scopes=unknown-scratch`)).graph;
    assert.deepEqual(Object.keys(unknown.nodes).sort(), ['shared', 'unknown']);
    assert.deepEqual(Object.keys(unknown.edges), ['unknown-shared']);
    const defaultDiff = await get(`/diff/${before.id}/${after.id}`);
    assert.ok(!JSON.stringify(defaultDiff).includes('scratch'));
    const scratchDiff = await get(`/diff/${before.id}/${after.id}?scopes=session`);
    assert.deepEqual(
      scratchDiff.nodes.changed.map((pair: { after: MemoryNode }) => pair.after.id),
      ['scratch'],
    );
    assert.deepEqual((await get('/history/edge/scratch-shared')).snapshots, []);
    assert.equal((await get('/history/edge/scratch-shared?scopes=session')).snapshots.length, 2);
    assert.deepEqual((await get('/history/edge/scratch-missing?scopes=session')).snapshots, []);
  });

  it('keeps missing snapshot errors', async () => {
    for (const path of [
      '/snapshots/missing',
      '/snapshots/missing/graph',
      `/diff/missing/${after.id}`,
      `/diff/${before.id}/missing`,
    ]) {
      assert.equal((await app.request(`${path}?scopes=project/a`)).status, 404);
    }
  });
});
