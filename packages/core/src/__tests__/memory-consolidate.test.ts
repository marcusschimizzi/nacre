import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { resolveMemoryCandidate } from '../memory-consolidate.js';
import type { MemoryCandidate } from '../memory-candidate.js';
import { parseMemoryFile, serializeMemoryFile } from '../memory-file.js';
import { compileMemoryDir, listMemoryFiles } from '../memory-compile.js';
import { SqliteStore } from '../store.js';
import { readFileSync } from 'node:fs';
import { recall } from '../recall.js';

function candidate(
  id: string,
  claim: string,
  messageId: string,
  eventTime: string,
): MemoryCandidate {
  return {
    id,
    type: 'claim',
    claim,
    normalizedClaim: claim.toLowerCase().replace(/[.!?]+$/, ''),
    scope: 'user',
    sensitivity: 'personal',
    confidence: 0.99,
    sourceAuthority: 'direct_user',
    trust: 1,
    eventTime,
    proposedAt: eventTime,
    evidence: [
      {
        sourceRef: `synthetic:s1#message:${messageId}`,
        messageId,
        span: { start: 0, end: claim.length, text: claim },
      },
    ],
    subjectEntityIds: [],
    extractor: { name: 'test-explicit', version: '1' },
    lifecycle: 'candidate',
    createdAt: '2026-07-22T10:00:00.000Z',
    updatedAt: '2026-07-22T10:00:00.000Z',
  };
}

function withEvidence(
  value: MemoryCandidate,
  sourceRef: string,
  messageId: string,
  contentHash: string,
): MemoryCandidate {
  return {
    ...value,
    evidence: [{ ...value.evidence[0], sourceRef, messageId, contentHash }],
  };
}

