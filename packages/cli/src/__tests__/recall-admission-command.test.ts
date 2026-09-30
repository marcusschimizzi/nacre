import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { serializeMemoryFile, SqliteStore, type MemoryNode, type MemoryObject } from '@nacre/core';

const AT = '2026-07-23T12:00:00.000Z';

function seed(
  root: string,
  withEmbedding = false,
  memoryDirName = 'memory',
): { graph: string; memoryDir: string; canonical: string; sidecar: string } {
  const graph = join(root, 'graph.db');
  const memoryDir = join(root, memoryDirName);
  const rel = 'user/decisions/recall.md';
  const canonical = join(memoryDir, rel);
  const sidecar = join(memoryDir, '.candidates.jsonl');
  mkdirSync(join(memoryDir, 'user', 'decisions'), { recursive: true });
  const memory: MemoryObject = {
    id: 'mem_aaaaaaaaaaaa',
    type: 'decision',
    scope: 'user',
    confidence: 0.9,
    sensitivity: 'low',
    created: '2026-07-01',
    lastConfirmed: '2026-07-01',
    lifecycle: 'active',
    validFrom: '2026-07-01T00:00:00.000Z',
    sources: ['synthetic:recall-admission'],
    sourceAuthority: 'direct_user',
    trust: 1,
    eventTime: '2026-07-01T00:00:00.000Z',
    salience: { reinforcementCount: 0 },
    body: 'Use deterministic recall admission.',
  };
  writeFileSync(canonical, serializeMemoryFile(memory));
  writeFileSync(sidecar, '{"sentinel":true}\n');
  const node: MemoryNode = {
    id: memory.id,
    label: 'deterministic recall admission',
    aliases: [],
    type: 'decision',
    firstSeen: '2026-07-01',
    lastReinforced: '2026-07-01',
    mentionCount: 1,
    reinforcementCount: 0,
    sourceFiles: [rel],
    excerpts: [],
    status: 'promoted',
    canonicalPath: rel,
    scope: 'user',
    beliefLifecycle: 'active',
    validFrom: memory.validFrom,
  };
  const store = SqliteStore.open(graph);
  store.putNode(node);
  if (withEmbedding)
    store.putEmbedding(node.id, 'node', node.label, new Float32Array(64).fill(0.1), 'mock');
  store.close();
  return { graph, memoryDir, canonical, sidecar };
}

