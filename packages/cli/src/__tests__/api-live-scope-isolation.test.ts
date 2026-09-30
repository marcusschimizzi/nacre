import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import {
  SqliteStore,
  type Episode,
  type MemoryEdge,
  type MemoryNode,
  type PendingEdge,
  type Procedure,
} from '@nacre/core';
import { episodeRoutes } from '../api/routes/episodes.js';
import { procedureRoutes } from '../api/routes/procedures.js';
import { intelligenceRoutes } from '../api/routes/intelligence.js';

const scopes = [
  ['a', 'project/a'],
  ['b', 'project/b'],
  ['user', 'user'],
  ['agent', 'agent'],
  ['legacy', undefined],
  ['session', 'session'],
  ['unknown', 'unknown-scratch'],
] as const;
const durable = ['a', 'b', 'user', 'agent', 'legacy'];

function makeNode(id: string, scope?: string, memory = true): MemoryNode {
  const now = new Date().toISOString();
  return {
    id,
    label: id,
    type: 'concept',
    aliases: [],
    firstSeen: now,
    lastReinforced: now,
    mentionCount: 3,
    reinforcementCount: 0,
    sourceFiles: [],
    excerpts: [],
    ...(memory ? { status: 'candidate' as const } : {}),
    scope,
  };
}

function makeEpisode(id: string, scope?: string): Episode {
  return {
    id,
    title: id,
    timestamp: '2026-01-01T00:00:00Z',
    type: 'observation',
    content: id,
    sequence: 0,
    participants: [],
    topics: [],
    importance: 0.5,
    accessCount: 0,
    lastAccessed: '2026-01-01T00:00:00Z',
    source: '/test.md',
    sourceType: 'api',
    scope,
  };
}

function makeProcedure(id: string, scope?: string): Procedure {
  return {
    id,
    statement: id,
    type: 'insight',
    triggerKeywords: [],
    triggerContexts: [],
    sourceEpisodes: [],
    sourceNodes: [],
    confidence: 0.5,
    applications: 0,
    contradictions: 0,
    stability: 1,
    lastApplied: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    flaggedForReview: false,
    scope,
  };
}

function makeEdge(source: string, target: string): MemoryEdge {
  const now = new Date().toISOString();
  return {
    id: `${source}-${target}`,
    source,
    target,
    type: 'explicit',
    directed: false,
    weight: 0.8,
    baseWeight: 0.8,
    stability: 1,
    firstFormed: now,
    lastReinforced: now,
    reinforcementCount: 0,
    evidence: [],
  };
}

const ids = (records: Array<{ id: string }>) => records.map((record) => record.id).sort();