describe('explicit candidate consolidation', () => {
  it('counts identical bytes from distinct source events but not replay of one event', () => {
    const root = mkdtempSync(join(tmpdir(), 'nacre-consolidate-independent-'));
    const store = SqliteStore.open();
    const first = withEvidence(
      candidate(
        'mem_010101010101010101010101',
        'Remember that Project is running.',
        'm1',
        '2026-07-01T10:00:00.000Z',
      ),
      'synthetic:s1#message:m1',
      'm1',
      'same-hash',
    );
    const independent = withEvidence(
      candidate('mem_020202020202020202020202', first.claim, 'm2', '2026-07-02T10:00:00.000Z'),
      'synthetic:s2#message:m2',
      'm2',
      'same-hash',
    );
    const replay = withEvidence(
      candidate('mem_030303030303030303030303', first.claim, 'm1', '2026-07-03T10:00:00.000Z'),
      'synthetic:s1#message:m1',
      'm1',
      'same-hash',
    );
    for (const value of [first, independent, replay])
      store.createMemoryCandidate(value, { memoryDir: root });
    resolveMemoryCandidate(store, root, first.id);
    assert.equal(
      resolveMemoryCandidate(store, root, independent.id).confidenceInputs.independentEvidenceCount,
      2,
    );
    const beforeReplay = listMemoryFiles(root).map((path) =>
      readFileSync(join(root, path), 'utf8'),
    );
    const receipt = resolveMemoryCandidate(store, root, replay.id);
    assert.equal(receipt.decision, 'no_op');
    assert.equal(receipt.confidenceInputs.independentEvidenceCount, 2);
    assert.match(receipt.reason, /non_independent/);
    assert.equal(store.getMemoryCandidate(replay.id)?.lifecycle, 'candidate');
    assert.deepEqual(
      listMemoryFiles(root).map((path) => readFileSync(join(root, path), 'utf8')),
      beforeReplay,
    );
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('computes confidence from paired per-source authority and trust with documented provenance', () => {
    const root = mkdtempSync(join(tmpdir(), 'nacre-consolidate-confidence-'));
    const store = SqliteStore.open();
    const direct = {
      ...candidate(
        'mem_040404040404040404040404',
        'Remember that Project is running.',
        'm1',
        '2026-07-01T10:00:00.000Z',
      ),
      trust: 0.2,
      confidence: 0.01,
    };
    const inferred = {
      ...candidate('mem_050505050505050505050505', direct.claim, 'm2', '2026-07-02T10:00:00.000Z'),
      sourceAuthority: 'assistant_inference',
      trust: 1,
      confidence: 1,
    };
    store.createMemoryCandidate(direct, { memoryDir: root });
    store.createMemoryCandidate(inferred, { memoryDir: root });
    resolveMemoryCandidate(store, root, direct.id);
    const receipt = resolveMemoryCandidate(store, root, inferred.id);
    assert.equal(receipt.confidence, 0.68);
    assert.deepEqual(
      receipt.confidenceInputs.supports.map(({ authority, trust }) => ({ authority, trust })),
      [
        { authority: 1, trust: 0.2 },
        { authority: 0.6, trust: 1 },
      ],
    );
    assert.match(receipt.confidenceInputs.formula, /product/);
    const path = listMemoryFiles(root)[0];
    assert.equal(
      parseMemoryFile(readFileSync(join(root, path), 'utf8'), path).memory.confidence,
      receipt.confidence,
    );
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('routes explicit corrections without one supported target to review without writes', () => {
    const root = mkdtempSync(join(tmpdir(), 'nacre-consolidate-review-'));
    const store = SqliteStore.open();
    const correction = candidate(
      'mem_060606060606060606060606',
      'Correction: Project uses SQLite.',
      'm1',
      '2026-07-01T10:00:00.000Z',
    );
    store.createMemoryCandidate(correction, { memoryDir: root });
    const receipt = resolveMemoryCandidate(store, root, correction.id);
    assert.equal(receipt.decision, 'needs_review');
    assert.equal(listMemoryFiles(root).length, 0);
    assert.equal(store.getMemoryCandidate(correction.id)?.lifecycle, 'candidate');
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('allows direct-user correction over inference and refuses the reverse direction', () => {
    const root = mkdtempSync(join(tmpdir(), 'nacre-consolidate-authority-'));
    const store = SqliteStore.open();
    const inference = {
      ...candidate(
        'mem_070707070707070707070707',
        'Remember that Project is not running.',
        'a1',
        '2026-07-01T10:00:00.000Z',
      ),
      sourceAuthority: 'assistant_inference',
    };
    const direct = candidate(
      'mem_080808080808080808080808',
      'Correction: Project is running.',
      'u1',
      '2026-07-02T10:00:00.000Z',
    );
    store.createMemoryCandidate(inference, { memoryDir: root });
    store.createMemoryCandidate(direct, { memoryDir: root });
    resolveMemoryCandidate(store, root, inference.id);
    assert.equal(resolveMemoryCandidate(store, root, direct.id).decision, 'superseded');

    const reverseRoot = mkdtempSync(join(tmpdir(), 'nacre-consolidate-authority-reverse-'));
    const reverse = SqliteStore.open();
    const oldDirect = candidate(
      'mem_090909090909090909090909',
      'Remember that Service is not healthy.',
      'u2',
      '2026-07-01T10:00:00.000Z',
    );
    const correctionInference = {
      ...candidate(
        'mem_101010101010101010101010',
        'Correction: Service is healthy.',
        'a2',
        '2026-07-02T10:00:00.000Z',
      ),
      sourceAuthority: 'assistant_inference',
    };
    reverse.createMemoryCandidate(oldDirect, { memoryDir: reverseRoot });
    reverse.createMemoryCandidate(correctionInference, { memoryDir: reverseRoot });
    resolveMemoryCandidate(reverse, reverseRoot, oldDirect.id);
    assert.equal(
      resolveMemoryCandidate(reverse, reverseRoot, correctionInference.id).decision,
      'needs_review',
    );
    reverse.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(reverseRoot, { recursive: true, force: true });
  });

  it('fails closed before reads or writes when another resolver owns the memory root lock', () => {
    const root = mkdtempSync(join(tmpdir(), 'nacre-consolidate-lock-'));
    const store = SqliteStore.open();
    const value = candidate(
      'mem_111111111111111111111112',
      'Remember that Project is running.',
      'm1',
      '2026-07-01T10:00:00.000Z',
    );
    store.createMemoryCandidate(value, { memoryDir: root });
    mkdirSync(join(root, '.candidates', 'resolution.lock'));
    assert.throws(
      () => resolveMemoryCandidate(store, root, value.id),
      /resolver.*lock|in progress/i,
    );
    assert.equal(listMemoryFiles(root).length, 0);
    assert.equal(store.getMemoryCandidate(value.id)?.lifecycle, 'candidate');
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('reclaims a resolver lock left by a dead process on this host', () => {
    const root = mkdtempSync(join(tmpdir(), 'nacre-consolidate-stale-lock-'));
    const store = SqliteStore.open();
    const value = candidate(
      'mem_111111111111111111111113',
      'Remember that Project is running.',
      'm1',
      '2026-07-01T10:00:00.000Z',
    );
    store.createMemoryCandidate(value, { memoryDir: root });
    const lock = join(root, '.candidates', 'resolution.lock');
    mkdirSync(lock);
    writeFileSync(
      join(lock, 'owner.json'),
      `${JSON.stringify({ pid: 2_147_483_647, hostname: hostname() })}\n`,
      { mode: 0o600 },
    );

    assert.equal(resolveMemoryCandidate(store, root, value.id).decision, 'created');
    assert.equal(listMemoryFiles(root).length, 1);

    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('refuses rebuild recovery while a live resolver owns the memory root', () => {
    const root = mkdtempSync(join(tmpdir(), 'nacre-consolidate-live-lock-'));
    const store = SqliteStore.open();
    const value = candidate(
      'mem_111111111111111111111114',
      'Remember that Project is running.',
      'm1',
      '2026-07-01T10:00:00.000Z',
    );
    store.createMemoryCandidate(value, { memoryDir: root });
    assert.throws(
      () => resolveMemoryCandidate(store, root, value.id, { failAt: 'after_intent' }),
      /Injected/,
    );
    const lock = join(root, '.candidates', 'resolution.lock');
    mkdirSync(lock);
    writeFileSync(
      join(lock, 'owner.json'),
      `${JSON.stringify({ pid: process.pid, hostname: hostname() })}\n`,
      { mode: 0o600 },
    );

    assert.throws(() => compileMemoryDir(store, root), /resolver.*lock|in progress/i);
    assert.equal(listMemoryFiles(root).length, 0);
    assert.equal(store.getMemoryCandidate(value.id)?.lifecycle, 'candidate');

    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('rejects an ownership-mismatched pending intent before any durable write', () => {
    const root = mkdtempSync(join(tmpdir(), 'nacre-consolidate-intent-owner-'));
    const store = SqliteStore.open();
    const value = candidate(
      'mem_111111111111111111111115',
      'Remember that Project is running.',
      'm1',
      '2026-07-01T10:00:00.000Z',
    );
    store.createMemoryCandidate(value, { memoryDir: root });
    assert.throws(
      () => resolveMemoryCandidate(store, root, value.id, { failAt: 'after_intent' }),
      /Injected/,
    );
    const transactionDir = join(root, '.candidates', 'transactions');
    const transactionPath = join(
      transactionDir,
      readdirSync(transactionDir).find((name) => name.endsWith('.json')) ?? '',
    );
    const intent = JSON.parse(readFileSync(transactionPath, 'utf8'));
    intent.candidates[0].canonicalPath = 'user/claims/unrelated.md';
    writeFileSync(transactionPath, `${JSON.stringify(intent)}\n`, { mode: 0o600 });

    assert.throws(() => compileMemoryDir(store, root), /intent.*candidate|ownership/i);
    assert.equal(listMemoryFiles(root).length, 0);
    assert.equal(store.getMemoryCandidate(value.id)?.lifecycle, 'candidate');
    assert.equal(readdirSync(transactionDir).filter((name) => name.endsWith('.json')).length, 1);

    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('validates every pending intent destination before writing the first canonical', () => {
    const root = mkdtempSync(join(tmpdir(), 'nacre-consolidate-intent-path-'));
    const store = SqliteStore.open();
    const value = candidate(
      'mem_111111111111111111111116',
      'Remember that Project is running.',
      'm1',
      '2026-07-01T10:00:00.000Z',
    );
    store.createMemoryCandidate(value, { memoryDir: root });
    assert.throws(
      () => resolveMemoryCandidate(store, root, value.id, { failAt: 'after_intent' }),
      /Injected/,
    );
    const transactionDir = join(root, '.candidates', 'transactions');
    const transactionPath = join(
      transactionDir,
      readdirSync(transactionDir).find((name) => name.endsWith('.json')) ?? '',
    );
    const intent = JSON.parse(readFileSync(transactionPath, 'utf8'));
    intent.files.push({
      path: '../escape.md',
      content: serializeMemoryFile({
        id: 'mem_191919191919191919191919',
        type: 'claim',
        scope: 'user',
        confidence: 1,
        sensitivity: 'low',
        created: '2026-07-01',
        lastConfirmed: '2026-07-01',
        sources: [],
        salience: { reinforcementCount: 0 },
        body: 'Unrelated canonical.',
      }),
    });
    writeFileSync(transactionPath, `${JSON.stringify(intent)}\n`, { mode: 0o600 });

    assert.throws(() => compileMemoryDir(store, root), /escapes memory root/i);
    assert.equal(listMemoryFiles(root).length, 0);
    assert.equal(store.getMemoryCandidate(value.id)?.lifecycle, 'candidate');

    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('isolates same-claim and correction targets by scope and refuses stale correction', () => {
    const root = mkdtempSync(join(tmpdir(), 'nacre-consolidate-refusals-'));
    const store = SqliteStore.open();
    const old = candidate(
      'mem_141414141414141414141414',
      'Remember that Project is not running.',
      'm1',
      '2026-07-02T10:00:00.000Z',
    );
    const crossScope = {
      ...candidate('mem_151515151515151515151515', old.claim, 'm2', '2026-07-03T10:00:00.000Z'),
      scope: 'agent',
    };
    const equal = candidate(
      'mem_161616161616161616161616',
      'Correction: Project is running.',
      'm3',
      old.eventTime,
    );
    const sameScopeSupport = candidate(
      'mem_171717171717171717171717',
      old.claim,
      'm4',
      '2026-07-04T10:00:00.000Z',
    );
    store.createMemoryCandidate(old, { memoryDir: root });
    store.createMemoryCandidate(crossScope, { memoryDir: root });
    store.createMemoryCandidate(equal, { memoryDir: root });
    store.createMemoryCandidate(sameScopeSupport, { memoryDir: root });
    resolveMemoryCandidate(store, root, old.id);
    assert.equal(resolveMemoryCandidate(store, root, crossScope.id).decision, 'created');
    assert.equal(resolveMemoryCandidate(store, root, sameScopeSupport.id).decision, 'corroborated');
    assert.equal(store.getMemoryCandidate(sameScopeSupport.id)?.resolvedMemoryId, old.id);
    assert.equal(listMemoryFiles(root).length, 2);
    const before = listMemoryFiles(root).map((path) => readFileSync(join(root, path), 'utf8'));
    assert.equal(resolveMemoryCandidate(store, root, equal.id).decision, 'needs_review');
    assert.deepEqual(
      listMemoryFiles(root).map((path) => readFileSync(join(root, path), 'utf8')),
      before,
    );
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('filters hidden semantic hits before admission and hidden graph nodes before traversal', async () => {
    const store = SqliteStore.open();
    const node = (id: string, label: string, extras: Record<string, unknown> = {}) => ({
      id,
      label,
      aliases: [],
      type: 'concept' as const,
      firstSeen: '2026-01-01',
      lastReinforced: '2026-01-01',
      mentionCount: 1,
      reinforcementCount: 0,
      sourceFiles: [],
      excerpts: [],
      ...extras,
    });
    store.putNode(node('seed-visible', 'Seed'));
    store.putNode(
      node('hidden-bridge', 'Hidden', {
        beliefLifecycle: 'superseded',
        validFrom: '2026-01-01T00:00:00.000Z',
        validUntil: '2026-02-01T00:00:00.000Z',
      }),
    );
    store.putNode(node('target-visible', 'Target'));
    for (const [id, source, target] of [
      ['edge-1', 'seed-visible', 'hidden-bridge'],
      ['edge-2', 'hidden-bridge', 'target-visible'],
    ]) {
      store.putEdge({
        id,
        source,
        target,
        type: 'explicit',
        directed: false,
        weight: 1,
        baseWeight: 1,
        reinforcementCount: 1,
        firstFormed: '2026-01-01',
        lastReinforced: '2026-01-01',
        stability: 1,
        evidence: [],
      });
    }
    store.putEmbedding('hidden-bridge', 'node', 'semantic-only', new Float32Array([1, 0]), 'test');
    const provider = {
      name: 'test',
      dimensions: 2,
      embed: async () => new Float32Array([1, 0]),
      embedBatch: async (texts: string[]) => texts.map(() => new Float32Array([1, 0])),
    };
    const current = await recall(store, provider, { query: 'Seed', hops: 3, limit: 10 });
    assert.deepEqual(
      current.results.map((result) => result.id),
      ['seed-visible'],
    );
    const historical = await recall(store, provider, {
      query: 'Seed',
      asOf: '2025-12-01T00:00:00.000Z',
      hops: 3,
      limit: 10,
    });
    assert.ok(
      !historical.results.some(
        (result) => result.id === 'hidden-bridge' || result.id === 'target-visible',
      ),
    );
    store.close();
  });

  it('creates one active canonical belief and a machine-readable receipt', () => {
    const root = mkdtempSync(join(tmpdir(), 'nacre-consolidate-create-'));
    const store = SqliteStore.open();
    const value = candidate(
      'mem_aaaaaaaaaaaaaaaaaaaaaaaa',
      'Remember that Project is running.',
      'm1',
      '2026-07-01T10:00:00.000Z',
    );
    store.createMemoryCandidate(value, { memoryDir: root });

    const receipt = resolveMemoryCandidate(store, root, value.id, {
      now: '2026-07-22T11:00:00.000Z',
    });

    assert.equal(receipt.decision, 'created');
    assert.equal(receipt.candidateId, value.id);
    assert.equal(receipt.memoryId, value.id);
    assert.equal(receipt.confidenceInputs.independentEvidenceCount, 1);
    assert.equal(store.getMemoryCandidate(value.id)?.lifecycle, 'promoted');
    const files = listMemoryFiles(root);
    assert.equal(files.length, 1);
    const parsed = parseMemoryFile(readFileSync(join(root, files[0]), 'utf8'), files[0]);
    assert.equal(parsed.memory.lifecycle, 'active');
    assert.deepEqual(parsed.memory.candidateIds, [value.id]);
    assert.equal(parsed.memory.independentEvidenceCount, 1);

    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('corroborates the same claim using only new independent evidence and is idempotent', () => {
    const root = mkdtempSync(join(tmpdir(), 'nacre-consolidate-corroborate-'));
    const store = SqliteStore.open();
    const first = candidate(
      'mem_aaaaaaaaaaaaaaaaaaaaaaaa',
      'Remember that Project is running.',
      'm1',
      '2026-07-01T10:00:00.000Z',
    );
    const second = candidate(
      'mem_bbbbbbbbbbbbbbbbbbbbbbbb',
      'Remember that Project is running.',
      'm2',
      '2026-07-10T10:00:00.000Z',
    );
    store.createMemoryCandidate(first, { memoryDir: root });
    store.createMemoryCandidate(second, { memoryDir: root });
    resolveMemoryCandidate(store, root, first.id, { now: '2026-07-22T11:00:00.000Z' });

    const receipt = resolveMemoryCandidate(store, root, second.id, {
      now: '2026-07-22T12:00:00.000Z',
    });
    assert.equal(receipt.decision, 'corroborated');
    assert.equal(receipt.memoryId, first.id);
    assert.equal(receipt.confidenceInputs.independentEvidenceCount, 2);
    assert.equal(receipt.confidence, 1);
    assert.equal(store.getMemoryCandidate(second.id)?.resolvedMemoryId, first.id);
    const files = listMemoryFiles(root);
    assert.equal(files.length, 1);
    const before = readFileSync(join(root, files[0]), 'utf8');
    const parsed = parseMemoryFile(before, files[0]);
    assert.deepEqual(parsed.memory.candidateIds, [first.id, second.id]);
    assert.deepEqual(parsed.memory.evidence, [...first.evidence, ...second.evidence]);
    assert.equal(parsed.memory.lastConfirmed, '2026-07-10');

    const rerun = resolveMemoryCandidate(store, root, second.id, {
      now: '2026-08-01T00:00:00.000Z',
    });
    assert.equal(rerun.decision, 'no_op');
    assert.equal(readFileSync(join(root, files[0]), 'utf8'), before);
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('supersedes the supported copular negation pair without overwriting history', () => {
    const root = mkdtempSync(join(tmpdir(), 'nacre-consolidate-supersede-'));
    const store = SqliteStore.open();
    const old = candidate(
      'mem_cccccccccccccccccccccccc',
      'Remember that Project is not running.',
      'm1',
      '2026-07-01T10:00:00.000Z',
    );
    const correction = candidate(
      'mem_dddddddddddddddddddddddd',
      'Correction: Project is running.',
      'm2',
      '2026-07-10T10:00:00.000Z',
    );
    store.createMemoryCandidate(old, { memoryDir: root });
    store.createMemoryCandidate(correction, { memoryDir: root });
    resolveMemoryCandidate(store, root, old.id, { now: '2026-07-22T11:00:00.000Z' });

    const receipt = resolveMemoryCandidate(store, root, correction.id, {
      now: '2026-07-22T12:00:00.000Z',
    });
    assert.equal(receipt.decision, 'superseded');
    assert.equal(receipt.memoryId, correction.id);
    assert.equal(receipt.supersededMemoryId, old.id);
    const parsed = listMemoryFiles(root).map(
      (path) => parseMemoryFile(readFileSync(join(root, path), 'utf8'), path).memory,
    );
    const oldMemory = parsed.find((memory) => memory.id === old.id);
    const newMemory = parsed.find((memory) => memory.id === correction.id);
    assert.equal(parsed.length, 2);
    assert.equal(oldMemory?.lifecycle, 'superseded');
    assert.equal(oldMemory?.supersededBy, correction.id);
    assert.equal(oldMemory?.validUntil, correction.eventTime);
    assert.equal(newMemory?.lifecycle, 'active');
    assert.equal(newMemory?.supersedes, old.id);
    assert.equal(newMemory?.validFrom, correction.eventTime);
    assert.equal(store.getMemoryCandidate(correction.id)?.resolvedMemoryId, correction.id);

    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('rebuilds validity and recalls the current or as-of belief without snapshots', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nacre-consolidate-recall-'));
    const source = SqliteStore.open();
    const old = candidate(
      'mem_eeeeeeeeeeeeeeeeeeeeeeee',
      'Remember that Project is not running.',
      'm1',
      '2026-07-01T10:00:00.000Z',
    );
    const correction = candidate(
      'mem_ffffffffffffffffffffffff',
      'Correction: Project is running.',
      'm2',
      '2026-07-10T10:00:00.000Z',
    );
    source.createMemoryCandidate(old, { memoryDir: root });
    source.createMemoryCandidate(correction, { memoryDir: root });
    resolveMemoryCandidate(source, root, old.id);
    resolveMemoryCandidate(source, root, correction.id);

    const rebuilt = SqliteStore.open();
    assert.deepEqual(compileMemoryDir(rebuilt, root).errors, []);
    const current = await recall(rebuilt, null, { query: 'Project running', limit: 10 });
    const historical = await recall(rebuilt, null, {
      query: 'Project running',
      limit: 10,
      asOf: '2026-07-05T00:00:00.000Z',
    });
    assert.deepEqual(
      current.results.map((result) => result.id),
      [correction.id],
    );
    assert.deepEqual(
      historical.results.map((result) => result.id),
      [old.id],
    );
    assert.equal(rebuilt.getMemoryCandidate(correction.id)?.resolvedMemoryId, correction.id);

    rebuilt.close();
    source.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('recovers a durable supersession intent at the rebuild boundary after a deterministic half-write', () => {
    const root = mkdtempSync(join(tmpdir(), 'nacre-consolidate-recover-'));
    const source = SqliteStore.open();
    const old = candidate(
      'mem_121212121212121212121212',
      'Remember that Project is not running.',
      'm1',
      '2026-07-01T10:00:00.000Z',
    );
    const correction = candidate(
      'mem_343434343434343434343434',
      'Correction: Project is running.',
      'm2',
      '2026-07-10T10:00:00.000Z',
    );
    source.createMemoryCandidate(old, { memoryDir: root });
    source.createMemoryCandidate(correction, { memoryDir: root });
    resolveMemoryCandidate(source, root, old.id);
    assert.throws(
      () => resolveMemoryCandidate(source, root, correction.id, { failAt: 'after_file_1' }),
      /Injected resolution failure/,
    );
    source.close();

    const rebuilt = SqliteStore.open();
    const result = compileMemoryDir(rebuilt, root);
    assert.deepEqual(result.errors, []);
    assert.equal(rebuilt.getMemoryCandidate(correction.id)?.resolvedMemoryId, correction.id);
    const memories = listMemoryFiles(root).map(
      (path) => parseMemoryFile(readFileSync(join(root, path), 'utf8'), path).memory,
    );
    assert.equal(memories.find((value) => value.id === old.id)?.supersededBy, correction.id);
    assert.equal(memories.find((value) => value.id === correction.id)?.supersedes, old.id);
    rebuilt.close();
    rmSync(root, { recursive: true, force: true });
  });

  for (const failAt of [
    'after_intent',
    'after_file_1',
    'after_file_2',
    'after_candidate_sidecars',
    'after_database',
  ] as const) {
    it(`recovers ${failAt} to the same bytes and keeps the rerun byte-stable`, () => {
      const root = mkdtempSync(join(tmpdir(), `nacre-consolidate-${failAt}-`));
      const db = join(root, 'graph.db');
      const source = SqliteStore.open(db);
      const old = candidate(
        'mem_aaaaaaaaaaaa111111111111',
        'Remember that Project is not running.',
        'm1',
        '2026-07-01T10:00:00.000Z',
      );
      const correction = candidate(
        'mem_bbbbbbbbbbbb222222222222',
        'Correction: Project is running.',
        'm2',
        '2026-07-10T10:00:00.000Z',
      );
      source.createMemoryCandidate(old, { memoryDir: root });
      source.createMemoryCandidate(correction, { memoryDir: root });
      resolveMemoryCandidate(source, root, old.id, { now: '2026-07-23T00:00:00.000Z' });
      assert.throws(
        () =>
          resolveMemoryCandidate(source, root, correction.id, {
            now: '2026-07-24T00:00:00.000Z',
            failAt,
          }),
        /Injected/,
      );
      source.close();
      const recovered = SqliteStore.open(db);
      assert.deepEqual(compileMemoryDir(recovered, root).errors, []);
      const paths = listMemoryFiles(root);
      const before = paths.map((path) => readFileSync(join(root, path), 'utf8'));
      assert.equal(resolveMemoryCandidate(recovered, root, correction.id).decision, 'no_op');
      assert.deepEqual(
        paths.map((path) => readFileSync(join(root, path), 'utf8')),
        before,
      );
      assert.equal(recovered.getMemoryCandidate(correction.id)?.resolvedMemoryId, correction.id);
      recovered.close();
      rmSync(root, { recursive: true, force: true });
    });
  }

  it('preserves hand-edited canonical prose and sections while appending provenance', () => {
    const root = mkdtempSync(join(tmpdir(), 'nacre-consolidate-hand-edit-'));
    const store = SqliteStore.open();
    const first = candidate(
      'mem_565656565656565656565656',
      'Remember that Project is running.',
      'm1',
      '2026-07-01T10:00:00.000Z',
    );
    const second = candidate(
      'mem_787878787878787878787878',
      first.claim,
      'm2',
      '2026-07-10T10:00:00.000Z',
    );
    store.createMemoryCandidate(first, { memoryDir: root });
    store.createMemoryCandidate(second, { memoryDir: root });
    resolveMemoryCandidate(store, root, first.id);
    const path = listMemoryFiles(root)[0];
    const parsed = parseMemoryFile(readFileSync(join(root, path), 'utf8'), path);
    parsed.memory.body = `${parsed.memory.body}\n\n## Human Notes\n\nKeep this hand-authored analysis.`;
    writeFileSync(join(root, path), `${serializeForTest(parsed.memory)}`);

    resolveMemoryCandidate(store, root, second.id);
    const after = readFileSync(join(root, path), 'utf8');
    assert.match(after, /## Human Notes\n\nKeep this hand-authored analysis\./);
    assert.match(after, /message:m2/);
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('rejects malformed local lineage and validity at the canonical parse boundary', () => {
    const root = mkdtempSync(join(tmpdir(), 'nacre-consolidate-parse-lineage-'));
    const store = SqliteStore.open();
    const value = candidate(
      'mem_909090909090909090909090',
      'Remember that Project is running.',
      'm1',
      '2026-07-01T10:00:00.000Z',
    );
    store.createMemoryCandidate(value, { memoryDir: root });
    resolveMemoryCandidate(store, root, value.id);
    const path = listMemoryFiles(root)[0];
    const parsed = parseMemoryFile(readFileSync(join(root, path), 'utf8'), path);
    parsed.memory.supersededBy = parsed.memory.id;
    assert.throws(
      () => parseMemoryFile(serializeMemoryFile(parsed.memory), path),
      /lineage|superseded/i,
    );
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('fails canonical preflight before compiling valid peers when candidate lineage cannot parse', () => {
    const root = mkdtempSync(join(tmpdir(), 'nacre-consolidate-preflight-'));
    const source = SqliteStore.open();
    const value = candidate(
      'mem_121212121212121212121213',
      'Remember that Project is running.',
      'm1',
      '2026-07-01T10:00:00.000Z',
    );
    source.createMemoryCandidate(value, { memoryDir: root });
    resolveMemoryCandidate(source, root, value.id);
    const path = listMemoryFiles(root)[0];
    const malformed = readFileSync(join(root, path), 'utf8')
      .replace(`id: ${value.id}`, 'id: mem_131313131313131313131313')
      .replace('lifecycle: promoted', 'lifecycle: candidate');
    const malformedPath = 'user/claims/malformed-lineage.md';
    writeFileSync(join(root, malformedPath), malformed);
    source.close();

    const rebuilt = SqliteStore.open();
    const result = compileMemoryDir(rebuilt, root);
    assert.match(result.errors.join('\n'), /candidate_records|lineage|preflight/i);
    assert.equal(rebuilt.nodeCount(), 0);
    rebuilt.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('fails rebuild when canonical confidence provenance disagrees with candidate records', () => {
    const root = mkdtempSync(join(tmpdir(), 'nacre-consolidate-confidence-tamper-'));
    const source = SqliteStore.open();
    const value = {
      ...candidate(
        'mem_181818181818181818181818',
        'Remember that Project is running.',
        'm1',
        '2026-07-01T10:00:00.000Z',
      ),
      trust: 0.4,
    };
    source.createMemoryCandidate(value, { memoryDir: root });
    resolveMemoryCandidate(source, root, value.id);
    const path = listMemoryFiles(root)[0];
    const original = readFileSync(join(root, path), 'utf8');
    const tampered = original
      .replace(/formula:.*$/m, "formula: 'candidate.confidence'")
      .replace(/authority: 1(?:\.0+)?$/m, 'authority: 0.25');
    assert.notEqual(tampered, original);
    writeFileSync(join(root, path), tampered);

    const rebuilt = SqliteStore.open();
    const result = compileMemoryDir(rebuilt, root);
    assert.ok(result.errors.length > 0);
    assert.equal(rebuilt.listNodes().length, 0);

    rebuilt.close();
    source.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('fails rebuild closed before writes for asymmetric cross-file lineage', () => {
    const root = mkdtempSync(join(tmpdir(), 'nacre-consolidate-rebuild-lineage-'));
    const source = SqliteStore.open();
    const old = candidate(
      'mem_abababababababababababab',
      'Remember that Project is not running.',
      'm1',
      '2026-07-01T10:00:00.000Z',
    );
    const correction = candidate(
      'mem_cdcdcdcdcdcdcdcdcdcdcdcd',
      'Correction: Project is running.',
      'm2',
      '2026-07-10T10:00:00.000Z',
    );
    source.createMemoryCandidate(old, { memoryDir: root });
    source.createMemoryCandidate(correction, { memoryDir: root });
    resolveMemoryCandidate(source, root, old.id);
    resolveMemoryCandidate(source, root, correction.id);
    const newPath = listMemoryFiles(root).find((path) =>
      readFileSync(join(root, path), 'utf8').includes(correction.id),
    );
    assert.ok(newPath);
    const parsed = parseMemoryFile(readFileSync(join(root, newPath), 'utf8'), newPath);
    delete parsed.memory.supersedes;
    writeFileSync(join(root, newPath), serializeMemoryFile(parsed.memory));

    const rebuilt = SqliteStore.open();
    const result = compileMemoryDir(rebuilt, root);
    assert.match(result.errors.join('\n'), /asymmetric/i);
    assert.equal(rebuilt.nodeCount(), 0);
    rebuilt.close();
    source.close();
    rmSync(root, { recursive: true, force: true });
  });
});

function serializeForTest(memory: ReturnType<typeof parseMemoryFile>['memory']): string {
  // Imported lazily below would obscure the fixture; this helper keeps the
  // hand-edit represented as a valid canonical rewrite.
  return serializeMemoryFile(memory);
}
