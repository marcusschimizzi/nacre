import assert from 'node:assert/strict';
import { lstatSync, mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  assertCanonicalTreeUnchanged,
  copyRegularFileBounded,
  MAX_CANONICAL_MEMORY_BYTES,
  readRegularFileBounded,
  scanCanonicalTree,
} from '../commands/evaluation-input.js';

describe('descriptor-grounded evaluation input', () => {
  it('rejects a canonical file replaced after the tree scan', () => {
    const root = mkdtempSync(join(tmpdir(), 'nacre-evaluation-input-'));
    try {
      const directory = join(root, 'user');
      const path = join(directory, 'mem_aaaaaaaaaaaa.md');
      const replacement = join(root, 'replacement.md');
      mkdirSync(directory);
      writeFileSync(path, 'original');
      const [scanned] = scanCanonicalTree(root);
      assert.ok(scanned);
      writeFileSync(replacement, 'replacement');
      renameSync(replacement, path);
      assert.throws(
        () =>
          readRegularFileBounded(
            scanned.file,
            MAX_CANONICAL_MEMORY_BYTES,
            'Canonical memory',
            scanned.identity,
          ),
        /changed after the canonical tree was scanned/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a graph replaced after its initial identity check', () => {
    const root = mkdtempSync(join(tmpdir(), 'nacre-evaluation-graph-input-'));
    try {
      const graph = join(root, 'graph.db');
      const replacement = join(root, 'replacement.db');
      const destination = join(root, 'copy.db');
      writeFileSync(graph, 'original');
      const expected = lstatSync(graph);
      writeFileSync(replacement, 'replacement');
      renameSync(replacement, graph);
      assert.throws(
        () =>
          copyRegularFileBounded(graph, destination, 1024, 'Graph', {
            dev: expected.dev,
            ino: expected.ino,
            size: expected.size,
            mtimeMs: expected.mtimeMs,
            ctimeMs: expected.ctimeMs,
          }),
        /changed before it was copied/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects canonical tree membership added after the initial scan', () => {
    const root = mkdtempSync(join(tmpdir(), 'nacre-evaluation-membership-'));
    try {
      const directory = join(root, 'user');
      mkdirSync(directory);
      writeFileSync(join(directory, 'mem_aaaaaaaaaaaa.md'), 'original');
      const scanned = scanCanonicalTree(root);
      writeFileSync(join(directory, 'mem_bbbbbbbbbbbb.md'), 'added');
      assert.throws(
        () => assertCanonicalTreeUnchanged(root, scanned),
        /canonical memory tree changed after it was scanned/i,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
