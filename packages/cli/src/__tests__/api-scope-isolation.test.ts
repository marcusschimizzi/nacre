import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { SqliteStore, type Episode, type MemoryEdge, type MemoryNode } from '@nacre/core';
import { createApp } from '../api/server.js';

const timestamp = '2026-07-20T12:00:00.000Z';

function makeNode(id: string, scope?: string, status?: MemoryNode['status']): MemoryNode {
  return {
    id,
    label: `scope ${id}`,
    type: id === 'entity' ? 'concept' : 'decision',
    aliases: [],
    firstSeen: timestamp,
    lastReinforced: timestamp,
    mentionCount: id === 'session' || id === 'unknown' ? 100 : 1,
    reinforcementCount: 0,
    sourceFiles: [],
    excerpts: [],
    scope,
    status,
  };
}

function makeEdge(source: string, target: string, weight = 0.5): MemoryEdge {
  return {
    id: `${source}-${target}`,
    source,
    target,
    type: 'explicit',
    directed: true,
    weight,
    baseWeight: weight,
    stability: 1,
    firstFormed: timestamp,
    lastReinforced: timestamp,
    reinforcementCount: 0,
    evidence: [{ file: 'test.md', date: timestamp, context: `${source} to ${target}` }],
  };
}

function makeEpisode(id: string, scope?: string): Episode {
  return {
    id,
    title: id,
    timestamp,
    type: 'observation',
    content: id,
    sequence: 0,
    participants: [],
    topics: [],
    importance: 0.5,
    accessCount: 0,
    lastAccessed: timestamp,
    source: 'test.md',
    sourceType: 'markdown',
    scope,
  };
}

