import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { MemoryCandidate } from '../memory-candidate.js';
import type { MemoryObject } from '../memory-file.js';
import { parseMemoryFile, serializeMemoryFile } from '../memory-file.js';
import { compileMemoryDir } from '../memory-compile.js';
import { SqliteStore } from '../store.js';
import {
  computeDeterministicEntityDegrees,
  evaluateMemorySalience,
  rankMemorySalience,
} from '../index.js';
import type { MemoryEdge } from '../types.js';

const AT = '2026-07-23T12:00:00.000Z';

function candidate(overrides: Partial<MemoryCandidate> = {}): MemoryCandidate {
  const claim = 'We decided to keep salience deterministic.';
  return {
    id: 'mem_111111111111',
    type: 'decision',
    claim,
    normalizedClaim: 'we decided to keep salience deterministic',
    scope: 'project/nacre',
    sensitivity: 'low',
    confidence: 0.99,
    sourceAuthority: 'direct_user',
    trust: 1,
    eventTime: '2026-07-01T10:00:00.000Z',
    proposedAt: '2026-07-01T10:00:00.000Z',
    evidence: [
      {
        sourceRef: 'synthetic:session-1',
        messageId: 'message-1',
        span: { start: 0, end: claim.length, text: claim },
      },
    ],
    subjectEntityIds: ['entity:nacre'],
    extractor: { name: 'synthetic-test', version: '1' },
    lifecycle: 'promoted',
    canonicalPath: 'projects/nacre/decisions/deterministic.md',
    resolvedMemoryId: 'mem_aaaaaaaaaaaa',
    createdAt: '2026-07-01T10:00:00.000Z',
    updatedAt: '2026-07-01T10:00:00.000Z',
    ...overrides,
  };
}

function memory(overrides: Partial<MemoryObject> = {}): MemoryObject {
  const support = candidate();
  return {
    id: 'mem_aaaaaaaaaaaa',
    type: 'decision',
    scope: 'project/nacre',
    confidence: 1,
    sensitivity: 'low',
    created: '2026-07-01',
    lastConfirmed: '2026-07-01',
    lifecycle: 'active',
    validFrom: '2026-07-01T10:00:00.000Z',
    candidateIds: [support.id],
    candidateRecords: [support],
    independentEvidenceCount: 1,
    confidenceInputs: {
      independentEvidenceCount: 1,
      supports: [
        {
          sourceEventId: 'synthetic:session-1|message-1',
          sourceAuthority: 'direct_user',
          authority: 1,
          trust: 1,
        },
      ],
      formula: '1 - product(1 - support.authority * support.trust)',
    },
    sources: ['synthetic:session-1'],
    subjectEntityIds: ['entity:nacre'],
    salience: { reinforcementCount: 0 },
    body: 'We decided to keep salience deterministic.',
    ...overrides,
  };
}

