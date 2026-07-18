import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readCaptureEntries } from '../capture.js';
import { compileMemoryDir, listMemoryFiles, replayCaptureCandidates } from '../memory-compile.js';
import { generateNodeId } from '../graph.js';
import { SqliteStore } from '../store.js';

const DECISION = `---
id: mem_aaaa11112222
type: decision
scope: project/nacre
confidence: 0.9
created: 2026-07-10
salience:
  reinforcement_count: 3
  last_reinforced: 2026-07-15
---

Chose [[SQLite]] over JSON persistence for [[nacre]].

## Source

> "JSON import/export kept for portability" — ROADMAP
`;

const PREFERENCE = `---
id: mem_bbbb33334444
type: preference
scope: user
created: 2026-07-12
---

Marcus prefers [[TypeScript]] strict mode in [[nacre]].
`;

function writeFixture(root: string): void {
  mkdirSync(join(root, 'projects/nacre/decisions'), { recursive: true });
  mkdirSync(join(root, 'user/preferences'), { recursive: true });
  mkdirSync(join(root, '.capture'), { recursive: true });
  writeFileSync(join(root, 'projects/nacre/decisions/sqlite-over-json.md'), DECISION);
  writeFileSync(join(root, 'user/preferences/typescript-strict.md'), PREFERENCE);
  writeFileSync(join(root, '.capture/2026-07-17.jsonl'), '{"ignored": true}\n');
}

describe('listMemoryFiles', () => {
  let root: string;
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'nacre-list-'));
    writeFixture(root);
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it('lists .md files sorted and skips dot-directories', () => {
    assert.deepEqual(listMemoryFiles(root), [
      'projects/nacre/decisions/sqlite-over-json.md',
      'user/preferences/typescript-strict.md',
    ]);
  });
});

