import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendCapture, readCaptureEntries } from '../capture.js';
import { compileMemoryDir, replayCaptureCandidates } from '../memory-compile.js';
import { forgetMemory } from '../memory-forget.js';
import { promoteCaptured } from '../memory-promote.js';
import { SqliteStore } from '../store.js';

const MEM_ID = 'mem_0011aabbccdd';

function captureAndPromote(store: SqliteStore, root: string): string {
  appendCapture(root, {
    id: MEM_ID,
    ts: '2026-07-17T09:00:00Z',
    origin: 'mcp',
    payload: { content: 'A memory to forget.', type: 'fact' },
  });
  const relPath = promoteCaptured(store, root).promoted[0];
  compileMemoryDir(store, root);
  return relPath;
}

describe('forgetMemory', () => {
  let root: string;
  let store: SqliteStore;

  beforeEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = mkdtempSync(join(tmpdir(), 'nacre-forget-'));
    store = SqliteStore.open(':memory:');
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it('removes the row, canonical file, and appends a tombstone', () => {
    const relPath = captureAndPromote(store, root);
    assert.ok(store.getNode(MEM_ID));
    assert.ok(existsSync(join(root, relPath)));

    const result = forgetMemory(store, root, MEM_ID, {
      ts: '2026-07-18T10:00:00Z',
      origin: 'mcp',
      reason: 'test',
    });

    assert.equal(result.nodeDeleted, true);
    assert.equal(result.fileDeleted, relPath);
    assert.equal(result.tombstoned, true);
    assert.equal(store.getNode(MEM_ID), undefined);
    assert.ok(!existsSync(join(root, relPath)));

    const { tombstones } = readCaptureEntries(root);
    assert.equal(tombstones.length, 1);
    assert.equal(tombstones[0].id, MEM_ID);
    assert.equal(tombstones[0].reason, 'test');
  });

  it('consolidate cannot resurrect a forgotten memory from the spool', () => {
    captureAndPromote(store, root);
    forgetMemory(store, root, MEM_ID, { ts: '2026-07-18T10:00:00Z', origin: 'mcp' });

    // Re-run the full consolidation truth-layer sequence.
    const promotion = promoteCaptured(store, root);
    const compiled = compileMemoryDir(store, root);
    assert.equal(promotion.promoted.length, 0);
    assert.equal(compiled.memories, 0);
    assert.equal(store.getNode(MEM_ID), undefined);
  });

  it('rebuild cannot resurrect a forgotten memory', () => {
    captureAndPromote(store, root);
    forgetMemory(store, root, MEM_ID, { ts: '2026-07-18T10:00:00Z', origin: 'mcp' });

    const fresh = SqliteStore.open(':memory:');
    compileMemoryDir(fresh, root);
    const replay = replayCaptureCandidates(fresh, root);
    assert.equal(fresh.getNode(MEM_ID), undefined);
    assert.equal(replay.candidates, 0);
    fresh.close();
  });

  it('a tombstoned canonical file synced back in is skipped with a warning, not compiled', () => {
    const relPath = captureAndPromote(store, root);
    const fileContent = readFileSync(join(root, relPath), 'utf-8');
    forgetMemory(store, root, MEM_ID, { ts: '2026-07-18T10:00:00Z', origin: 'mcp' });

    // Simulate the file reappearing via git sync from another device.
    mkdirSync(join(root, 'agent/facts'), { recursive: true });
    writeFileSync(join(root, relPath), fileContent);

    const compiled = compileMemoryDir(store, root);
    assert.equal(compiled.memories, 0);
    assert.ok(compiled.warnings.some((w) => w.includes('tombstoned')));
    assert.equal(store.getNode(MEM_ID), undefined);
  });

  it('without a memory dir it still deletes the row but reports tombstoned: false', () => {
    captureAndPromote(store, root);
    const result = forgetMemory(store, null, MEM_ID, { ts: '2026-07-18T10:00:00Z', origin: 'api' });
    assert.equal(result.nodeDeleted, true);
    assert.equal(result.tombstoned, false);
    assert.equal(store.getNode(MEM_ID), undefined);
  });

  it('a forget with no resolvable memory dir still blocks later promotion/replay (store-side record)', () => {
    captureAndPromote(store, root);
    // Forget while the memory dir is "unreachable" — spool tombstone impossible.
    forgetMemory(store, null, MEM_ID, { ts: '2026-07-18T10:00:00Z', origin: 'api' });
    // The canonical file survives the dir-less forget; remove it to simulate
    // the fullest resurrection surface: spool entry + no file + no spool
    // tombstone.
    rmSync(join(root, 'agent/facts/a-memory-to-forget.md'));

    const promotion = promoteCaptured(store, root);
    assert.equal(promotion.promoted.length, 0, 'promotion honors the store-side record');
    const replay = replayCaptureCandidates(store, root);
    assert.equal(replay.candidates, 0, 'replay honors the store-side record');
    assert.equal(store.getNode(MEM_ID), undefined);
  });
});

describe('missing memory dir resilience', () => {
  it('compileMemoryDir on a nonexistent directory returns empty instead of throwing', () => {
    const store = SqliteStore.open(':memory:');
    const result = compileMemoryDir(store, '/nonexistent/memory/dir');
    assert.equal(result.files, 0);
    assert.deepEqual(result.errors, []);
    store.close();
  });
});