describe('deterministic explainable memory salience', () => {
  it('returns a versioned receipt with fixed weights, normalized inputs, components, gates, and stable score fields', () => {
    const receipt = evaluateMemorySalience(memory(), {
      evaluatedAt: AT,
      entityDegrees: { 'entity:nacre': 4 },
    });

    assert.equal(receipt.version, 'nacre.salience.v1');
    assert.equal(receipt.memoryId, 'mem_aaaaaaaaaaaa');
    assert.equal(receipt.evaluatedAt, AT);
    assert.deepEqual(receipt.weights, {
      confidence: 0.25,
      authority: 0.15,
      corroboration: 0.15,
      typeRelevance: 0.1,
      temporalPersistence: 0.1,
      freshness: 0.1,
      centrality: 0.1,
      explicitConfirmationCorrection: 0.05,
    });
    assert.equal(receipt.inputs.provenanceMode, 'candidate_records');
    assert.deepEqual(receipt.inputs.entityDegrees, [{ entityId: 'entity:nacre', degree: 4 }]);
    assert.deepEqual(receipt.gates, { validity: 1, provenance: 1 });
    assert.equal(receipt.components.confidence, 1);
    assert.equal(receipt.components.authority, 1);
    assert.equal(receipt.components.typeRelevance, 1);
    assert.ok(receipt.rawScore >= 0 && receipt.rawScore <= 1);
    assert.equal(receipt.score, Number(receipt.rawScore.toFixed(6)));
    assert.equal(receipt.tieBreak, receipt.memoryId);
    assert.deepEqual(receipt.reasons, []);
    assert.deepEqual(
      evaluateMemorySalience(memory(), {
        evaluatedAt: AT,
        entityDegrees: { 'entity:nacre': 4 },
      }),
      receipt,
    );
  });

  it('excludes future candidate records from every time-derived support component', () => {
    const present = candidate();
    const future = candidate({
      id: 'mem_222222222222',
      sourceAuthority: 'direct_user',
      trust: 99,
      eventTime: '2026-08-01T10:00:00.000Z',
      proposedAt: '2026-08-01T10:00:00.000Z',
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
      evidence: [
        {
          sourceRef: 'synthetic:future',
          messageId: 'future-message',
          span: { start: 0, end: 42, text: 'We decided to keep salience deterministic.' },
        },
      ],
    });
    const baseline = evaluateMemorySalience(memory({ candidateRecords: [present] }), {
      evaluatedAt: AT,
    });
    const withFuture = evaluateMemorySalience(
      memory({ candidateIds: [present.id, future.id], candidateRecords: [present, future] }),
      { evaluatedAt: AT },
    );

    assert.deepEqual(withFuture.inputs.supports, baseline.inputs.supports);
    assert.deepEqual(withFuture.components, baseline.components);
    assert.equal(withFuture.rawScore, baseline.rawScore);
  });

  it('ranks direct-user support above assistant inference and breaks exact ties by memory id', () => {
    const direct = memory();
    const assistantId = 'mem_bbbbbbbbbbbb';
    const assistantSupport = candidate({
      id: 'mem_333333333333',
      sourceAuthority: 'assistant_inference',
      resolvedMemoryId: assistantId,
    });
    const assistant = memory({
      id: assistantId,
      candidateIds: [assistantSupport.id],
      candidateRecords: [assistantSupport],
    });
    const tieId = 'mem_000000000000';
    const tieSupport = candidate({
      id: 'mem_444444444444',
      resolvedMemoryId: tieId,
    });
    const tie = memory({
      id: tieId,
      candidateIds: [tieSupport.id],
      candidateRecords: [tieSupport],
    });

    const ranked = rankMemorySalience([assistant, direct, tie], { evaluatedAt: AT });

    assert.equal(ranked[0].memoryId, tieId);
    assert.equal(ranked[1].memoryId, direct.id);
    assert.equal(ranked[2].memoryId, assistantId);
    assert.ok(ranked[1].score > ranked[2].score);
  });

  it('raises corroboration only for independent sourceRef plus messageId events', () => {
    const first = candidate();
    const replay = candidate({ id: 'mem_555555555555' });
    const independent = candidate({
      id: 'mem_666666666666',
      eventTime: '2026-07-20T10:00:00.000Z',
      proposedAt: '2026-07-20T10:00:00.000Z',
      createdAt: '2026-07-20T10:00:00.000Z',
      updatedAt: '2026-07-20T10:00:00.000Z',
      evidence: [
        {
          sourceRef: 'synthetic:session-2',
          messageId: 'message-2',
          span: { start: 0, end: 42, text: 'We decided to keep salience deterministic.' },
        },
      ],
    });
    const one = evaluateMemorySalience(memory({ candidateRecords: [first] }), { evaluatedAt: AT });
    const copied = evaluateMemorySalience(
      memory({ candidateIds: [first.id, replay.id], candidateRecords: [first, replay] }),
      { evaluatedAt: AT },
    );
    const corroborated = evaluateMemorySalience(
      memory({
        candidateIds: [first.id, independent.id],
        candidateRecords: [first, independent],
      }),
      {
        evaluatedAt: AT,
      },
    );

    assert.equal(copied.components.corroboration, one.components.corroboration);
    assert.equal(copied.components.confidence, one.components.confidence);
    assert.equal(corroborated.components.corroboration, 1 - Math.exp(-0.5));
    assert.ok(corroborated.rawScore > one.rawScore);
  });

  it('scores superseded beliefs inside their historical interval and gates them outside [validFrom, validUntil)', () => {
    const historical = memory({
      lifecycle: 'superseded',
      validFrom: '2026-07-01T10:00:00.000Z',
      validUntil: '2026-07-15T10:00:00.000Z',
      supersededBy: 'mem_bbbbbbbbbbbb',
    });
    const inside = evaluateMemorySalience(historical, {
      evaluatedAt: '2026-07-10T10:00:00.000Z',
    });
    const atExclusiveEnd = evaluateMemorySalience(historical, {
      evaluatedAt: '2026-07-15T10:00:00.000Z',
    });

    assert.equal(inside.gates.validity, 1);
    assert.ok(inside.score > 0);
    assert.equal(inside.components.explicitConfirmationCorrection, 0);
    assert.equal(atExclusiveEnd.gates.validity, 0);
    assert.equal(atExclusiveEnd.rawScore, 0);
    assert.equal(atExclusiveEnd.score, 0);
    assert.deepEqual(atExclusiveEnd.reasons, ['outside_validity_interval']);
  });

  it('does not leak future correction or confirmation metadata into historical salience', () => {
    const historical = memory({
      lifecycle: 'superseded',
      validFrom: '2026-07-01T10:00:00.000Z',
      validUntil: '2026-07-15T10:00:00.000Z',
      supersededBy: 'mem_bbbbbbbbbbbb',
      lastConfirmed: '2026-07-20',
    });

    const receipt = evaluateMemorySalience(historical, {
      evaluatedAt: '2026-07-10T10:00:00.000Z',
    });

    assert.equal(receipt.inputs.explicitCorrection, false);
    assert.equal(receipt.inputs.explicitConfirmation, false);
    assert.equal(receipt.components.explicitConfirmationCorrection, 0);
  });

  it('publishes the exact scoring formula in every receipt', () => {
    const receipt = evaluateMemorySalience(memory(), { evaluatedAt: AT });
    assert.equal(
      (receipt as unknown as { formula?: string }).formula,
      'sum(weight * component) * validity * provenance',
    );
  });

  it('fails candidate ownership and malformed validity metadata closed', () => {
    const wrongOwner = candidate({ resolvedMemoryId: 'mem_bbbbbbbbbbbb' });
    const mismatched = evaluateMemorySalience(memory({ candidateRecords: [wrongOwner] }), {
      evaluatedAt: AT,
    });
    const malformedValidity = evaluateMemorySalience(memory({ validFrom: 'not-a-time' }), {
      evaluatedAt: AT,
    });

    assert.equal(mismatched.score, 0);
    assert.deepEqual(mismatched.reasons, ['invalid_provenance']);
    assert.equal(malformedValidity.score, 0);
    assert.deepEqual(malformedValidity.reasons, ['invalid_validity_interval']);
  });

  it('decays only stateful claim and fact freshness from event time', () => {
    const staleSupport = candidate({
      id: 'mem_777777777777',
      type: 'fact',
      eventTime: '2025-07-01T10:00:00.000Z',
      proposedAt: '2025-07-01T10:00:00.000Z',
      createdAt: '2025-07-01T10:00:00.000Z',
      updatedAt: '2025-07-01T10:00:00.000Z',
    });
    const recentSupport = candidate({ id: 'mem_888888888888', type: 'fact' });
    const stale = evaluateMemorySalience(
      memory({ type: 'fact', candidateIds: [staleSupport.id], candidateRecords: [staleSupport] }),
      { evaluatedAt: AT },
    );
    const recent = evaluateMemorySalience(
      memory({ type: 'fact', candidateIds: [recentSupport.id], candidateRecords: [recentSupport] }),
      { evaluatedAt: AT },
    );
    const stable = evaluateMemorySalience(memory(), { evaluatedAt: AT });

    assert.ok(recent.components.freshness > stale.components.freshness);
    assert.ok(recent.rawScore > stale.rawScore);
    assert.equal(stable.components.freshness, 1);
    assert.equal(
      (recent.inputs as unknown as Record<string, unknown>).freshnessPolicy,
      'event_time_exponential_180d',
    );
    assert.equal(
      (stable.inputs as unknown as Record<string, unknown>).freshnessPolicy,
      'not_applicable',
    );
  });

  it('uses an explicit conservative legacy fallback without treating reinforcement as corroboration', () => {
    const legacy = memory({
      candidateIds: undefined,
      candidateRecords: undefined,
      independentEvidenceCount: undefined,
      confidenceInputs: undefined,
      confidence: 0.9,
      sources: ['synthetic:legacy-file'],
      sourceAuthority: 'direct_user',
      trust: 1,
      eventTime: '2026-07-01T10:00:00.000Z',
      salience: { reinforcementCount: 999, lastReinforced: '2026-07-22' },
    });

    const receipt = evaluateMemorySalience(legacy, { evaluatedAt: AT });

    assert.equal(receipt.inputs.provenanceMode, 'legacy_fallback');
    assert.equal(receipt.gates.provenance, 0.5);
    assert.equal(receipt.components.confidence, 0.45);
    assert.equal(receipt.components.corroboration, 0);
    assert.ok(receipt.score > 0);
    assert.deepEqual(receipt.reasons, ['legacy_provenance_fallback']);
  });

  it('rejects malformed evaluation time and fails malformed centrality or provenance closed at score zero', () => {
    assert.throws(
      () => evaluateMemorySalience(memory(), { evaluatedAt: '2026-07-23' }),
      /strict ISO timestamp/,
    );

    const badCentrality = evaluateMemorySalience(memory(), {
      evaluatedAt: AT,
      entityDegrees: { 'entity:nacre': -1 },
    });
    const badSupport = candidate({ trust: -1 });
    const badProvenance = evaluateMemorySalience(memory({ candidateRecords: [badSupport] }), {
      evaluatedAt: AT,
    });

    assert.equal(badCentrality.score, 0);
    assert.equal(badCentrality.gates.provenance, 0);
    assert.deepEqual(badCentrality.reasons, ['invalid_centrality_input']);
    assert.equal(badProvenance.score, 0);
    assert.equal(badProvenance.gates.provenance, 0);
    assert.deepEqual(badProvenance.reasons, ['invalid_provenance']);
    for (const value of Object.values(badCentrality.components) as number[]) {
      assert.ok(value >= 0 && value <= 1);
    }
  });

  it('computes fixed unique-neighbor graph degree independent of edge order or replay', () => {
    const edge = (id: string, source: string, target: string): MemoryEdge => ({
      id,
      source,
      target,
      type: 'explicit',
      directed: false,
      weight: 1,
      baseWeight: 1,
      reinforcementCount: 0,
      firstFormed: '2026-07-01',
      lastReinforced: '2026-07-01',
      stability: 1,
      evidence: [],
    });
    const edges = [
      edge('edge-2', 'entity:nacre', 'entity:typescript'),
      edge('edge-1', 'mem_aaaaaaaaaaaa', 'entity:nacre'),
      edge('edge-replay', 'entity:typescript', 'entity:nacre'),
    ];

    const forward = computeDeterministicEntityDegrees(edges);
    const reversed = computeDeterministicEntityDegrees([...edges].reverse());

    assert.deepEqual(forward, {
      'entity:nacre': 2,
      'entity:typescript': 1,
      mem_aaaaaaaaaaaa: 1,
    });
    assert.deepEqual(reversed, forward);
    const receipt = evaluateMemorySalience(memory(), {
      evaluatedAt: AT,
      entityDegrees: forward,
    });
    assert.equal(receipt.components.centrality, 1 - Math.exp(-2 / 4));
    assert.ok(receipt.components.centrality < 1);
  });

  it('reproduces identical receipts from canonical bytes and a freshly rebuilt graph without writes', () => {
    const root = mkdtempSync(join(tmpdir(), 'nacre-salience-rebuild-'));
    const relPath = 'projects/nacre/decisions/deterministic.md';
    const path = join(root, relPath);
    mkdirSync(join(root, 'projects', 'nacre', 'decisions'), { recursive: true });
    const value = memory({ body: 'We decided to keep [[Nacre]] salience deterministic.' });
    writeFileSync(path, serializeMemoryFile(value));
    const before = readFileSync(path, 'utf8');

    const evaluateFromFreshStore = () => {
      const store = SqliteStore.open(':memory:');
      const result = compileMemoryDir(store, root);
      assert.deepEqual(result.errors, []);
      const parsed = parseMemoryFile(readFileSync(path, 'utf8'), relPath).memory;
      const degrees = computeDeterministicEntityDegrees(store.listEdges());
      const receipt = evaluateMemorySalience(parsed, { evaluatedAt: AT, entityDegrees: degrees });
      store.close();
      return receipt;
    };

    assert.deepEqual(evaluateFromFreshStore(), evaluateFromFreshStore());
    assert.equal(readFileSync(path, 'utf8'), before);
    rmSync(root, { recursive: true, force: true });
  });

  it('does not let future ownership metadata invalidate an earlier historical receipt', () => {
    const present = candidate();
    const future = candidate({
      id: 'mem_212121212121',
      resolvedMemoryId: 'mem_bbbbbbbbbbbb',
      eventTime: '2026-08-01T10:00:00.000Z',
      evidence: [
        {
          sourceRef: 'synthetic:future-owner',
          messageId: 'future-owner',
          span: { start: 0, end: 10, text: 'future data' },
        },
      ],
    });
    const baseline = evaluateMemorySalience(memory(), { evaluatedAt: AT });
    const receipt = evaluateMemorySalience(
      memory({ candidateIds: [present.id, future.id], candidateRecords: [present, future] }),
      { evaluatedAt: AT },
    );
    assert.deepEqual(receipt, baseline);
  });

  it('uses an injective event tuple and rejects conflicting duplicate-event provenance', () => {
    const first = candidate({
      evidence: [{ sourceRef: 'a|b', messageId: 'c', span: { start: 0, end: 1, text: 'x' } }],
    });
    const distinct = candidate({
      id: 'mem_232323232323',
      evidence: [{ sourceRef: 'a', messageId: 'b|c', span: { start: 0, end: 1, text: 'x' } }],
    });
    const conflictingReplay = candidate({
      id: 'mem_242424242424',
      sourceAuthority: 'assistant_inference',
      evidence: first.evidence,
    });
    const distinctReceipt = evaluateMemorySalience(
      memory({ candidateIds: [first.id, distinct.id], candidateRecords: [first, distinct] }),
      { evaluatedAt: AT },
    );
    const conflictReceipt = evaluateMemorySalience(
      memory({
        candidateIds: [first.id, conflictingReplay.id],
        candidateRecords: [first, conflictingReplay],
      }),
      { evaluatedAt: AT },
    );
    assert.equal(distinctReceipt.inputs.supports.length, 2);
    assert.equal(conflictReceipt.score, 0);
    assert.deepEqual(conflictReceipt.reasons, ['invalid_provenance']);
  });

  it('ignores zero-trust events and never lowers salience for weak independent support', () => {
    const strong = candidate();
    const zeroTrust = candidate({
      id: 'mem_252525252525',
      trust: 0,
      evidence: [
        { sourceRef: 'synthetic:zero', messageId: 'zero', span: { start: 0, end: 1, text: 'x' } },
      ],
    });
    const weak = candidate({
      id: 'mem_262626262626',
      sourceAuthority: 'assistant_inference',
      trust: 0.1,
      eventTime: '2026-07-02T10:00:00.000Z',
      proposedAt: '2026-07-02T10:00:00.000Z',
      createdAt: '2026-07-02T10:00:00.000Z',
      updatedAt: '2026-07-02T10:00:00.000Z',
      evidence: [
        { sourceRef: 'synthetic:weak', messageId: 'weak', span: { start: 0, end: 1, text: 'x' } },
      ],
    });
    const baseline = evaluateMemorySalience(memory(), { evaluatedAt: AT });
    const withZero = evaluateMemorySalience(
      memory({ candidateIds: [strong.id, zeroTrust.id], candidateRecords: [strong, zeroTrust] }),
      { evaluatedAt: AT },
    );
    const withWeak = evaluateMemorySalience(
      memory({ candidateIds: [strong.id, weak.id], candidateRecords: [strong, weak] }),
      { evaluatedAt: AT },
    );
    assert.deepEqual(withZero, baseline);
    assert.equal(withWeak.gates.provenance, 1, JSON.stringify(withWeak));
    assert.ok(withWeak.rawScore >= baseline.rawScore);
    assert.equal(withWeak.components.authority, baseline.components.authority);
  });

  it('fails candidate id, scope, and type coherence closed', () => {
    const cases = [
      memory({ candidateIds: ['mem_ffffffffffff'] }),
      memory({ candidateRecords: [candidate({ scope: 'agent' })] }),
      memory({ candidateRecords: [candidate({ type: 'fact' })] }),
    ];
    for (const value of cases) {
      const receipt = evaluateMemorySalience(value, { evaluatedAt: AT });
      assert.equal(receipt.score, 0);
      assert.deepEqual(receipt.reasons, ['invalid_provenance']);
    }
  });

  it('fails future or malformed legacy provenance closed with bounded finite components', () => {
    const future = evaluateMemorySalience(
      memory({
        candidateIds: undefined,
        candidateRecords: undefined,
        eventTime: '2026-08-01T10:00:00.000Z',
      }),
      { evaluatedAt: AT },
    );
    assert.equal(future.score, 0);
    assert.deepEqual(future.reasons, ['provenance_gate_failed']);

    const cases = [
      memory({ candidateIds: undefined, candidateRecords: undefined, confidence: Number.NaN }),
      memory({ candidateIds: undefined, candidateRecords: undefined, trust: 2 }),
    ];
    for (const value of cases) {
      const receipt = evaluateMemorySalience(value, { evaluatedAt: AT });
      assert.equal(receipt.score, 0);
      assert.deepEqual(receipt.reasons, ['invalid_provenance']);
      for (const component of Object.values(receipt.components)) {
        assert.ok(Number.isFinite(component));
        assert.ok(component >= 0 && component <= 1);
      }
      assert.ok(Number.isFinite(receipt.rawScore));
    }
  });
});