describe('Live episode, procedure, and intelligence API scope isolation', () => {
  let store: SqliteStore;
  let app: Hono;

  beforeEach(() => {
    store = SqliteStore.open(':memory:');
    for (const [id, scope] of scopes) {
      store.putNode(makeNode(id, scope));
      store.putEpisode(makeEpisode(`ep-${id}`, scope));
      store.putProcedure(makeProcedure(`proc-${id}`, scope));
    }
    store.putNode(makeNode('shared', undefined, false));
    store.putNode(makeNode('shared-two', undefined, false));
    app = new Hono();
    app.route('/', episodeRoutes(store));
    app.route('/', procedureRoutes(store));
    app.route('/', intelligenceRoutes(store, '/tmp/scope-test.db', '/tmp'));
  });

  afterEach(() => store.close());

  const cases: Array<[string, string[]]> = [
    ['', durable],
    ['?scopes=%20,%20', durable],
    ['?scopes=project/a', ['a']],
    ['?scopes=agent', ['agent', 'legacy']],
    ['?scopes=session', ['session']],
    ['?scopes=unknown-scratch', ['unknown']],
    ['?scopes=project/a,%20session', ['a', 'session']],
    ['?scopes=project/missing', []],
  ];

  for (const [query, expected] of cases) {
    it(`filters episode/procedure lists and alerts with ${query || 'default scopes'}`, async () => {
      for (const [route, prefix] of [
        ['episodes', 'ep-'],
        ['procedures', 'proc-'],
      ]) {
        const response = await app.request(`/${route}${query}`);
        assert.equal(response.status, 200);
        assert.deepEqual(
          ids((await response.json()).data),
          expected.map((id) => prefix + id).sort(),
        );
      }
      const alerts = await (await app.request(`/alerts${query}`)).json();
      assert.deepEqual(ids(alerts.data.orphanNodes), [...expected, 'shared', 'shared-two'].sort());
    });
  }

  it('filters episodes before pagination and still honors existing filters', async () => {
    store.putEpisode({ ...makeEpisode('newest-hidden', 'session'), timestamp: '2026-03-01' });
    store.putEpisode({
      ...makeEpisode('a-newest', 'project/a'),
      timestamp: '2026-02-01',
      type: 'decision',
    });
    store.putEpisode({
      ...makeEpisode('a-next', 'project/a'),
      timestamp: '2026-01-15',
      type: 'decision',
    });
    const page = await (await app.request('/episodes?scopes=project/a&limit=1&offset=1')).json();
    assert.deepEqual(ids(page.data), ['a-next']);
    const filtered = await (
      await app.request('/episodes?scopes=project/a&type=decision&since=2026-01-20')
    ).json();
    assert.deepEqual(ids(filtered.data), ['a-newest']);
  });

  it('does not broaden missing/hidden entity filters or let hidden labels shadow visible ones', async () => {
    store.linkEpisodeEntity('ep-a', 'b', 'topic');
    for (const entity of ['b', 'does-not-exist']) {
      const body = await (await app.request(`/episodes?scopes=project/a&entity=${entity}`)).json();
      assert.deepEqual(body.data, []);
    }
    store.putNode({ ...makeNode('hidden-label', 'session'), label: 'Duplicate' });
    store.putNode({
      ...makeNode('visible-label', 'project/a'),
      label: 'Duplicate',
      aliases: ['Alias'],
    });
    store.linkEpisodeEntity('ep-a', 'visible-label', 'topic');
    for (const entity of ['Duplicate', 'Alias', 'visible-label']) {
      const body = await (await app.request(`/episodes?scopes=project/a&entity=${entity}`)).json();
      assert.deepEqual(ids(body.data), ['ep-a']);
    }
  });

  it('hides out-of-scope detail and touch targets without mutating them', async () => {
    for (const [id, query] of [
      ['session', ''],
      ['unknown', ''],
      ['b', '?scopes=project/a'],
      ['legacy', '?scopes=project/a'],
    ]) {
      assert.equal((await app.request(`/episodes/ep-${id}${query}`)).status, 404);
      assert.equal(
        (await app.request(`/episodes/ep-${id}/touch${query}`, { method: 'POST' })).status,
        404,
      );
      assert.equal(store.getEpisode(`ep-${id}`)?.accessCount, 0);
    }
    for (const [id, query] of [
      ['session', '?scopes=session'],
      ['unknown', '?scopes=unknown-scratch'],
      ['legacy', '?scopes=agent'],
    ]) {
      assert.equal((await app.request(`/episodes/ep-${id}${query}`)).status, 200);
      assert.equal(
        (await app.request(`/episodes/ep-${id}/touch${query}`, { method: 'POST' })).status,
        200,
      );
      assert.equal(store.getEpisode(`ep-${id}`)?.accessCount, 1);
    }
  });

  it('filters episode association arrays, entity links, and parent IDs in list and detail responses', async () => {
    store.putEpisode({ ...makeEpisode('ep-a', 'project/a'), parentId: 'ep-b' });
    for (const id of [...scopes.map(([id]) => id), 'shared']) {
      for (const role of ['participant', 'topic', 'outcome', 'mentioned'] as const) {
        store.linkEpisodeEntity('ep-a', id, role);
      }
    }
    for (const [query, expected] of [
      ['?scopes=project/a', ['a', 'shared']],
      ['', [...durable, 'shared']],
    ] as const) {
      const detail = await (await app.request(`/episodes/ep-a${query}`)).json();
      const list = await (await app.request(`/episodes${query}`)).json();
      const listed = list.data.find((episode: Episode) => episode.id === 'ep-a');
      for (const episode of [detail.data.episode, listed]) {
        for (const field of ['participants', 'topics', 'outcomes']) {
          assert.deepEqual([...episode[field]].sort(), [...expected].sort());
        }
        assert.equal(episode.parentId, query ? undefined : 'ep-b');
      }
      assert.deepEqual(
        [...new Set(detail.data.entities.map((link: { nodeId: string }) => link.nodeId))].sort(),
        [...expected].sort(),
      );
    }
    assert.equal(store.getEpisode('ep-a')?.participants.length, scopes.length + 1);
    assert.equal(store.getEpisode('ep-a')?.parentId, 'ep-b');
  });

  it('filters procedure source IDs on lists and apply responses without erasing stored provenance', async () => {
    const proc = makeProcedure('proc-a', 'project/a');
    proc.sourceNodes = [...scopes.map(([id]) => id), 'shared', 'missing-node'];
    proc.sourceEpisodes = [...scopes.map(([id]) => `ep-${id}`), 'missing-episode'];
    store.putProcedure(proc);
    const list = await (await app.request('/procedures?scopes=project/a')).json();
    const applied = await (
      await app.request('/procedures/proc-a/apply?scopes=project/a', { method: 'POST' })
    ).json();
    for (const result of [list.data[0], applied.data]) {
      assert.deepEqual(result.sourceNodes, ['a', 'shared']);
      assert.deepEqual(result.sourceEpisodes, ['ep-a']);
    }
    assert.deepEqual(store.getProcedure('proc-a')?.sourceNodes, proc.sourceNodes);
    assert.deepEqual(store.getProcedure('proc-a')?.sourceEpisodes, proc.sourceEpisodes);
  });

  it('does not reveal or apply hidden procedures but allows explicitly requested scratch and legacy', async () => {
    const apply = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feedback: 'positive' }),
    };
    for (const [id, query] of [
      ['session', ''],
      ['unknown', ''],
      ['b', '?scopes=project/a'],
      ['legacy', '?scopes=user'],
    ]) {
      assert.equal((await app.request(`/procedures/proc-${id}/apply${query}`, apply)).status, 404);
      assert.equal(store.getProcedure(`proc-${id}`)?.applications, 0);
    }
    for (const [id, query] of [
      ['session', '?scopes=session'],
      ['unknown', '?scopes=unknown-scratch'],
      ['legacy', '?scopes=agent'],
    ]) {
      assert.equal((await app.request(`/procedures/proc-${id}/apply${query}`, apply)).status, 200);
      assert.equal(store.getProcedure(`proc-${id}`)?.applications, 1);
    }
  });

  it('filters intelligence graph topology before analysis and summaries', async () => {
    for (const [id] of scopes) {
      store.putEdge(makeEdge(id, 'shared'));
      store.putEdge(makeEdge(id, 'shared-two'));
    }
    for (const [query, expected] of cases) {
      const insights = await (await app.request(`/insights${query}`)).json();
      const emergingIds = ids(
        insights.data.emerging.map((item: { node: MemoryNode }) => item.node),
      );
      assert.deepEqual(
        emergingIds.filter((id) => !id.startsWith('shared')),
        [...expected].sort(),
      );
      for (const [hidden] of scopes.filter(([id]) => !expected.includes(id))) {
        assert.ok(
          !insights.data.emerging.some((item: { node: MemoryNode }) => item.node.id === hidden),
        );
        assert.ok(
          !insights.data.clusters.some((cluster: { members: Array<{ id: string }> }) =>
            cluster.members.some((member) => member.id === hidden),
          ),
        );
      }
    }
  });

  it('filters pending suggestions before limits, including explicit scratch reads', async () => {
    const pending: PendingEdge[] = [...scopes].reverse().map(([id]) => ({
      source: id,
      target: 'shared',
      type: 'co-occurrence',
      count: 2,
      firstSeen: '2026-01-01',
      evidence: [],
    }));
    store.setMeta('pending_edges', JSON.stringify(pending));
    const first = await (await app.request('/suggest?scopes=project/a&max=1')).json();
    assert.deepEqual(
      first.data.suggestions.map((item: { sourceId: string }) => item.sourceId),
      ['a'],
    );
    for (const [query, expected] of cases) {
      const join = query ? '&' : '?';
      const body = await (await app.request(`/suggest${query}${join}max=100`)).json();
      assert.deepEqual(
        body.data.suggestions.map((item: { sourceId: string }) => item.sourceId).sort(),
        [...expected].sort(),
      );
      assert.ok(
        body.data.suggestions.every((item: { targetId: string }) => item.targetId === 'shared'),
      );
    }
  });
});
