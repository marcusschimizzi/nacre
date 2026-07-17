import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendCapture } from '../capture.js';
import { compileMemoryDir } from '../memory-compile.js';
import { parseMemoryFile } from '../memory-file.js';
import { promoteCaptured } from '../memory-promote.js';
import { SqliteStore } from '../store.js';
import type { CaptureEntry } from '../capture.js';
import type { MemoryNode } from '../types.js';

function makeEntry(overrides: Partial<CaptureEntry> = {}): CaptureEntry {
  return {
    id: 'mem_0011aabbccdd',
    ts: '2026-07-17T09:14:02Z',
    origin: 'mcp',
    tool: 'nacre_remember',
    payload: { content: 'Vite is faster than Webpack.', type: 'fact', links: ['Vite'] },
    ...overrides,
  };
}

function makeCandidate(id: string): MemoryNode {
  return {
    id,
    label: 'Vite is faster than Webpack.',
    aliases: [],
    type: 'concept',
    firstSeen: '2026-07-17T09:14:02Z',
    lastReinforced: '2026-07-17T09:14:02Z',
    mentionCount: 1,
    reinforcementCount: 2,
    sourceFiles: ['mcp'],
    excerpts: [],
    status: 'candidate',
  };
}

describe('promoteCaptured', () => {
  let root: string;
  let store: SqliteStore;

  beforeEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = mkdtempSync(join(tmpdir(), 'nacre-promote-'));
    store = SqliteStore.open(':memory:');
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it('materializes a canonical file for a captured entry and flips the node to promoted', () => {
    appendCapture(root, makeEntry());
    store.putNode(makeCandidate('mem_0011aabbccdd'));

    const result = promoteCaptured(store, root);
    assert.deepEqual(result.errors, []);
    assert.equal(result.promoted.length, 1);

    const relPath = result.promoted[0];
    assert.equal(relPath, 'agent/facts/vite-is-faster-than-webpack.md');
    const parsed = parseMemoryFile(readFileSync(join(root, relPath), 'utf-8'), relPath);
    assert.equal(parsed.memory.id, 'mem_0011aabbccdd');
    assert.equal(parsed.memory.scope, 'agent');
    assert.equal(parsed.memory.created, '2026-07-17');
    assert.deepEqual(parsed.memory.sources, ['capture:2026-07-17.jsonl']);
    // Candidate salience carried into the file.
    assert.equal(parsed.memory.salience.reinforcementCount, 2);
    // Links became wikilinks in the body.
    assert.deepEqual(parsed.wikilinks, ['Vite']);

    const node = store.getNode('mem_0011aabbccdd');
    assert.equal(node?.status, 'promoted');
    assert.equal(node?.canonicalPath, relPath);
  });

  it('is idempotent: a second run promotes nothing new', () => {
    appendCapture(root, makeEntry());
    store.putNode(makeCandidate('mem_0011aabbccdd'));
    promoteCaptured(store, root);
    const second = promoteCaptured(store, root);
    assert.equal(second.promoted.length, 0);
    assert.equal(second.skipped, 1);
  });

  it('never overwrites an existing canonical file with the same id (hand edits win)', () => {
    appendCapture(root, makeEntry());
    store.putNode(makeCandidate('mem_0011aabbccdd'));
    const first = promoteCaptured(store, root);
    const relPath = first.promoted[0];
    const abs = join(root, relPath);

    // Hand-edit the canonical file, then simulate a fresh store (post-rebuild).
    const edited = readFileSync(abs, 'utf-8').replace(
      'Vite is faster than Webpack.',
      'Vite is much faster than Webpack in dev.',
    );
    writeFileSync(abs, edited);
    const fresh = SqliteStore.open(':memory:');

    const rerun = promoteCaptured(fresh, root);
    assert.equal(rerun.promoted.length, 0);
    assert.equal(rerun.skipped, 1);
    assert.match(readFileSync(abs, 'utf-8'), /much faster/);
    fresh.close();
  });

  it('suffixes the filename when a different memory owns the slug', () => {
    appendCapture(root, makeEntry());
    appendCapture(
      root,
      makeEntry({
        id: 'mem_2233eeff0011',
        ts: '2026-07-18T10:00:00Z',
        payload: { content: 'Vite is faster than Webpack.', type: 'fact' },
      }),
    );
    const result = promoteCaptured(store, root);
    assert.equal(result.promoted.length, 2);
    assert.ok(result.promoted.includes('agent/facts/vite-is-faster-than-webpack.md'));
    assert.ok(result.promoted.includes('agent/facts/vite-is-faster-than-webpack-2.md'));
  });

  it('falls back on unknown types and invalid scopes with warnings', () => {
    appendCapture(
      root,
      makeEntry({
        payload: {
          content: 'Odd memory.',
          type: 'vibe' as never,
          scope: 'everything',
        },
      }),
    );
    const result = promoteCaptured(store, root);
    assert.equal(result.promoted.length, 1);
    assert.equal(result.warnings.length, 2);
    const parsed = parseMemoryFile(readFileSync(join(root, result.promoted[0]), 'utf-8'));
    assert.equal(parsed.memory.type, 'fact');
    assert.equal(parsed.memory.scope, 'agent');
  });

  it('promote → compile round-trip: the compiled node is promoted and file-backed', () => {
    appendCapture(root, makeEntry());
    store.putNode(makeCandidate('mem_0011aabbccdd'));
    promoteCaptured(store, root);
    compileMemoryDir(store, root);

    const node = store.getNode('mem_0011aabbccdd');
    assert.ok(node);
    assert.equal(node.status, 'promoted');
    assert.equal(node.canonicalPath, 'agent/facts/vite-is-faster-than-webpack.md');
    assert.deepEqual(node.sourceFiles, ['agent/facts/vite-is-faster-than-webpack.md']);
    // The wikilinked entity exists and is connected.
    assert.ok(store.findNode('Vite'));
  });

  it('a rebuilt store recovers promoted state from the files alone', () => {
    appendCapture(root, makeEntry());
    store.putNode(makeCandidate('mem_0011aabbccdd'));
    promoteCaptured(store, root);

    const fresh = SqliteStore.open(':memory:');
    compileMemoryDir(fresh, root);
    const node = fresh.getNode('mem_0011aabbccdd');
    assert.equal(node?.status, 'promoted');
    assert.ok(existsSync(join(root, node?.canonicalPath ?? '')));
    fresh.close();
  });
});