describe('compileMemoryDir', () => {
  let root: string;
  let store: SqliteStore;

  beforeEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = mkdtempSync(join(tmpdir(), 'nacre-compile-'));
    writeFixture(root);
    store = SqliteStore.open(':memory:');
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it('compiles memories into nodes with stable ids and file provenance', () => {
    const result = compileMemoryDir(store, root);
    assert.equal(result.files, 2);
    assert.equal(result.memories, 2);
    assert.equal(result.errors.length, 0);

    const decision = store.getNode('mem_aaaa11112222');
    assert.ok(decision);
    assert.equal(decision.type, 'decision');
    assert.match(decision.label, /^Chose \[\[SQLite\]\]/);
    assert.equal(decision.firstSeen, '2026-07-10');
    assert.equal(decision.lastReinforced, '2026-07-15');
    assert.equal(decision.reinforcementCount, 3);
    assert.deepEqual(decision.sourceFiles, ['projects/nacre/decisions/sqlite-over-json.md']);
  });

  it('creates entity nodes for wikilink targets and explicit edges to them', () => {
    const result = compileMemoryDir(store, root);
    // SQLite, nacre, TypeScript — nacre is shared between the two memories.
    assert.equal(result.entitiesCreated, 3);

    const nacreEntity = store.findNode('nacre');
    assert.ok(nacreEntity);
    assert.equal(nacreEntity.id, generateNodeId('nacre'));

    const edges = store
      .listEdges()
      .filter((e) => e.source === 'mem_aaaa11112222' || e.target === 'mem_aaaa11112222');
    assert.equal(edges.length, 2);
    assert.ok(edges.every((e) => e.type === 'explicit'));
  });

  it('is deterministic: two compiles from the same directory produce identical graphs', () => {
    compileMemoryDir(store, root);
    const other = SqliteStore.open(':memory:');
    compileMemoryDir(other, root);

    const a = store.getFullGraph();
    const b = other.getFullGraph();
    assert.deepEqual(a.nodes, b.nodes);
    assert.deepEqual(a.edges, b.edges);
    other.close();
  });

  it('recompiling into the same store is idempotent (files are the truth)', () => {
    compileMemoryDir(store, root);
    const firstNodes = store.nodeCount();
    const firstEdges = store.edgeCount();
    compileMemoryDir(store, root);
    assert.equal(store.nodeCount(), firstNodes);
    assert.equal(store.edgeCount(), firstEdges);
  });

  it('an edited file wins over the previous compiled state', () => {
    compileMemoryDir(store, root);
    writeFileSync(
      join(root, 'user/preferences/typescript-strict.md'),
      PREFERENCE.replace('confidence: ', '').replace(
        'Marcus prefers [[TypeScript]] strict mode in [[nacre]].',
        'Marcus prefers [[TypeScript]] strict mode everywhere.',
      ),
    );
    compileMemoryDir(store, root);
    const node = store.getNode('mem_bbbb33334444');
    assert.ok(node);
    assert.match(node.label, /everywhere/);
  });

  it('reports malformed files as errors without aborting the rest', () => {
    writeFileSync(join(root, 'user/preferences/broken.md'), 'no frontmatter at all');
    const result = compileMemoryDir(store, root);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /broken\.md/);
    assert.equal(result.memories, 2);
  });

  it('deletes promoted rows whose canonical file was removed (files are truth both ways)', () => {
    compileMemoryDir(store, root);
    assert.ok(store.getNode('mem_aaaa11112222'));
    store.putEmbedding('mem_aaaa11112222', 'node', 'text', new Float32Array(8).fill(0.5), 'mock');

    rmSync(join(root, 'projects/nacre/decisions/sqlite-over-json.md'));
    const result = compileMemoryDir(store, root);

    assert.equal(result.removed, 1);
    assert.equal(store.getNode('mem_aaaa11112222'), undefined);
    assert.equal(store.getEmbedding('mem_aaaa11112222'), undefined);
    assert.ok(result.warnings.some((w) => w.includes('canonical file removed')));
    // The other memory is untouched.
    assert.ok(store.getNode('mem_bbbb33334444'));

    // The removal is tombstoned so the original spool entry cannot re-promote
    // the memory and recreate the file on a later consolidation.
    const { tombstones } = readCaptureEntries(root);
    assert.ok(tombstones.some((t) => t.id === 'mem_aaaa11112222' && t.origin === 'reconcile'));
    const rerun = compileMemoryDir(store, root);
    assert.equal(rerun.removed, 0);
    assert.equal(store.getNode('mem_aaaa11112222'), undefined);
  });

  it('an edited frontmatter id removes the stale promoted row (no duplicates)', () => {
    compileMemoryDir(store, root);
    assert.ok(store.getNode('mem_bbbb33334444'));

    // Hand-edit the file's id.
    writeFileSync(
      join(root, 'user/preferences/typescript-strict.md'),
      PREFERENCE.replace('mem_bbbb33334444', 'mem_cccc55556666'),
    );
    const result = compileMemoryDir(store, root);

    assert.ok(store.getNode('mem_cccc55556666'), 'new id compiled');
    assert.equal(store.getNode('mem_bbbb33334444'), undefined, 'stale row removed');
    assert.equal(result.removed, 1);
    assert.ok(result.warnings.some((w) => w.includes('file id changed')));

    // The old id is tombstoned so nothing can resurrect it later.
    const { tombstones } = readCaptureEntries(root);
    assert.ok(tombstones.some((t) => t.id === 'mem_bbbb33334444'));
  });

  it('a parse error does NOT delete the memory the broken file backs', () => {
    compileMemoryDir(store, root);
    assert.ok(store.getNode('mem_bbbb33334444'));

    // Corrupt the file in place — the row must survive until the file is fixed.
    writeFileSync(join(root, 'user/preferences/typescript-strict.md'), 'broken: no frontmatter');
    const result = compileMemoryDir(store, root);

    assert.equal(result.removed, 0);
    assert.equal(result.errors.length, 1);
    assert.ok(store.getNode('mem_bbbb33334444'));
  });

  it('replayCaptureCandidates recreates unpromoted spool entries as candidates', () => {
    writeFileSync(
      join(root, '.capture/2026-07-17.jsonl'),
      `${JSON.stringify({
        id: 'mem_9999ffff0000',
        ts: '2026-07-17T11:00:00Z',
        origin: 'mcp',
        payload: { content: 'Unpromoted spooled memory.', type: 'decision', links: ['nacre'] },
      })}\n`,
    );
    compileMemoryDir(store, root);
    const replay = replayCaptureCandidates(store, root);
    assert.deepEqual(replay.errors, []);
    assert.equal(replay.candidates, 1);
    assert.equal(replay.edges, 1);

    const node = store.getNode('mem_9999ffff0000');
    assert.equal(node?.status, 'candidate');
    assert.equal(node?.type, 'decision');
    assert.deepEqual(node?.sourceFiles, ['.capture/2026-07-17.jsonl']);

    // Idempotent, and promoted entries (compiled from their file) are skipped.
    const second = replayCaptureCandidates(store, root);
    assert.equal(second.candidates, 0);
    assert.equal(second.skipped, 1);
  });

  it('surfaces per-file warnings with the file path attached', () => {
    writeFileSync(
      join(root, 'user/preferences/odd.md'),
      `---\nid: mem_cccc55556666\ntype: fact\nscope: user\ncreated: 2026-07-16\nvibes: high\n---\n\nA fact.\n`,
    );
    const result = compileMemoryDir(store, root);
    assert.ok(result.warnings.some((w) => w.includes('odd.md') && w.includes('vibes')));
  });
});
