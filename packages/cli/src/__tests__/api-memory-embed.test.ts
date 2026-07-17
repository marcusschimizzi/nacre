import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore, readCaptureEntries } from '@nacre/core';
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

  it('reports captured: false with a warning when no memory dir is configured', async () => {
    delete process.env.NACRE_EMBEDDING_PROVIDER;
    const store = SqliteStore.open(':memory:');
    try {
      const app = createApp({ store, graphPath: ':memory:' });
      const res = await app.request('/api/v1/memories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Database-only memory', type: 'concept' }),
      });
      assert.equal(res.status, 201);
      const body = (await res.json()) as { data: { captured: boolean }; warning?: string };
      assert.equal(body.data.captured, false);
      assert.match(body.warning ?? '', /database-only|No memory directory/);
    } finally {
      store.close();
    }
  });

  it('two-phase write: spools to the capture dir and marks the node candidate', async () => {
    delete process.env.NACRE_EMBEDDING_PROVIDER;
    const memoryDir = mkdtempSync(join(tmpdir(), 'nacre-api-capture-'));
    process.env.NACRE_MEMORY_DIR = memoryDir;
    const store = SqliteStore.open(':memory:');
    try {
      const app = createApp({ store, graphPath: ':memory:' });
      const res = await app.request('/api/v1/memories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Durable API memory', type: 'decision' }),
      });
      assert.equal(res.status, 201);
      const body = (await res.json()) as {
        data: { id: string; captured: boolean; status?: string };
        warning?: string;
      };
      assert.equal(body.data.captured, true);
      assert.equal(body.warning, undefined);
      assert.equal(body.data.status, 'candidate');

      const { entries, errors } = readCaptureEntries(memoryDir);
      assert.deepEqual(errors, []);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].id, body.data.id);
      assert.equal(entries[0].origin, 'api');
      assert.equal(entries[0].payload.type, 'decision');
    } finally {
      delete process.env.NACRE_MEMORY_DIR;
      rmSync(memoryDir, { recursive: true, force: true });
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
