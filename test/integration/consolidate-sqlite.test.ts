import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { consolidate } from '@nacre/parser';
import { SqliteStore, MockEmbedder, type EmbeddingProvider } from '@nacre/core';

const FIXTURES_DIR = resolve(import.meta.dirname, '..', 'fixtures');
const DB_PATH = resolve(tmpdir(), `nacre-consolidate-sqlite-${process.pid}.db`);

function cleanup(): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const p = DB_PATH + suffix;
    if (existsSync(p)) rmSync(p);
  }
}

function snapshotCount(): number {
  const s = SqliteStore.open(DB_PATH);
  try {
    return s.listSnapshots().length;
  } finally {
    s.close();
  }
}

describe('consolidation pipeline — SQLite path (integration)', () => {
  before(cleanup);
  after(cleanup);

  it('persists nodes and edges into the .db via the delta upsert', async () => {
    const result = await consolidate({ inputs: [FIXTURES_DIR], outDir: DB_PATH });
    assert.ok(Object.keys(result.graph.nodes).length >= 50);

    const store = SqliteStore.open(DB_PATH);
    try {
      assert.equal(store.nodeCount(), Object.keys(result.graph.nodes).length);
      assert.ok(
        store.edgeCount() >= 100,
        `expected 100+ persisted edges, got ${store.edgeCount()}`,
      );
    } finally {
      store.close();
    }
  });

  it('does not snapshot a no-op incremental run', async () => {
    const before = snapshotCount();
    const result = await consolidate({ inputs: [FIXTURES_DIR], outDir: DB_PATH });
    assert.equal(result.newNodes, 0, 'incremental run should add 0 nodes');
    assert.equal(snapshotCount(), before, 'a no-op run must not create a snapshot');
  });

  it('embeds via embedBatch in chunks, never serial embed()', async () => {
    cleanup(); // fresh db so everything needs embedding
    let singleCalls = 0;
    let batchCalls = 0;
    const mock = new MockEmbedder();
    const counting: EmbeddingProvider = {
      name: mock.name,
      dimensions: mock.dimensions,
      embed: (t) => {
        singleCalls++;
        return mock.embed(t);
      },
      embedBatch: (ts) => {
        batchCalls++;
        return mock.embedBatch(ts);
      },
    };

    const result = await consolidate({
      inputs: [FIXTURES_DIR],
      outDir: DB_PATH,
      embeddingProvider: counting,
    });

    assert.equal(singleCalls, 0, 'must not call serial embed()');
    assert.ok(batchCalls >= 1, 'must call embedBatch at least once');
    assert.ok(result.newEmbeddings >= 50, `expected 50+ embeddings, got ${result.newEmbeddings}`);
    // CHUNK=64, so a fixtures-sized graph is a handful of batches, never one per item.
    assert.ok(
      batchCalls <= 5,
      `expected few batches, got ${batchCalls} for ${result.newEmbeddings}`,
    );

    const store = SqliteStore.open(DB_PATH);
    try {
      assert.ok(store.embeddingCount() >= 50);
    } finally {
      store.close();
    }
  });
});
