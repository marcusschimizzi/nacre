import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendCapture, readCaptureEntries } from '../capture.js';
import { compileMemoryDir } from '../memory-compile.js';
import { parseMemoryFile } from '../memory-file.js';
import { promoteCaptured } from '../memory-promote.js';
import { SqliteStore } from '../store.js';
import { consolidateTruthLayer } from '../truth-layer.js';
import type { MemoryNode } from '../types.js';

const MEM_ID = 'mem_0011aabbccdd';

function makePromotedRow(canonicalPath: string): MemoryNode {
  return {
    id: MEM_ID,
    label: 'A memory from elsewhere',
    aliases: [],
    type: 'concept',
    firstSeen: '2026-07-10T09:00:00Z',
    lastReinforced: '2026-07-15T09:00:00Z',
    mentionCount: 1,
    reinforcementCount: 2,
    sourceFiles: [canonicalPath],
    excerpts: [],
    status: 'promoted',
    canonicalPath,
  };
}

describe('missing-file semantics: deliberate deletion vs never-present', () => {
  let root: string;
  let store: SqliteStore;

  beforeEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = mkdtempSync(join(tmpdir(), 'nacre-truth-'));
    store = SqliteStore.open(':memory:');
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it('a promoted row whose file never existed in this dir is kept, not tombstoned', () => {
    // Fresh memory dir (e.g. new clone / switched memory.dir): the row's file
    // was never compiled from here — deleting it would be data loss.
    store.putNode(makePromotedRow('agent/facts/from-another-machine.md'));
    const result = compileMemoryDir(store, root);

    assert.equal(result.removed, 0);
    assert.ok(store.getNode(MEM_ID), 'row preserved');
    assert.ok(result.warnings.some((w) => w.includes('never compiled from this memory dir')));
    assert.equal(readCaptureEntries(root).tombstones.length, 0);
  });

  it('promotion heals a stale promoted row by recreating the file from capture', () => {
    appendCapture(root, {
      id: MEM_ID,
      ts: '2026-07-10T09:00:00Z',
      origin: 'mcp',
      payload: { content: 'A memory from elsewhere.', type: 'fact' },
    });
    store.putNode(makePromotedRow('agent/facts/from-another-machine.md'));

    const result = promoteCaptured(store, root);
    assert.equal(result.promoted.length, 1, 'file recreated from the spool');
    assert.ok(result.warnings.some((w) => w.includes('re-promoting from capture')));
    assert.ok(existsSync(join(root, result.promoted[0])));
  });

  it('hand-deletion in THIS dir still forgets durably (previously-seen path)', () => {
    appendCapture(root, {
      id: MEM_ID,
      ts: '2026-07-10T09:00:00Z',
      origin: 'mcp',
      payload: { content: 'A memory to hand-delete.', type: 'fact' },
    });
    // Full sequence promotes + compiles (recording the path as seen).
    const first = consolidateTruthLayer(store, root);
    const relPath = first.promotion.promoted[0];

    rmSync(join(root, relPath));
    const second = consolidateTruthLayer(store, root);
    assert.equal(second.promotion.promoted.length, 0, 'promote does not recreate');
    assert.equal(second.compiled.removed, 1, 'compile tombstones the deletion');
    assert.equal(store.getNode(MEM_ID), undefined);

    const third = consolidateTruthLayer(store, root);
    assert.equal(third.promotion.promoted.length, 0, 'stays forgotten');
    assert.ok(!existsSync(join(root, relPath)));
  });
});

describe('entityType preservation through the truth layer', () => {
  let root: string;
  let store: SqliteStore;

  beforeEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = mkdtempSync(join(tmpdir(), 'nacre-etype-'));
    store = SqliteStore.open(':memory:');
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it('capture → promote → compile keeps the entity-graph node type', () => {
    appendCapture(root, {
      id: MEM_ID,
      ts: '2026-07-18T09:00:00Z',
      origin: 'api',
      payload: {
        content: 'Ada Lovelace wrote the first program.',
        type: 'fact',
        entityType: 'person',
      },
    });
    const truth = consolidateTruthLayer(store, root);

    const relPath = truth.promotion.promoted[0];
    const parsed = parseMemoryFile(readFileSync(join(root, relPath), 'utf-8'), relPath);
    assert.equal(parsed.memory.entityType, 'person');

    const node = store.getNode(MEM_ID);
    assert.equal(node?.type, 'person', 'not reclassified to concept');
  });

  it('invalid entityType degrades to the default projection with a warning', () => {
    appendCapture(root, {
      id: 'mem_2233eeff0011',
      ts: '2026-07-18T09:00:00Z',
      origin: 'api',
      payload: { content: 'Odd typed memory.', type: 'fact', entityType: 'starship' },
    });
    const truth = consolidateTruthLayer(store, root);
    assert.ok(truth.warnings.some((w) => w.includes('unknown entity type')));
    assert.equal(store.getNode('mem_2233eeff0011')?.type, 'concept');
  });
});

describe('store-side tombstone migration', () => {
  it('consolidation migrates dir-less forget records into the spool', () => {
    const root = mkdtempSync(join(tmpdir(), 'nacre-migrate-'));
    const store = SqliteStore.open(':memory:');
    try {
      // Forget recorded while no memory dir resolved.
      store.recordForgotten({
        id: 'mem_dead00000001',
        ts: '2026-07-18T10:00:00Z',
        origin: 'api',
        reason: 'dir was unreachable',
      });

      consolidateTruthLayer(store, root);

      const { tombstones } = readCaptureEntries(root);
      assert.equal(tombstones.length, 1);
      assert.equal(tombstones[0].id, 'mem_dead00000001');
      assert.equal(tombstones[0].reason, 'dir was unreachable');

      // Idempotent: a second run does not duplicate the tombstone.
      consolidateTruthLayer(store, root);
      assert.equal(readCaptureEntries(root).tombstones.length, 1);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('clearAllEmbeddings clears provider meta (finding 4)', () => {
  it('best-effort embeds work again immediately after a clear', () => {
    const store = SqliteStore.open(':memory:');
    store.setMeta('embedding_provider', 'ollama/nomic-embed-text');
    store.setMeta('embedding_dimensions', '768');
    store.putEmbedding(
      'n1',
      'node',
      'x',
      new Float32Array(768).fill(0.5),
      'ollama/nomic-embed-text',
    );

    store.clearAllEmbeddings();
    assert.equal(store.getMeta('embedding_provider'), undefined);
    assert.equal(store.getMeta('embedding_dimensions'), undefined);
    assert.equal(store.getEncoderFingerprint(), undefined);

    // A different provider can now stamp a fresh space.
    store.putEmbedding('n2', 'node', 'y', new Float32Array(64).fill(0.5), 'mock');
    assert.equal(store.getEncoderFingerprint(), 'mock:64');
    store.close();
  });
});
