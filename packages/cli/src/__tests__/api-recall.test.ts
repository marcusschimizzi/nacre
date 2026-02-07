import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStore, MockEmbedder } from '@nacre/core';
import type { MemoryNode, MemoryEdge } from '@nacre/core';
import { createApp } from '../api/server.js';

function makeNode(overrides: Partial<MemoryNode> & { id: string; label: string }): MemoryNode {
  return {
    type: 'concept',
    aliases: [],
    firstSeen: '2026-01-01',
    lastReinforced: '2026-01-15',
    mentionCount: 3,
    reinforcementCount: 1,
    sourceFiles: ['test.md'],
    excerpts: [{ file: 'test.md', text: `About ${overrides.label}`, date: '2026-01-15' }],
    ...overrides,
  };
}

function makeEdge(overrides: Partial<MemoryEdge> & { id: string; source: string; target: string }): MemoryEdge {
  return {
    type: 'co-occurrence',
    directed: false,
    weight: 0.5,
    baseWeight: 0.5,
    reinforcementCount: 1,
    firstFormed: '2026-01-01',
    lastReinforced: '2026-01-15',
    stability: 1.0,
    evidence: [],
    ...overrides,
  };
}

describe('Recall API', () => {
  let store: SqliteStore;
  let app: ReturnType<typeof createApp>;

  before(async () => {
    store = SqliteStore.open(':memory:');

    store.putNode(makeNode({ id: 'n-ts', label: 'TypeScript', type: 'tool', mentionCount: 10 }));
    store.putNode(makeNode({ id: 'n-nacre', label: 'Nacre', type: 'project', mentionCount: 8 }));
    store.putNode(makeNode({ id: 'n-marcus', label: 'Marcus', type: 'person', mentionCount: 5 }));

    store.putEdge(makeEdge({ id: 'n-ts--n-nacre--explicit', source: 'n-ts', target: 'n-nacre', type: 'explicit', weight: 1.0, baseWeight: 1.0 }));
    store.putEdge(makeEdge({ id: 'n-marcus--n-nacre--explicit', source: 'n-marcus', target: 'n-nacre', type: 'explicit', weight: 0.9, baseWeight: 0.9 }));

    const embedder = new MockEmbedder();
    for (const id of ['n-ts', 'n-nacre', 'n-marcus']) {
      const node = store.getNode(id)!;
      const text = node.label + ' ' + node.excerpts.map((e) => e.text).join(' ');
      const vec = await embedder.embed(text);
      store.putEmbedding(id, 'node', text, vec, embedder.name);
    }

    app = createApp({ store, graphPath: '/tmp/test-graph' });
  });

  after(() => {
    store.close();
  });

  it('GET /recall?q=Nacre returns results', async () => {
    const res = await app.request('/api/v1/recall?q=Nacre&provider=mock');
    assert.strictEqual(res.status, 200);
    const body = await res.json() as { data: unknown[] };
    assert.ok(Array.isArray(body.data));
    assert.ok(body.data.length > 0);
  });

  it('GET /recall without q returns 400', async () => {
    const res = await app.request('/api/v1/recall');
    assert.strictEqual(res.status, 400);
    const body = await res.json() as { error: { code: string } };
    assert.strictEqual(body.error.code, 'BAD_REQUEST');
  });

  it('respects limit parameter', async () => {
    const res = await app.request('/api/v1/recall?q=Nacre&provider=mock&limit=1');
    assert.strictEqual(res.status, 200);
    const body = await res.json() as { data: unknown[] };
    assert.ok(body.data.length <= 1);
  });

  it('respects types filter', async () => {
    const res = await app.request('/api/v1/recall?q=Nacre&provider=mock&types=person');
    assert.strictEqual(res.status, 200);
    const body = await res.json() as { data: Array<{ type: string }> };
    for (const r of body.data) {
      assert.strictEqual(r.type, 'person');
    }
  });

  it('returns score breakdown in results', async () => {
    const res = await app.request('/api/v1/recall?q=TypeScript&provider=mock');
    assert.strictEqual(res.status, 200);
    const body = await res.json() as { data: Array<{ score: number; scores: Record<string, number> }> };
    if (body.data.length > 0) {
      const first = body.data[0];
      assert.ok(typeof first.score === 'number');
      assert.ok('semantic' in first.scores);
      assert.ok('graph' in first.scores);
      assert.ok('recency' in first.scores);
      assert.ok('importance' in first.scores);
    }
  });
});
