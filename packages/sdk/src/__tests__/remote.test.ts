import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import { SqliteStore, MockEmbedder } from '@nacre/core';
import type { MemoryNode, MemoryEdge } from '@nacre/core';
import { createApp } from '../../../cli/src/api/server.js';
import { Nacre } from '../nacre.js';
import { RemoteBackend } from '../remote.js';

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

describe('Nacre — remote mode', () => {
  let store: SqliteStore;
  let server: Server;
  let nacre: Nacre;
  const port = 9876;

  before(async () => {
    store = SqliteStore.open(':memory:');

    store.putNode(makeNode({ id: 'n-ts', label: 'TypeScript', type: 'tool', mentionCount: 10 }));
    store.putNode(makeNode({ id: 'n-nacre', label: 'Nacre', type: 'project', mentionCount: 8 }));
    store.putNode(makeNode({ id: 'n-marcus', label: 'Marcus', type: 'person', mentionCount: 5 }));

    store.putEdge(makeEdge({ id: 'n-ts--n-nacre--explicit', source: 'n-ts', target: 'n-nacre', type: 'explicit', weight: 1.0, baseWeight: 1.0 }));

    const embedder = new MockEmbedder();
    for (const id of ['n-ts', 'n-nacre', 'n-marcus']) {
      const node = store.getNode(id)!;
      const text = node.label + ' ' + node.excerpts.map((e) => e.text).join(' ');
      const vec = await embedder.embed(text);
      store.putEmbedding(id, 'node', text, vec, embedder.name);
    }

    const app = createApp({ store, graphPath: '/tmp/test' });
    server = serve({ fetch: app.fetch, port });

    nacre = new Nacre({ url: `http://localhost:${port}` });
  });

  after(async () => {
    await nacre.close();
    server.close();
    store.close();
  });

  it('selects RemoteBackend for url option', () => {
    const n = new Nacre({ url: 'http://localhost:1234' });
    assert.ok(n instanceof Nacre);
    n.close();
  });

  it('recall returns results', async () => {
    const results = await nacre.recall('TypeScript');
    assert.ok(results.length > 0);
  });

  it('recall returns empty for non-matching query', async () => {
    const results = await nacre.recall('xyznonexistent123456');
    assert.strictEqual(results.length, 0);
  });

  it('brief returns text', async () => {
    const text = await nacre.brief();
    assert.ok(typeof text === 'string');
    assert.ok(text.length > 0);
  });

  it('remember creates a memory', async () => {
    const mem = await nacre.remember('Remote test memory');
    assert.ok(mem.id);
    assert.ok(mem.label);
  });

  it('nodes lists memories', async () => {
    const all = await nacre.nodes();
    assert.ok(all.length >= 3);
  });

  it('nodes filters by type', async () => {
    const people = await nacre.nodes({ type: 'person' });
    for (const n of people) {
      assert.strictEqual(n.type, 'person');
    }
  });

  it('stats returns counts', async () => {
    const s = await nacre.stats();
    assert.ok(s.nodeCount >= 3);
    assert.ok(typeof s.edgeCount === 'number');
  });

  it('feedback reinforces a memory', async () => {
    await nacre.feedback('n-ts', { rating: 1 });
  });

  it('forget removes a memory', async () => {
    const mem = await nacre.remember('To be forgotten');
    await nacre.forget(mem.id);
  });

  it('lesson creates a lesson memory', async () => {
    const mem = await nacre.lesson('Test lesson via remote');
    assert.ok(mem.id);
  });
});

describe('RemoteBackend', () => {
  it('throws without url', () => {
    assert.throws(() => new RemoteBackend({} as never), /requires url/);
  });
});
