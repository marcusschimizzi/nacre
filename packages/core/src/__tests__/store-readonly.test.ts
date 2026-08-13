import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { SqliteStore } from '../store.js';
import type { MemoryNode } from '../types.js';

const node: MemoryNode = {
  id: 'mem_aaaaaaaaaaaa',
  label: 'read only memory',
  type: 'decision',
  aliases: [],
  firstSeen: '2026-01-01',
  lastReinforced: '2026-01-01',
  mentionCount: 1,
  reinforcementCount: 0,
  sourceFiles: [],
  excerpts: [],
};

describe('SqliteStore.openReadOnly', () => {
  it('opens an existing current-schema graph without changing bytes and rejects writes', () => {
    const root = mkdtempSync(join(tmpdir(), 'nacre-readonly-store-'));
    const graph = join(root, 'graph.db');
    try {
      const writable = SqliteStore.open(graph);
      writable.putNode(node);
      writable.close();
      const before = readFileSync(graph);

      const readonly = SqliteStore.openReadOnly(graph);
      assert.equal(readonly.getNode(node.id)?.label, node.label);
      assert.throws(() => readonly.putNode({ ...node, label: 'mutated' }), /readonly|read-only/i);
      readonly.close();

      assert.deepEqual(readFileSync(graph), before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when the graph file does not exist', () => {
    assert.throws(() => SqliteStore.openReadOnly('/path/that/does/not/exist.db'));
  });
});
