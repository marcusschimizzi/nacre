import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendCapture, captureFileFor, readCaptureEntries, CAPTURE_DIR } from '../capture.js';
import { SqliteStore } from '../store.js';
import type { CaptureEntry } from '../capture.js';

function makeEntry(overrides: Partial<CaptureEntry> = {}): CaptureEntry {
  return {
    id: 'mem_0011aabbccdd',
    ts: '2026-07-17T09:14:02Z',
    origin: 'mcp',
    tool: 'nacre_remember',
    payload: { content: 'A captured fact.', type: 'fact' },
    ...overrides,
  };
}

describe('capture spool', () => {
  let root: string;

  beforeEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = mkdtempSync(join(tmpdir(), 'nacre-capture-'));
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it('appends entries to a per-day JSONL file, creating the spool dir', () => {
    const file = appendCapture(root, makeEntry());
    assert.equal(file, join(root, CAPTURE_DIR, '2026-07-17.jsonl'));
    assert.ok(existsSync(file));
    appendCapture(root, makeEntry({ id: 'mem_1122ddeeff00' }));
    const lines = readFileSync(file, 'utf-8').trim().split('\n');
    assert.equal(lines.length, 2);
  });

  it('captureFileFor buckets by UTC day', () => {
    assert.equal(captureFileFor('2026-07-17T23:59:59Z'), '2026-07-17.jsonl');
    assert.equal(captureFileFor('2026-07-18T00:00:01Z'), '2026-07-18.jsonl');
  });

  it('reads entries back in chronological order across files', () => {
    appendCapture(root, makeEntry({ id: 'mem_bbbbbbbbbbbb', ts: '2026-07-18T08:00:00Z' }));
    appendCapture(root, makeEntry({ id: 'mem_aaaaaaaaaaaa', ts: '2026-07-17T08:00:00Z' }));
    const { entries, errors } = readCaptureEntries(root);
    assert.deepEqual(errors, []);
    assert.deepEqual(
      entries.map((e) => e.id),
      ['mem_aaaaaaaaaaaa', 'mem_bbbbbbbbbbbb'],
    );
  });

  it('returns empty for a directory with no spool', () => {
    const { entries, errors } = readCaptureEntries(root);
    assert.deepEqual(entries, []);
    assert.deepEqual(errors, []);
  });

  it('reports malformed lines with file and line number, never silently drops', () => {
    appendCapture(root, makeEntry());
    const file = join(root, CAPTURE_DIR, '2026-07-17.jsonl');
    writeFileSync(file, `${readFileSync(file, 'utf-8')}not json\n{"id": 42}\n`);
    const { entries, errors } = readCaptureEntries(root);
    assert.equal(entries.length, 1);
    assert.equal(errors.length, 2);
    assert.match(errors[0], /2026-07-17\.jsonl:2/);
    assert.match(errors[1], /missing id\/ts\/payload\.content/);
  });

  it('ignores non-jsonl files in the spool dir', () => {
    mkdirSync(join(root, CAPTURE_DIR), { recursive: true });
    writeFileSync(join(root, CAPTURE_DIR, 'README.md'), 'not a spool file');
    appendCapture(root, makeEntry());
    const { entries, errors } = readCaptureEntries(root);
    assert.equal(entries.length, 1);
    assert.deepEqual(errors, []);
  });
});

describe('candidate status on nodes (schema v7)', () => {
  it('round-trips status and canonical_path through the store', () => {
    const store = SqliteStore.open(':memory:');
    store.putNode({
      id: 'mem_0011aabbccdd',
      label: 'A captured fact.',
      aliases: [],
      type: 'concept',
      firstSeen: '2026-07-17',
      lastReinforced: '2026-07-17',
      mentionCount: 1,
      reinforcementCount: 0,
      sourceFiles: ['mcp'],
      excerpts: [],
      status: 'candidate',
    });
    let node = store.getNode('mem_0011aabbccdd');
    assert.equal(node?.status, 'candidate');
    assert.equal(node?.canonicalPath, undefined);

    store.putNode({ ...node!, status: 'promoted', canonicalPath: 'user/facts/a-captured-fact.md' });
    node = store.getNode('mem_0011aabbccdd');
    assert.equal(node?.status, 'promoted');
    assert.equal(node?.canonicalPath, 'user/facts/a-captured-fact.md');

    // Ordinary entity nodes stay unmarked.
    store.putNode({
      id: 'entity1',
      label: 'TypeScript',
      aliases: [],
      type: 'tool',
      firstSeen: '2026-07-17',
      lastReinforced: '2026-07-17',
      mentionCount: 1,
      reinforcementCount: 0,
      sourceFiles: [],
      excerpts: [],
    });
    assert.equal(store.getNode('entity1')?.status, undefined);
    store.close();
  });
});
