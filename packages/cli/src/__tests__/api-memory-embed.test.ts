import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStore } from '@nacre/core';
import { createApp } from '../api/server.js';

describe('POST /memories auto-embed', () => {
  let prevEnv: string | undefined;

  before(() => {
    prevEnv = process.env.NACRE_EMBEDDING_PROVIDER;
  });
  after(() => {
    if (prevEnv === undefined) delete process.env.NACRE_EMBEDDING_PROVIDER;
    else process.env.NACRE_EMBEDDING_PROVIDER = prevEnv;
  });

  it('embeds a created memory when a provider is configured', async () => {
    process.env.NACRE_EMBEDDING_PROVIDER = 'mock';
    const store = SqliteStore.open(':memory:');
    try {
      const app = createApp({ store, graphPath: ':memory:' });
      const res = await app.request('/api/v1/memories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Vite is the chosen bundler', type: 'tool' }),
      });
      assert.equal(res.status, 201);
      const body = (await res.json()) as { data: { id: string; embedded: boolean } };
      assert.equal(body.data.embedded, true);
      assert.equal(store.embeddingCount(), 1);
      assert.ok(store.getEmbedding(body.data.id), 'embedding stored for the new memory');
    } finally {
      store.close();
    }
  });

  it('still creates the memory (graph-only) without a provider', async () => {
    delete process.env.NACRE_EMBEDDING_PROVIDER;
    const store = SqliteStore.open(':memory:');
    try {
      const app = createApp({ store, graphPath: ':memory:' });
      const res = await app.request('/api/v1/memories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'no provider here' }),
      });
      assert.equal(res.status, 201);
      const body = (await res.json()) as { data: { embedded: boolean } };
      assert.equal(body.data.embedded, false);
      assert.equal(store.embeddingCount(), 0);
    } finally {
      store.close();
    }
  });
});
