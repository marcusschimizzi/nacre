import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStore } from '@nacre/core';
import { createApp } from '../api/server.js';

const TOKEN = 'test-secret-token';

describe('API security', () => {
  let store: SqliteStore;

  before(() => {
    store = SqliteStore.open(':memory:');
  });

  after(() => {
    store.close();
  });

  describe('bearer auth (token configured)', () => {
    const app = () => createApp({ store, graphPath: '/tmp/test', token: TOKEN });

    it('rejects a request with no Authorization header', async () => {
      const res = await app().request('/api/v1/health');
      assert.equal(res.status, 401);
      const body = (await res.json()) as { error: { code: string } };
      assert.equal(body.error.code, 'UNAUTHORIZED');
    });

    it('rejects a wrong token', async () => {
      const res = await app().request('/api/v1/health', {
        headers: { Authorization: 'Bearer wrong' },
      });
      assert.equal(res.status, 401);
    });

    it('accepts the correct token', async () => {
      const res = await app().request('/api/v1/health', {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      assert.equal(res.status, 200);
    });
  });

  it('is open on /api/v1 when no token is configured', async () => {
    const app = createApp({ store, graphPath: '/tmp/test' });
    const res = await app.request('/api/v1/health');
    assert.equal(res.status, 200);
  });

  describe('CORS allowlist', () => {
    const app = createApp({ store, graphPath: '/tmp/test' });

    it('reflects an allowed origin', async () => {
      const res = await app.request('/api/v1/health', {
        headers: { Origin: 'http://localhost:5174' },
      });
      assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:5174');
    });

    it('does not allow an unlisted origin', async () => {
      const res = await app.request('/api/v1/health', {
        headers: { Origin: 'http://evil.example' },
      });
      assert.notEqual(res.headers.get('access-control-allow-origin'), 'http://evil.example');
    });
  });

  describe('POST /consolidate path confinement', () => {
    // consolidateRoot defaults to process.cwd(); paths outside it are rejected
    // before consolidate() ever touches the filesystem.
    const app = createApp({ store, graphPath: '/tmp/test' });

    async function consolidate(body: unknown) {
      return app.request('/api/v1/consolidate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    }

    it('rejects an absolute path outside the root', async () => {
      const res = await consolidate({ inputs: ['/etc'] });
      assert.equal(res.status, 400);
      const body = (await res.json()) as { error: { code: string } };
      assert.equal(body.error.code, 'FORBIDDEN_PATH');
    });

    it('rejects a traversal path', async () => {
      const res = await consolidate({ inputs: ['../../../../etc/passwd'] });
      assert.equal(res.status, 400);
      const body = (await res.json()) as { error: { code: string } };
      assert.equal(body.error.code, 'FORBIDDEN_PATH');
    });

    it('rejects an outDir that escapes the root', async () => {
      const res = await consolidate({ inputs: ['notes'], outDir: '/tmp/evil' });
      assert.equal(res.status, 400);
      const body = (await res.json()) as { error: { code: string } };
      assert.equal(body.error.code, 'FORBIDDEN_PATH');
    });

    it('rejects an over-long inputs array (schema cap)', async () => {
      const res = await consolidate({ inputs: Array.from({ length: 101 }, () => 'x') });
      assert.equal(res.status, 400);
      const body = (await res.json()) as { error: { code: string } };
      assert.equal(body.error.code, 'VALIDATION_ERROR');
    });
  });
});