describe('built recall admission CLI', () => {
  const bin = join(import.meta.dirname, '../../dist/index.js');

  const run = (args: string[]) =>
    spawnSync(process.execPath, [bin, 'recall', ...args], {
      encoding: 'utf8',
      env: { ...process.env, NACRE_EMBEDDING_PROVIDER: '' },
    });

  it('preserves exact legacy no-match output and writes no receipt when --admit is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'nacre-recall-legacy-'));
    const { graph } = seed(root);
    const result = run(['nothingmatches', '--graph', graph]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'No results found.\n');
    const store = SqliteStore.open(graph);
    assert.deepEqual(store.listAdmissionReceipts(), []);
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('requires --memory-dir and strict --at only when admission is explicitly requested', () => {
    const root = mkdtempSync(join(tmpdir(), 'nacre-recall-validation-'));
    const { graph, memoryDir } = seed(root);
    const missingDir = run(['recall', '--graph', graph, '--admit', '--at', AT]);
    assert.notEqual(missingDir.status, 0);
    assert.match(missingDir.stderr, /--admit requires --memory-dir/i);
    const missingAt = run(['recall', '--graph', graph, '--admit', '--memory-dir', memoryDir]);
    assert.notEqual(missingAt.status, 0);
    assert.match(missingAt.stderr, /--admit requires strict --at/i);
    const badAt = run([
      'recall',
      '--graph',
      graph,
      '--admit',
      '--memory-dir',
      memoryDir,
      '--at',
      'tomorrow',
    ]);
    assert.notEqual(badAt.status, 0);
    assert.match(badAt.stderr, /strict --at/i);
    const mismatchedAsOf = run([
      'recall',
      '--graph',
      graph,
      '--admit',
      '--memory-dir',
      memoryDir,
      '--at',
      AT,
      '--as-of',
      '2026-07-01T00:00:00.000Z',
    ]);
    assert.notEqual(mismatchedAsOf.status, 0);
    assert.match(mismatchedAsOf.stderr, /--as-of.*--at.*match/i);
    rmSync(root, { recursive: true, force: true });
  });

  it('admits only canonical file-backed results, keeps retrieval score primary, persists a receipt, and leaves truth bytes unchanged', () => {
    const root = mkdtempSync(join(tmpdir(), 'nacre-recall-admit-'));
    const { graph, memoryDir, canonical, sidecar } = seed(root, false, 'custom-canonical');
    const canonicalBefore = readFileSync(canonical);
    const sidecarBefore = readFileSync(sidecar);
    const result = run([
      'deterministic',
      '--graph',
      graph,
      '--admit',
      '--memory-dir',
      memoryDir,
      '--at',
      AT,
      '--format',
      'json',
      '--source',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    const repeated = run([
      'deterministic',
      '--graph',
      graph,
      '--admit',
      '--memory-dir',
      memoryDir,
      '--at',
      AT,
      '--format',
      'json',
      '--source',
    ]);
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.deepEqual(JSON.parse(repeated.stdout).receipt, output.receipt);
    assert.equal(output.results.length, 1);
    assert.equal(output.results[0].id, 'mem_aaaaaaaaaaaa');
    assert.equal(output.results[0].claim, 'Use deterministic recall admission.');
    assert.equal(output.receipt.kind, 'recall');
    assert.equal(output.receipt.query, 'deterministic');
    assert.equal(output.receipt.candidates[0].retrievalRelevance, output.results[0].score);
    assert.deepEqual(output.receipt.included, ['mem_aaaaaaaaaaaa']);
    assert.deepEqual(readFileSync(canonical), canonicalBefore);
    assert.deepEqual(readFileSync(sidecar), sidecarBefore);
    const store = SqliteStore.open(graph);
    assert.equal(store.nodeCount(), 1);
    assert.deepEqual(store.listAdmissionReceipts(), [output.receipt]);
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('records a loud deterministic degradation and never reports degraded empty graph-only recall as an ordinary no-match', () => {
    const root = mkdtempSync(join(tmpdir(), 'nacre-recall-degraded-'));
    const { graph, memoryDir } = seed(root, true);
    const result = run([
      'nothingmatches',
      '--graph',
      graph,
      '--admit',
      '--memory-dir',
      memoryDir,
      '--at',
      AT,
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /embeddings exist.*graph-only/i);
    assert.doesNotMatch(result.stdout, /^No results found\./m);
    assert.match(result.stdout, /not authoritative evidence of no match/i);
    const store = SqliteStore.open(graph);
    const receipts = store.listAdmissionReceipts();
    assert.equal(receipts.length, 1);
    assert.deepEqual(receipts[0].degradations, [
      'semantic_recall_unavailable:embeddings_exist_without_provider;graph_only_results_non_authoritative',
    ]);
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('fails closed when a result points outside the canonical memory root', () => {
    const root = mkdtempSync(join(tmpdir(), 'nacre-recall-confined-'));
    const { graph, memoryDir } = seed(root);
    const store = SqliteStore.open(graph);
    const node = store.getNode('mem_aaaaaaaaaaaa');
    assert.ok(node);
    store.putNode({ ...node, canonicalPath: '../outside.md' });
    store.close();
    const result = run([
      'deterministic',
      '--graph',
      graph,
      '--admit',
      '--memory-dir',
      memoryDir,
      '--at',
      AT,
      '--format',
      'json',
      '--source',
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /confined.*canonical|canonical.*confined/i);
    const reopened = SqliteStore.open(graph);
    assert.deepEqual(reopened.listAdmissionReceipts(), []);
    reopened.close();
    rmSync(root, { recursive: true, force: true });
  });
});
