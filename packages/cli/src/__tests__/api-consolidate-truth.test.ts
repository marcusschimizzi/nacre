import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStore, appendCapture } from '@nacre/core';
import { createApp } from '../api/server.js';

describe('POST /consolidate runs the truth layer', () => {
  let root: string;
  let store: SqliteStore;
  let graphPath: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'nacre-api-consolidate-'));
    mkdirSync(join(root, 'notes'), { recursive: true });
    mkdirSync(join(root, 'memory'), { recursive: true });
    writeFileSync(join(root, 'notes/2026-07-18.md'), 'Worked on [[nacre]] today.\n');
    appendCapture(join(root, 'memory'), {
      id: 'mem_ab1122334455',
      ts: '2026-07-18T09:00:00Z',
      origin: 'mcp',
      payload: { content: 'An API-era captured memory.', type: 'decision' },
    });
    graphPath = join(root, 'graph.db');
    store = SqliteStore.open(graphPath);
  });

  after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('promotes spooled captures to canonical files, not just parser ingestion', async () => {
    process.env.NACRE_MEMORY_DIR = join(root, 'memory');
    try {
      const app = createApp({ store, graphPath, consolidateRoot: root });
      const res = await app.request('/api/v1/consolidate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputs: [join(root, 'notes')], outDir: graphPath }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        data: {
          truthLayer: {
            promoted: string[];
            compiledMemories: number;
            errors: string[];
          } | null;
        };
      };

      assert.ok(body.data.truthLayer, 'truth layer ran');
      assert.equal(body.data.truthLayer.promoted.length, 1);
      assert.deepEqual(body.data.truthLayer.errors, []);
      const relPath = body.data.truthLayer.promoted[0];
      assert.ok(existsSync(join(root, 'memory', relPath)), 'canonical file materialized');

      const node = store.getNode('mem_ab1122334455');
      assert.equal(node?.status, 'promoted');
      assert.equal(node?.canonicalPath, relPath);
    } finally {
      delete process.env.NACRE_MEMORY_DIR;
    }
  });
});