describe('API graph and keyword scope isolation', () => {
  let store: SqliteStore;
  let app: ReturnType<typeof createApp>;

  before(() => {
    store = SqliteStore.open(':memory:');
    for (const node of [
      makeNode('session', 'session'),
      makeNode('unknown', 'unrecognized'),
      makeNode('entity'),
      makeNode('user', 'user'),
      makeNode('project-a', 'project/a'),
      makeNode('project-b', 'project/b'),
      makeNode('agent', 'agent'),
      makeNode('legacy', undefined, 'candidate'),
    ]) {
      store.putNode(node);
      store.putEmbedding(node.id, 'node', node.label, new Float32Array([1, 0]), 'mock');
    }
    for (const edge of [
      makeEdge('entity', 'session', 0.9),
      makeEdge('unknown', 'entity', 0.8),
      makeEdge('entity', 'user', 0.7),
      makeEdge('project-a', 'entity', 0.6),
      makeEdge('entity', 'project-b', 0.5),
      makeEdge('agent', 'entity', 0.4),
      makeEdge('entity', 'legacy', 0.3),
      makeEdge('entity', 'missing', 1),
    ]) {
      store.putEdge(edge);
    }
    for (const episode of [
      makeEpisode('ep-user', 'user'),
      makeEpisode('ep-session', 'session'),
      makeEpisode('ep-legacy'),
      // A node and episode with the same ID must follow node visibility,
      // matching the ownership resolution used by /similar.
      makeEpisode('session', 'user'),
    ]) {
      store.putEpisode(episode);
      if (!store.getEmbedding(episode.id)) {
        store.putEmbedding(
          episode.id,
          'episode',
          episode.content,
          new Float32Array([1, 0]),
          'mock',
        );
      }
    }
    store.putEmbedding('orphan', 'node', 'unresolved', new Float32Array([1, 0]), 'mock');
    app = createApp({ store, graphPath: ':memory:', rateLimit: false });
  });

  after(() => store.close());

  async function get(path: string) {
    const response = await app.request(`/api/v1${path}`);
    assert.equal(response.status, 200, path);
    return (await response.json()).data;
  }

  const defaultIds = ['agent', 'entity', 'legacy', 'project-a', 'project-b', 'user'];
  const cases = [
    { query: '', ids: defaultIds },
    { query: '&scopes=', ids: defaultIds },
    { query: '&scopes=%20,%20', ids: defaultIds },
    { query: '&scopes=user', ids: ['entity', 'user'] },
    { query: '&scopes=project/a', ids: ['entity', 'project-a'] },
    { query: '&scopes=%20agent,%20project/b%20', ids: ['agent', 'entity', 'legacy', 'project-b'] },
    { query: '&scopes=session', ids: ['entity', 'session'] },
    { query: '&scopes=unrecognized', ids: ['entity', 'unknown'] },
    { query: '&scopes=project/missing', ids: ['entity'] },
  ];

  for (const { query, ids } of cases) {
    it(`filters node lists for ${query || 'default scopes'}`, async () => {
      const nodes: MemoryNode[] = await get(`/nodes?limit=100${query}`);
      assert.deepEqual(nodes.map((node) => node.id).sort(), ids);
    });

    it(`filters keyword JSON/text results for ${query || 'default scopes'}`, async () => {
      const results: { node: MemoryNode }[] = await get(`/query?q=scope${query}`);
      assert.deepEqual(results.map(({ node }) => node.id).sort(), ids);
      const response = await app.request(`/api/v1/query?q=scope&format=text${query}`);
      assert.equal(response.status, 200);
      assert.deepEqual(
        (await response.text())
          .split('\n')
          .map((line) => line.split(' (')[0])
          .sort(),
        ids.map((id) => `scope ${id}`).sort(),
      );
    });
  }

  it('filters before list/query pagination and retains type/label constraints', async () => {
    const nodes: MemoryNode[] = await get('/nodes?scopes=user&type=decision&label=scope&limit=1');
    assert.deepEqual(
      nodes.map((node) => node.id),
      ['user'],
    );
    assert.deepEqual(await get('/nodes?scopes=user&type=decision&limit=1&offset=1'), []);
    const results: { node: MemoryNode }[] = await get(
      '/query?q=scope&scopes=user&type=decision&limit=1',
    );
    assert.deepEqual(
      results.map(({ node }) => node.id),
      ['user'],
    );
  });

  it('returns the same 404 for hidden and nonexistent nodes', async () => {
    for (const path of [
      '/nodes/session',
      '/nodes/unknown',
      '/nodes/agent?scopes=user',
      '/nodes/legacy?scopes=user',
      '/nodes/project-b?scopes=project/a',
      '/nodes/missing',
    ]) {
      const response = await app.request(`/api/v1${path}`);
      assert.equal(response.status, 404, path);
      assert.deepEqual(await response.json(), {
        error: { message: 'Node not found', code: 'NOT_FOUND' },
      });
    }
  });

  it('only returns detail edges with two visible, existing endpoints', async () => {
    const entity = await get('/nodes/entity?scopes=user');
    assert.equal(entity.node.id, 'entity');
    assert.deepEqual(
      entity.edges.map((edge: MemoryEdge) => edge.id),
      ['entity-user'],
    );
    const project = await get('/nodes/entity?scopes=project/a');
    assert.deepEqual(
      project.edges.map((edge: MemoryEdge) => edge.id),
      ['project-a-entity'],
    );
    const scratch = await get('/nodes/session?scopes=session');
    assert.equal(scratch.node.id, 'session');
    assert.deepEqual(
      scratch.edges.map((edge: MemoryEdge) => edge.id),
      ['entity-session'],
    );
  });

  it('filters edges before pagination and preserves endpoint/type/weight constraints', async () => {
    const edges: MemoryEdge[] = await get('/edges?limit=1');
    assert.deepEqual(
      edges.map((edge) => edge.id),
      ['entity-user'],
    );
    const next: MemoryEdge[] = await get('/edges?limit=1&offset=1');
    assert.deepEqual(
      next.map((edge) => edge.id),
      ['project-a-entity'],
    );
    const scoped: MemoryEdge[] = await get(
      '/edges?scopes=user&source=entity&type=explicit&minWeight=0.6',
    );
    assert.deepEqual(
      scoped.map((edge) => edge.id),
      ['entity-user'],
    );
    assert.deepEqual(await get('/edges?scopes=user&target=session'), []);
    assert.deepEqual(await get('/edges?scopes=user&minWeight=0.8'), []);
    const session: MemoryEdge[] = await get('/edges?scopes=session&target=session');
    assert.deepEqual(
      session.map((edge) => edge.id),
      ['entity-session'],
    );
  });

  it('makes graph totals match the same scope-visible graph and embeddings', async () => {
    for (const { query, embeddingCount } of [
      { query: '', embeddingCount: 8 },
      { query: '?scopes=user', embeddingCount: 3 },
      { query: '?scopes=agent', embeddingCount: 4 },
      { query: '?scopes=session', embeddingCount: 3 },
      { query: '?scopes=project/missing', embeddingCount: 1 },
    ]) {
      const graph = await get(`/graph${query}`);
      const stats = await get(`/graph/stats${query}`);
      const health = await get(`/health${query}`);
      assert.equal(stats.nodeCount, Object.keys(graph.nodes).length, query);
      assert.equal(stats.edgeCount, Object.keys(graph.edges).length, query);
      assert.equal(health.nodeCount, stats.nodeCount, query);
      assert.equal(health.edgeCount, stats.edgeCount, query);
      assert.equal(stats.embeddingCount, embeddingCount, query);
      assert.equal(
        Object.values(stats.nodesByType).reduce((sum: number, count) => sum + Number(count), 0),
        stats.nodeCount,
      );
    }
  });

  it('filters linked episode IDs in recall results as well as direct episode reads', async () => {
    const recallStore = SqliteStore.open(':memory:');
    try {
      recallStore.putNode(makeNode('user', 'user'));
      recallStore.putNode(makeNode('session', 'session'));
      recallStore.putNode(makeNode('entity'));
      recallStore.putEpisode({ ...makeEpisode('ep-user', 'user'), parentId: 'ep-session' });
      recallStore.putEpisode(makeEpisode('ep-session', 'session'));
      recallStore.linkEpisodeEntity('ep-user', 'user', 'topic');
      recallStore.linkEpisodeEntity('ep-user', 'entity', 'participant');
      recallStore.linkEpisodeEntity('ep-user', 'session', 'participant');
      const recallApp = createApp({ store: recallStore, graphPath: ':memory:', rateLimit: false });
      const response = await recallApp.request(
        '/api/v1/recall?q=scope%20user&scopes=user&provider=mock',
      );
      assert.equal(response.status, 200);
      const results: Array<{ id: string; episodes?: Episode[] }> = (await response.json()).data;
      const episode = results.find((result) => result.id === 'user')?.episodes?.[0];
      assert.ok(episode, 'recall includes the visible linked episode');
      assert.deepEqual(episode.participants, ['entity']);
      assert.deepEqual(episode.topics, ['user']);
      assert.equal(episode.parentId, undefined);
      assert.equal(recallStore.getEpisode('ep-user')?.participants.length, 2);
    } finally {
      recallStore.close();
    }
  });
});
