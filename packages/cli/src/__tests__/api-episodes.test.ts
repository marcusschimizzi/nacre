import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStore } from '@nacre/core';
import type { Episode, MemoryNode } from '@nacre/core';
import { createApp } from '../api/server.js';

function makeNode(id: string, label: string, type: MemoryNode['type'] = 'concept'): MemoryNode {
  const now = new Date().toISOString();
  return {
    id,
    label,
    type,
    aliases: [],
    firstSeen: now,
    lastReinforced: now,
    mentionCount: 1,
    reinforcementCount: 0,
    sourceFiles: ['test.md'],
    excerpts: [{ file: 'test.md', text: `About ${label}`, date: now.slice(0, 10) }],
  };
}

function makeEpisode(overrides: Partial<Episode> & { id: string; title: string }): Episode {
  return {
    timestamp: '2026-01-15',
    type: 'observation',
    content: 'Test content for ' + overrides.title,
    sequence: 0,
    participants: [],
    topics: [],
    importance: 0.5,
    accessCount: 0,
    lastAccessed: '2026-01-15',
    source: '/test.md',
    sourceType: 'markdown',
    ...overrides,
  };
}

describe('Episode API', () => {
  let store: SqliteStore;
  let app: ReturnType<typeof createApp>;

  before(() => {
    store = SqliteStore.open(':memory:');

    store.putNode(makeNode('n-marcus', 'Marcus', 'person'));
    store.putNode(makeNode('n-nacre', 'Nacre', 'project'));

    store.putEpisode(makeEpisode({ id: 'ep-1', title: 'First Episode', type: 'observation', timestamp: '2026-01-10' }));
    store.putEpisode(makeEpisode({ id: 'ep-2', title: 'A Decision', type: 'decision', timestamp: '2026-01-15' }));
    store.putEpisode(makeEpisode({ id: 'ep-3', title: 'An Event', type: 'event', timestamp: '2026-01-20' }));

    store.linkEpisodeEntity('ep-1', 'n-marcus', 'participant');
    store.linkEpisodeEntity('ep-2', 'n-nacre', 'topic');

    app = createApp({ store, graphPath: '/tmp/test-graph' });
  });

  after(() => {
    store.close();
  });

  it('GET /episodes returns all episodes', async () => {
    const res = await app.request('/api/v1/episodes');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.length, 3);
  });

  it('GET /episodes?type=decision filters by type', async () => {
    const res = await app.request('/api/v1/episodes?type=decision');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].type, 'decision');
  });

  it('GET /episodes?since=2026-01-15 filters by date', async () => {
    const res = await app.request('/api/v1/episodes?since=2026-01-15');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.data.length >= 2);
    assert.ok(body.data.every((e: Episode) => e.timestamp >= '2026-01-15'));
  });

  it('GET /episodes?entity=Marcus filters by entity', async () => {
    const res = await app.request('/api/v1/episodes?entity=Marcus');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.data.length >= 1);
    assert.ok(body.data.some((e: Episode) => e.id === 'ep-1'));
  });

  it('GET /episodes supports limit and offset', async () => {
    const res = await app.request('/api/v1/episodes?limit=1&offset=1');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.length, 1);
  });

  it('GET /episodes/:id returns episode with entities', async () => {
    const res = await app.request('/api/v1/episodes/ep-1');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.episode.id, 'ep-1');
    assert.equal(body.data.episode.title, 'First Episode');
    assert.ok(body.data.entities.length >= 1);
    assert.equal(body.data.entities[0].role, 'participant');
  });

  it('GET /episodes/:id returns 404 for missing', async () => {
    const res = await app.request('/api/v1/episodes/nonexistent');
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error.code, 'NOT_FOUND');
  });

  it('POST /episodes/:id/touch increments access count', async () => {
    const beforeRes = await app.request('/api/v1/episodes/ep-2');
    const beforeBody = await beforeRes.json();
    const beforeCount = beforeBody.data.episode.accessCount;

    const touchRes = await app.request('/api/v1/episodes/ep-2/touch', { method: 'POST' });
    assert.equal(touchRes.status, 200);
    const touchBody = await touchRes.json();
    assert.equal(touchBody.data.accessCount, beforeCount + 1);
    assert.ok(touchBody.data.lastAccessed);
  });

  it('POST /episodes/:id/touch returns 404 for missing', async () => {
    const res = await app.request('/api/v1/episodes/nonexistent/touch', { method: 'POST' });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error.code, 'NOT_FOUND');
  });
});
