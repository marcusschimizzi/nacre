import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { admitWorkingMemory, SqliteStore, type MemoryObject } from '@nacre/core';
import { executeReceiptsCommand } from '../commands/receipts.js';

const AT = '2026-07-23T12:00:00.000Z';

function memory(): MemoryObject {
  return {
    id: 'mem_aaaaaaaaaaaa',
    type: 'decision',
    scope: 'user',
    confidence: 0.8,
    sensitivity: 'low',
    created: '2026-07-01',
    lastConfirmed: '2026-07-01',
    sources: ['synthetic:receipts-cli'],
    sourceAuthority: 'direct_user',
    trust: 1,
    eventTime: '2026-07-01T00:00:00.000Z',
    salience: { reinforcementCount: 0 },
    body: 'Receipt CLI.',
  };
}

describe('receipts command', () => {
  const bin = join(import.meta.dirname, '../../dist/index.js');

  it('lists, gets, validates, and reports not-found through the actual built process', () => {
    const root = mkdtempSync(join(tmpdir(), 'nacre-receipts-built-'));
    const graphPath = join(root, 'graph.db');
    const receipt = admitWorkingMemory([{ memory: memory(), claim: 'Receipt CLI.' }], {
      kind: 'brief',
      evaluatedAt: AT,
    });
    const store = SqliteStore.open(graphPath);
    store.putAdmissionReceipt(receipt);
    store.close();
    const run = (args: string[]) =>
      spawnSync(process.execPath, [bin, 'receipts', '--graph', graphPath, ...args], {
        encoding: 'utf8',
      });
    const list = run(['--kind', 'brief', '--limit', '1']);
    assert.equal(list.status, 0, list.stderr);
    assert.deepEqual(JSON.parse(list.stdout), [
      { id: receipt.id, kind: 'brief', evaluatedAt: AT, included: 1, rejected: 0 },
    ]);
    const get = run(['--id', receipt.id]);
    assert.equal(get.status, 0, get.stderr);
    assert.deepEqual(JSON.parse(get.stdout), receipt);
    const missing = run(['--id', `rcpt_${'0'.repeat(64)}`]);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /not found/i);
    const invalid = run(['--kind', 'invalid']);
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /kind.*brief.*recall/i);
    const missingGraph = join(root, 'typo.db');
    const invalidMissing = spawnSync(
      process.execPath,
      [bin, 'receipts', '--graph', missingGraph, '--limit', 'nope'],
      { encoding: 'utf8' },
    );
    assert.notEqual(invalidMissing.status, 0);
    assert.equal(existsSync(missingGraph), false);
    rmSync(root, { recursive: true, force: true });
  });

  it('lists stable receipt summaries and retrieves a full receipt by id', () => {
    const root = mkdtempSync(join(tmpdir(), 'nacre-receipts-cli-'));
    const graphPath = join(root, 'graph.db');
    const receipt = admitWorkingMemory([{ memory: memory(), claim: 'Receipt CLI.' }], {
      kind: 'brief',
      evaluatedAt: AT,
    });
    const store = SqliteStore.open(graphPath);
    store.putAdmissionReceipt(receipt);
    store.close();

    assert.deepEqual(executeReceiptsCommand({ graphPath }), [
      {
        id: receipt.id,
        kind: 'brief',
        evaluatedAt: AT,
        included: 1,
        rejected: 0,
      },
    ]);
    assert.deepEqual(executeReceiptsCommand({ graphPath, id: receipt.id }), receipt);
    assert.throws(
      () => executeReceiptsCommand({ graphPath, id: `rcpt_${'0'.repeat(64)}` }),
      /not found/i,
    );
    rmSync(root, { recursive: true, force: true });
  });
});
