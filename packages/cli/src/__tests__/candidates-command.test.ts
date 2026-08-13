import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { SqliteStore, type MemoryCandidate } from '@nacre/core';
import { executeCandidateAction } from '../commands/candidates.js';

function seed(store: SqliteStore): MemoryCandidate {
  const value: MemoryCandidate = {
    id: 'mem_abcdefabcdefabcdefabcdef',
    type: 'decision',
    claim: 'We decided to ship the narrow slice.',
    normalizedClaim: 'we decided to ship the narrow slice',
    scope: 'project/nacre',
    sensitivity: 'low',
    confidence: 0.99,
    sourceAuthority: 'direct_user',
    trust: 1,
    eventTime: '2026-07-22T08:00:00.000Z',
    proposedAt: '2026-07-22T08:00:00.000Z',
    evidence: [
      {
        sourceRef: 'openclaw:s#message:m',
        messageId: 'm',
        span: { start: 0, end: 36, text: 'We decided to ship the narrow slice.' },
      },
    ],
    subjectEntityIds: [],
    extractor: { name: 'test', version: '1' },
    lifecycle: 'candidate',
    createdAt: '2026-07-22T09:00:00.000Z',
    updatedAt: '2026-07-22T09:00:00.000Z',
  };
  store.createMemoryCandidate(value);
  return value;
}

describe('candidates command surface', () => {
  it('lists, shows, promotes, and rejects candidates through one usable command contract', () => {
    const root = mkdtempSync(join(tmpdir(), 'nacre-cli-candidates-'));
    const db = join(root, 'graph.db');
    const memoryDir = join(root, 'memory');
    const store = SqliteStore.open(db);
    const first = seed(store);
    const second = seed(store);
    second.id = 'mem_111111111111111111111111';
    store.createMemoryCandidate(second);
    store.close();

    assert.equal(executeCandidateAction({ action: 'list', graph: db }).length, 2);
    assert.equal(executeCandidateAction({ action: 'show', graph: db, id: first.id }).id, first.id);
    assert.equal(
      executeCandidateAction({ action: 'promote', graph: db, id: first.id, memoryDir }).lifecycle,
      'promoted',
    );
    assert.equal(
      executeCandidateAction({
        action: 'reject',
        graph: db,
        id: second.id,
        reason: 'duplicate',
        memoryDir,
      }).lifecycle,
      'rejected',
    );

    rmSync(root, { recursive: true, force: true });
  });

  it('uses the actual built CLI parser for list validation, stdout, and required rejection reason', () => {
    execFileSync('npm', ['run', 'build', '-w', '@nacre/core'], {
      cwd: join(import.meta.dirname, '../../../..'),
      stdio: 'pipe',
    });
    execFileSync('npm', ['run', 'build', '-w', '@nacre/cli'], {
      cwd: join(import.meta.dirname, '../../../..'),
      stdio: 'pipe',
    });
    const root = mkdtempSync(join(tmpdir(), 'nacre-cli-candidates-parser-'));
    const db = join(root, 'graph.db');
    const store = SqliteStore.open(db);
    const value = seed(store);
    store.close();
    const bin = join(import.meta.dirname, '../../dist/index.js');
    const memoryDir = join(root, 'memory');

    const list = spawnSync(process.execPath, [bin, 'candidates', 'list', '--graph', db], {
      encoding: 'utf8',
    });
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, new RegExp(value.id));

    const resolve = spawnSync(
      process.execPath,
      [bin, 'candidates', 'resolve', value.id, '--graph', db, '--memory-dir', memoryDir],
      { encoding: 'utf8' },
    );
    assert.equal(resolve.status, 0, resolve.stderr);
    const receipt = JSON.parse(resolve.stdout) as {
      decision: string;
      candidateId: string;
      memoryId: string;
    };
    assert.deepEqual(receipt, {
      decision: 'created',
      candidateId: value.id,
      memoryId: value.id,
      reason: 'no_matching_canonical_belief',
      confidence: 1,
      confidenceInputs: {
        independentEvidenceCount: 1,
        supports: [
          {
            sourceEventId: 'openclaw:s#message:m|m',
            sourceAuthority: 'direct_user',
            authority: 1,
            trust: 1,
          },
        ],
        formula: '1 - product(1 - support.authority * support.trust)',
      },
    });

    const badLifecycle = spawnSync(
      process.execPath,
      [bin, 'candidates', 'list', '--graph', db, '--lifecycle', 'nonsense'],
      { encoding: 'utf8' },
    );
    assert.notEqual(badLifecycle.status, 0);
    assert.match(badLifecycle.stderr, /lifecycle/i);

    const missingReason = spawnSync(
      process.execPath,
      [bin, 'candidates', 'reject', value.id, '--graph', db],
      { encoding: 'utf8' },
    );
    assert.notEqual(missingReason.status, 0);
    assert.match(missingReason.stderr, /reason/i);

    const missingMemoryDir = spawnSync(
      process.execPath,
      [bin, 'candidates', 'reject', value.id, '--graph', db, '--reason', 'duplicate'],
      { encoding: 'utf8' },
    );
    assert.notEqual(missingMemoryDir.status, 0);
    assert.match(missingMemoryDir.stderr, /memory-dir/i);

    const unknownAction = spawnSync(
      process.execPath,
      [bin, 'candidates', 'nonsense', '--graph', db],
      { encoding: 'utf8' },
    );
    assert.notEqual(unknownAction.status, 0);

    rmSync(root, { recursive: true, force: true });
  });
});
