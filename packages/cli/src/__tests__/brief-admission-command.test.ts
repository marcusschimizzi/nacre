import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { serializeMemoryFile, SqliteStore, type MemoryObject } from '@nacre/core';
import { executeWorkingMemoryBrief } from '../commands/brief.js';

const AT = '2026-07-23T12:00:00.000Z';

function seed(root: string): void {
  const memory: MemoryObject = {
    id: 'mem_aaaaaaaaaaaa',
    type: 'decision',
    scope: 'user',
    confidence: 0.8,
    sensitivity: 'low',
    created: '2026-07-01',
    lastConfirmed: '2026-07-01',
    sources: ['synthetic:brief'],
    sourceAuthority: 'direct_user',
    trust: 1,
    eventTime: '2026-07-01T00:00:00.000Z',
    salience: { reinforcementCount: 0 },
    body: 'Persist a bounded working-memory brief.',
  };
  const dir = join(root, 'user', 'decisions');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'brief.md'), serializeMemoryFile(memory));
}

describe('brief working-memory mode', () => {
  const bin = join(import.meta.dirname, '../../dist/index.js');

  it('runs the actual built CLI working-memory boundary and persists the surfaced receipt', () => {
    const root = mkdtempSync(join(tmpdir(), 'nacre-brief-built-'));
    const graphPath = join(root, 'graph.db');
    const memoryDir = join(root, 'memories');
    seed(memoryDir);
    SqliteStore.open(graphPath).close();
    const run = spawnSync(
      process.execPath,
      [
        bin,
        'brief',
        '--graph',
        graphPath,
        '--memory-dir',
        memoryDir,
        '--at',
        AT,
        '--format',
        'json',
      ],
      { encoding: 'utf8' },
    );
    assert.equal(run.status, 0, run.stderr);
    const output = JSON.parse(run.stdout);
    assert.equal(output.kind, 'brief');
    assert.deepEqual(output.included, ['mem_aaaaaaaaaaaa']);
    const store = SqliteStore.open(graphPath);
    assert.deepEqual(store.listAdmissionReceipts(), [output]);
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('requires explicit inputs, admits canonical memories, persists only a derived receipt, and is deterministic', () => {
    const root = mkdtempSync(join(tmpdir(), 'nacre-brief-admit-'));
    const graphPath = join(root, 'graph.db');
    const memoryDir = join(root, 'memories');
    seed(memoryDir);
    SqliteStore.open(graphPath).close();
    const before = readFileSync(join(memoryDir, 'user', 'decisions', 'brief.md'), 'utf8');

    const first = executeWorkingMemoryBrief({ graphPath, memoryDir, evaluatedAt: AT });
    const second = executeWorkingMemoryBrief({ graphPath, memoryDir, evaluatedAt: AT });
    const rebuiltGraphPath = join(root, 'rebuilt.db');
    SqliteStore.open(rebuiltGraphPath).close();
    const rebuilt = executeWorkingMemoryBrief({
      graphPath: rebuiltGraphPath,
      memoryDir,
      evaluatedAt: AT,
    });

    assert.deepEqual(second, first);
    assert.deepEqual(rebuilt, first);
    assert.deepEqual(first.included, ['mem_aaaaaaaaaaaa']);
    assert.equal(readFileSync(join(memoryDir, 'user', 'decisions', 'brief.md'), 'utf8'), before);
    const store = SqliteStore.open(graphPath);
    assert.deepEqual(store.listAdmissionReceipts(), [first]);
    assert.equal(store.nodeCount(), 0);
    assert.equal(store.edgeCount(), 0);
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
});
