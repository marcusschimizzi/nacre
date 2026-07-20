import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendCapture, readCaptureEntries } from '../capture.js';
import { compileMemoryDir, replayCaptureCandidates } from '../memory-compile.js';
import { recall } from '../recall.js';
import { SESSION_SCOPE } from '../scopes.js';
import { SqliteStore } from '../store.js';
import { consolidateTruthLayer, purgeExpiredScratch } from '../truth-layer.js';

// ── V2-2 acceptance: the design doc's isolation checklist, end to end ──
//
// Each test corresponds to a checkbox in docs/V2-2-SCOPE-MODEL.md. The unit
// coverage lives with each slice; this file runs the full lifecycle so scope
// isolation is demonstrated on real flows, not seeded fixtures.

describe('V2-2 scope isolation acceptance', () => {
  let root: string;
  after(() => rmSync(root, { recursive: true, force: true }));

  it('the full session lifecycle: store-only, rebuild-proof, expiring, explicit-read-only', async () => {
    root = mkdtempSync(join(tmpdir(), 'nacre-v22-accept-'));
    const store = SqliteStore.open(':memory:');

    // A durable write goes through capture (as MCP/API do)…
    appendCapture(root, {
      id: 'mem_d0d0d0d0d0d0',
      ts: '2026-07-10T09:00:00Z',
      origin: 'mcp',
      payload: { content: 'Durable decision about deploys.', type: 'decision', scope: 'user' },
    });
    // …while a session write is store-only, exactly as the write surfaces do it
    // (no spool entry, no candidate status).
    store.putNode({
      id: 'mem_5e5510101010',
      label: 'Session scratch about deploys.',
      aliases: [],
      type: 'concept',
      firstSeen: '2026-07-10T09:00:00Z',
      lastReinforced: '2026-07-10T09:00:00Z',
      mentionCount: 1,
      reinforcementCount: 0,
      sourceFiles: ['mcp'],
      excerpts: [{ file: 'mcp', text: 'Session scratch about deploys.', date: '2026-07-10' }],
      scope: SESSION_SCOPE,
    });

    const truth = consolidateTruthLayer(store, root, {
      now: new Date('2026-07-12T09:00:00Z'),
    });
    assert.equal(truth.promotion.promoted.length, 1, 'only the durable write promotes');
    assert.equal(readCaptureEntries(root).entries.length, 1, 'spool holds only the durable write');
    assert.ok(store.getNode('mem_5e5510101010'), 'fresh scratch survives consolidation');

    // Checkbox: session writes are absent after a rebuild.
    const rebuilt = SqliteStore.open(':memory:');
    compileMemoryDir(rebuilt, root);
    replayCaptureCandidates(rebuilt, root);
    assert.ok(rebuilt.getNode('mem_d0d0d0d0d0d0'), 'durable memory survives rebuild');
    assert.equal(
      rebuilt.getNode('mem_5e5510101010'),
      undefined,
      'session scratch cannot survive a rebuild — it exists in no durable tier',
    );
    rebuilt.close();

    // Checkbox: invisible to default recall, visible to explicit session recall.
    const defaultRecall = await recall(store, null, { query: 'deploys', limit: 20 });
    assert.ok(!defaultRecall.results.some((r) => r.id === 'mem_5e5510101010'));
    const sessionRecall = await recall(store, null, {
      query: 'deploys',
      scopes: [SESSION_SCOPE],
      limit: 20,
    });
    assert.ok(sessionRecall.results.some((r) => r.id === 'mem_5e5510101010'));

    // Checkbox: purged after retention (7 days by default).
    const purged = purgeExpiredScratch(store, undefined, new Date('2026-07-20T09:00:01Z'));
    assert.equal(purged.nodes, 1);
    assert.equal(store.getNode('mem_5e5510101010'), undefined);
    assert.ok(store.getNode('mem_d0d0d0d0d0d0'), 'durable memory untouched by purge');
    store.close();
  });

  it('cross-scope isolation on real truth-layer data, not fixtures', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nacre-v22-cross-'));
    const store = SqliteStore.open(':memory:');
    try {
      // Two projects and a user memory, all mentioning the same entity, all
      // arriving through the real capture → promote → compile pipeline.
      const writes: Array<[string, string]> = [
        ['mem_c0ffee000001', 'project/a'],
        ['mem_c0ffee000002', 'project/b'],
        ['mem_c0ffee000003', 'user'],
      ];
      for (const [i, [id, scope]] of writes.entries()) {
        appendCapture(dir, {
          id,
          ts: `2026-07-1${i}T09:00:00Z`,
          origin: 'mcp',
          payload: {
            content: `Deployment note ${i} for ${scope}.`,
            type: 'fact',
            scope,
            links: ['deployment'],
          },
        });
      }
      consolidateTruthLayer(store, dir);

      // Files landed in their scope directories.
      assert.ok(existsSync(join(dir, 'projects/a')));
      assert.ok(existsSync(join(dir, 'projects/b')));
      assert.ok(existsSync(join(dir, 'user')));

      // A project/a filter admits exactly project/a (plus the shared entity).
      const scoped = await recall(store, null, { query: 'deployment', scopes: ['project/a'], limit: 20 });
      const ids = scoped.results.map((r) => r.id);
      assert.ok(ids.includes('mem_c0ffee000001'));
      assert.ok(!ids.includes('mem_c0ffee000002'), 'project/b must not leak');
      assert.ok(!ids.includes('mem_c0ffee000003'), 'user must not leak');

      // Default recall sees all durable scopes.
      const all = await recall(store, null, { query: 'deployment', limit: 20 });
      const allIds = all.results.map((r) => r.id);
      for (const [id] of writes) assert.ok(allIds.includes(id));
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
