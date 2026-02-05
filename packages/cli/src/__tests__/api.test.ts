import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStore } from '@nacre/core';
import type { MemoryNode, MemoryEdge } from '@nacre/core';
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

function makeEdge(source: string, target: string, type: MemoryEdge['type'] = 'co-occurrence'): MemoryEdge {
  const now = new Date().toISOString();
  return {
    id: `${source}-${target}`,
    source,
    target,
    type,
    directed: false,
    weight: 0.8,
    baseWeight: 0.8,
    stability: 1.0,
    firstFormed: now,
    lastReinforced: now,
    reinforcementCount: 0,
    evidence: [{ file: 'test.md', date: now.slice(0, 10), context: 'test' }],
  };
}

describe('API server', () => {
  let store: SqliteStore;
  let app: ReturnType<typeof createApp>;

  before(() => {
    store = SqliteStore.open(':memory:');
    store.putNode(makeNode('aaa11111aaaaaaaa', 'TypeScript', 'tool'));
    store.putNode(makeNode('bbb22222bbbbbbbb', 'Marcus', 'person'));
    store.putNode(makeNode('ccc33333cccccccc', 'Nacre Project', 'project'));
    store.putEdge(makeEdge('aaa11111aaaaaaaa', 'bbb22222bbbbbbbb', 'co-occurrence'));
    store.putEdge(makeEdge('bbb22222bbbbbbbb', 'ccc33333cccccccc', 'explicit'));
    app = createApp({ store, graphPath: '/tmp/test-graph' });
  });

  after(() => {
    store.close();
  });

  it('GET /health returns 200 with status ok', async () => {
    const res = await app.request('/api/v1/health');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.status, 'ok');
    assert.equal(body.data.version, '0.1.0');
    assert.equal(body.data.nodeCount, 3);
    assert.equal(body.data.edgeCount, 2);
    assert.equal(typeof body.data.uptime, 'number');
  });

  it('GET /nodes returns all nodes', async () => {
    const res = await app.request('/api/v1/nodes');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.length, 3);
  });

  it('GET /nodes?type=person filters by type', async () => {
    const res = await app.request('/api/v1/nodes?type=person');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].label, 'Marcus');
  });

  it('GET /nodes/:id returns node with edges', async () => {
    const res = await app.request('/api/v1/nodes/bbb22222bbbbbbbb');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.node.label, 'Marcus');
    assert.ok(body.data.edges.length >= 2, 'Marcus has 2 edges');
  });

  it('GET /nodes/:id returns 404 for missing node', async () => {
    const res = await app.request('/api/v1/nodes/nonexistent123456');
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error.code, 'NOT_FOUND');
  });

  it('GET /edges returns all edges', async () => {
    const res = await app.request('/api/v1/edges');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.length, 2);
  });

  it('GET /graph/stats returns correct counts', async () => {
    const res = await app.request('/api/v1/graph/stats');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.nodeCount, 3);
    assert.equal(body.data.edgeCount, 2);
    assert.equal(body.data.embeddingCount, 0);
    assert.equal(typeof body.data.avgWeight, 'number');
  });

  it('POST /memories creates a node', async () => {
    const res = await app.request('/api/v1/memories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Test memory about debugging', type: 'lesson' }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.data.type, 'lesson');
    assert.equal(body.data.id.length, 16);
    assert.ok(body.data.label.includes('debugging'));

    const fetched = store.getNode(body.data.id);
    assert.ok(fetched, 'node persisted to store');
  });

  it('POST /memories returns 400 for empty content', async () => {
    const res = await app.request('/api/v1/memories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '' }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, 'VALIDATION_ERROR');
  });

  it('POST /memories returns 400 for non-JSON', async () => {
    const res = await app.request('/api/v1/memories', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'not json',
    });
    assert.equal(res.status, 400);
  });

  it('DELETE /memories/:id removes a node', async () => {
    const createRes = await app.request('/api/v1/memories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Ephemeral memory' }),
    });
    const { data: created } = await createRes.json();

    const res = await app.request(`/api/v1/memories/${created.id}`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.deleted, created.id);
    assert.equal(store.getNode(created.id), undefined);
  });

  it('DELETE /memories/:id returns 404 for missing', async () => {
    const res = await app.request('/api/v1/memories/doesnotexist1234', { method: 'DELETE' });
    assert.equal(res.status, 404);
  });

  it('POST /feedback reinforces edges', async () => {
    const edgesBefore = store.listEdges({ source: 'bbb22222bbbbbbbb' });
    const stabilityBefore = edgesBefore[0].stability;

    const res = await app.request('/api/v1/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memoryId: 'bbb22222bbbbbbbb', rating: 0.5 }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.data.edgesUpdated >= 1);

    const edgesAfter = store.listEdges({ source: 'bbb22222bbbbbbbb' });
    assert.ok(edgesAfter[0].stability > stabilityBefore, 'stability increased');
  });

  it('POST /feedback returns 404 for missing memory', async () => {
    const res = await app.request('/api/v1/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memoryId: 'nonexistent123456', rating: 0.5 }),
    });
    assert.equal(res.status, 404);
  });

  it('GET /query?q=typescript returns results', async () => {
    const res = await app.request('/api/v1/query?q=typescript');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.data.length >= 1, 'at least one result');
    assert.equal(body.data[0].node.label, 'TypeScript');
  });

  it('GET /query without q returns 400', async () => {
    const res = await app.request('/api/v1/query');
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, 'BAD_REQUEST');
  });

  it('GET /similar without q returns 400', async () => {
    const res = await app.request('/api/v1/similar');
    assert.equal(res.status, 400);
  });

  it('GET /similar returns 400 when no embeddings exist', async () => {
    const res = await app.request('/api/v1/similar?q=test');
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, 'NO_EMBEDDINGS');
  });

  it('GET /brief returns briefing data', async () => {
    const res = await app.request('/api/v1/brief');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.data.summary, 'has summary');
  });

  it('GET /alerts returns alerts data', async () => {
    const res = await app.request('/api/v1/alerts');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok('data' in body);
  });

  it('GET /insights returns insights data', async () => {
    const res = await app.request('/api/v1/insights');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok('data' in body);
  });

  it('GET /suggest returns suggestions data', async () => {
    const res = await app.request('/api/v1/suggest');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok('data' in body);
  });

  it('unknown route returns 404', async () => {
    const res = await app.request('/api/v1/nonexistent');
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error.code, 'NOT_FOUND');
  });
});
