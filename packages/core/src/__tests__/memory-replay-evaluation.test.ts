import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { ConversationInput } from '../types.js';
import { SqliteStore } from '../store.js';
import { listMemoryFiles } from '../memory-compile.js';
import { resolveMemoryCandidate } from '../memory-consolidate.js';
import { extractMemoryCandidates } from '../memory-extraction.js';
import { parseMemoryFile, type MemoryObject } from '../memory-file.js';
import { admitWorkingMemory } from '../memory-admission.js';
import { computeReplayReportId, evaluateReplayCorpus } from '../memory-replay-evaluation.js';

const AT = '2026-07-23T12:00:00.000Z';

function memory(id: string, overrides: Partial<MemoryObject> = {}): MemoryObject {
  return {
    id,
    type: 'decision',
    scope: 'user',
    confidence: 0.9,
    sensitivity: 'low',
    created: '2026-07-01',
    lastConfirmed: '2026-07-01',
    lifecycle: 'active',
    validFrom: '2026-07-01T00:00:00.000Z',
    sources: [`synthetic:${id}`],
    sourceAuthority: 'direct_user',
    trust: 1,
    eventTime: '2026-07-01T00:00:00.000Z',
    salience: { reinforcementCount: 0 },
    body: `Memory ${id}`,
    ...overrides,
  };
}

describe('deterministic memory replay evaluation', () => {
  it('scores one admitted replay probe with deterministic quality and token metrics', () => {
    const relevant = memory('mem_111111111111');
    const unsupported = memory('mem_222222222222', {
      confidence: 0.1,
      trust: 0.1,
      body: 'Unsupported low-confidence noise.',
    });
    const forbidden = memory('mem_333333333333', {
      lifecycle: 'superseded',
      validUntil: '2026-07-10T00:00:00.000Z',
      body: 'Stale superseded decision.',
    });
    const receipt = admitWorkingMemory(
      [
        { memory: relevant, claim: 'Use deterministic replay evaluation.' },
        { memory: unsupported, claim: unsupported.body },
        { memory: forbidden, claim: forbidden.body },
      ],
      { kind: 'brief', evaluatedAt: AT },
    );

    const report = evaluateReplayCorpus({
      version: 'nacre.replay-corpus.v1',
      id: 'synthetic-one-probe',
      probes: [
        {
          id: 'current-brief',
          receipt,
          candidateSet: 'complete_canonical' as const,
          expectedRelevantMemoryIds: [relevant.id],
          forbiddenMemoryIds: [forbidden.id],
        },
      ],
    });

    assert.equal(report.version, 'nacre.replay-evaluation.v1');
    assert.equal(report.corpusId, 'synthetic-one-probe');
    assert.match(report.reportId, /^replay_[a-f0-9]{64}$/);
    const { reportId, ...reportContent } = report;
    assert.equal(reportId, computeReplayReportId(reportContent));
    assert.equal(report.passed, true);
    assert.deepEqual(report.probes[0].metrics, {
      candidatePrecisionAtK: 1,
      candidateRecallAtK: 1,
      candidateNdcgAtK: 1,
      admissionPrecision: 1,
      admissionRecall: 1,
      unsupportedIncluded: 0,
      forbiddenLeakage: 0,
      provenanceCompleteness: 1,
      contextTokens: receipt.budget.usedTokens,
    });
    assert.equal(report.probes[0].receiptId, receipt.id);
    assert.equal(report.probes[0].candidateSet, 'complete_canonical');
    assert.deepEqual(report.probes[0].expectedRelevantMemoryIds, [relevant.id]);
    assert.deepEqual(report.probes[0].forbiddenMemoryIds, [forbidden.id]);
    assert.deepEqual(
      report.probes[0].rankedCandidateMemoryIds,
      receipt.candidates.map((c) => c.memoryId),
    );
    assert.deepEqual(report.probes[0].includedMemoryIds, receipt.included);
    assert.deepEqual(report.probes[0].attributionEvents, []);
    assert.deepEqual(report.probes[0].gateViolations, []);
    assert.deepEqual(report.summary, {
      probeCount: 1,
      passedProbes: 1,
      meanCandidatePrecisionAtK: 1,
      meanCandidateRecallAtK: 1,
      meanCandidateNdcgAtK: 1,
      meanAdmissionPrecision: 1,
      meanAdmissionRecall: 1,
      totalUnsupportedIncluded: 0,
      totalForbiddenLeakage: 0,
      meanProvenanceCompleteness: 1,
      totalContextTokens: receipt.budget.usedTokens,
      stageCoverage: {
        extraction: false,
        storage: true,
        retrieval: false,
        admission: true,
        use: true,
      },
      attributionEventsByStage: {
        extraction: null,
        storage: 0,
        retrieval: null,
        admission: 0,
        use: 0,
      },
    });
  });

  it('fails closed and attributes missing, rejected, unsupported, and forbidden outcomes by stage', () => {
    const expectedRejected = memory('mem_444444444444', {
      confidence: 0.1,
      trust: 0.1,
      body: 'Expected but below threshold.',
    });
    const forbidden = memory('mem_555555555555', { body: 'Forbidden stale value leaked.' });
    const unsupported = memory('mem_666666666666', { body: 'Unsupported value included.' });
    const receipt = admitWorkingMemory(
      [
        { memory: expectedRejected, claim: expectedRejected.body },
        { memory: forbidden, claim: forbidden.body },
        { memory: unsupported, claim: unsupported.body },
      ],
      { kind: 'brief', evaluatedAt: AT },
    );

    const report = evaluateReplayCorpus({
      version: 'nacre.replay-corpus.v1',
      id: 'synthetic-failing-probe',
      probes: [
        {
          id: 'failure-attribution',
          receipt,
          candidateSet: 'complete_canonical' as const,
          expectedRelevantMemoryIds: ['mem_444444444444', 'mem_777777777777'],
          forbiddenMemoryIds: [forbidden.id],
        },
      ],
    });

    assert.equal(report.passed, false);
    assert.deepEqual(report.probes[0].attributionEvents, [
      { stage: 'admission', memoryId: expectedRejected.id, reason: 'expected_rejected' },
      { stage: 'storage', memoryId: 'mem_777777777777', reason: 'expected_not_stored' },
      { stage: 'use', memoryId: forbidden.id, reason: 'forbidden_included' },
      { stage: 'use', memoryId: unsupported.id, reason: 'unsupported_included' },
    ]);
    assert.deepEqual(report.summary.attributionEventsByStage, {
      extraction: null,
      storage: 1,
      retrieval: null,
      admission: 1,
      use: 2,
    });
    assert.equal(report.probes[0].metrics.unsupportedIncluded, 1);
    assert.equal(report.probes[0].metrics.forbiddenLeakage, 1);
    assert.deepEqual(
      report.probes[0].gateViolations.map((violation) => violation.metric),
      [
        'candidatePrecisionAtK',
        'candidateRecallAtK',
        'candidateNdcgAtK',
        'admissionPrecision',
        'admissionRecall',
        'unsupportedIncluded',
        'forbiddenLeakage',
      ],
    );
  });

  it('uses the declared k denominator and rejects ambiguous empty relevance oracles', () => {
    const relevant = memory('mem_888888888888');
    const receipt = admitWorkingMemory([{ memory: relevant, claim: relevant.body }], {
      kind: 'brief',
      evaluatedAt: AT,
    });
    const base = {
      version: 'nacre.replay-corpus.v1' as const,
      id: 'bounded-ranking',
      probes: [
        {
          id: 'two-expected-one-candidate',
          receipt,
          candidateSet: 'complete_canonical' as const,
          expectedRelevantMemoryIds: [relevant.id, 'mem_999999999999'],
          forbiddenMemoryIds: [],
        },
      ],
    };

    const report = evaluateReplayCorpus(base);
    assert.equal(report.probes[0].metrics.candidatePrecisionAtK, 0.5);
    assert.equal(report.probes[0].metrics.candidateRecallAtK, 0.5);

    assert.throws(
      () =>
        evaluateReplayCorpus({
          ...base,
          probes: [{ ...base.probes[0], expectedRelevantMemoryIds: [] }],
        }),
      /at least one expected relevant/i,
    );
  });

  it('separates raw attribution events from threshold gate violations', () => {
    const relevant = memory('mem_aaaaaaaaaaab');
    const allowedForbidden = memory('mem_bbbbbbbbbbbb');
    const receipt = admitWorkingMemory(
      [
        { memory: relevant, claim: relevant.body },
        { memory: allowedForbidden, claim: allowedForbidden.body },
      ],
      { kind: 'brief', evaluatedAt: AT },
    );
    const report = evaluateReplayCorpus({
      version: 'nacre.replay-corpus.v1',
      id: 'relaxed-forbidden-gate',
      thresholds: { maxForbiddenLeakage: 1, minAdmissionPrecision: 0.5 },
      probes: [
        {
          id: 'allowed-observation',
          receipt,
          candidateSet: 'complete_canonical' as const,
          expectedRelevantMemoryIds: [relevant.id],
          forbiddenMemoryIds: [allowedForbidden.id],
        },
      ],
    });

    assert.equal(report.passed, true);
    assert.deepEqual(report.probes[0].gateViolations, []);
    assert.deepEqual(report.probes[0].attributionEvents, [
      { stage: 'use', memoryId: allowedForbidden.id, reason: 'forbidden_included' },
    ]);
  });

  it('bounds and exact-validates the public runtime corpus shape', () => {
    const relevant = memory('mem_abababababab');
    const receipt = admitWorkingMemory([{ memory: relevant, claim: relevant.body }], {
      kind: 'brief',
      evaluatedAt: AT,
    });
    const probe = {
      id: 'bounded',
      receipt,
      candidateSet: 'complete_canonical' as const,
      expectedRelevantMemoryIds: [relevant.id],
      forbiddenMemoryIds: [],
    };
    const base = {
      version: 'nacre.replay-corpus.v1' as const,
      id: 'bounded-corpus',
      probes: [probe],
    };

    assert.throws(() => evaluateReplayCorpus({ ...base, id: 'x'.repeat(257) }), /256 bytes/i);
    assert.throws(
      () => evaluateReplayCorpus({ ...base, probes: Array.from({ length: 1_001 }, () => probe) }),
      /at most 1000 probes/i,
    );
    assert.throws(
      () => evaluateReplayCorpus({ ...base, unknown: true } as never),
      /corpus.*invalid shape/i,
    );
    assert.throws(
      () =>
        evaluateReplayCorpus({
          ...base,
          probes: [{ ...probe, unknown: true } as never],
        }),
      /probe.*invalid shape/i,
    );
    assert.throws(
      () => evaluateReplayCorpus({ ...base, thresholds: [] as never }),
      /thresholds.*invalid shape/i,
    );
    const recallReceipt = admitWorkingMemory(
      [{ memory: relevant, claim: relevant.body, retrievalRelevance: 1 }],
      { kind: 'recall', query: 'relevant', evaluatedAt: AT },
    );
    assert.throws(
      () =>
        evaluateReplayCorpus({
          ...base,
          probes: [{ ...probe, receipt: recallReceipt }],
        }),
      /brief receipt/i,
    );
  });

  it('reproduces the full extraction, correction, admission, and report lifecycle across fresh roots', () => {
    const runLifecycle = () => {
      const root = mkdtempSync(join(tmpdir(), 'nacre-replay-e2e-'));
      const store = SqliteStore.open(join(root, 'graph.db'));
      try {
        const history: ConversationInput = {
          metadata: { sessionId: 'lobstar-replay', sourceNamespace: 'synthetic', scope: 'user' },
          messages: [
            {
              id: 'old-direct',
              role: 'user',
              origin: 'direct',
              extractionEligible: true,
              content: 'Remember that Lobstar is not connected to Hermes.',
              timestamp: '2026-01-01T00:00:00.000Z',
              sourceRef: 'synthetic:lobstar-replay#message:old-direct',
            },
            {
              id: 'old-copy',
              role: 'user',
              origin: 'quoted_context',
              extractionEligible: false,
              content: 'Remember that Lobstar is not connected to Hermes.',
              timestamp: '2026-01-15T00:00:00.000Z',
              sourceRef: 'synthetic:lobstar-replay#message:old-copy',
            },
            {
              id: 'correction-direct',
              role: 'user',
              origin: 'direct',
              extractionEligible: true,
              content: 'Correction: Lobstar is connected to Hermes.',
              timestamp: '2026-02-01T00:00:00.000Z',
              sourceRef: 'synthetic:lobstar-replay#message:correction-direct',
            },
          ],
        };
        const extraction = extractMemoryCandidates(history, store, {
          memoryDir: root,
          now: '2026-03-01T00:00:00.000Z',
        });
        assert.deepEqual(
          { created: extraction.created, skipped: extraction.skipped },
          { created: 2, skipped: 1 },
        );
        const candidates = store.listMemoryCandidates();
        const oldCandidate = candidates.find((candidate) =>
          candidate.claim.startsWith('Remember that'),
        );
        const correctionCandidate = candidates.find((candidate) =>
          candidate.claim.startsWith('Correction:'),
        );
        assert.ok(oldCandidate);
        assert.ok(correctionCandidate);
        const resolvedAt = { now: '2026-03-01T00:00:00.000Z' };
        assert.equal(
          resolveMemoryCandidate(store, root, oldCandidate.id, resolvedAt).decision,
          'created',
        );
        assert.equal(
          resolveMemoryCandidate(store, root, correctionCandidate.id, resolvedAt).decision,
          'superseded',
        );

        const canonicalPaths = listMemoryFiles(root);
        const canonicalFiles = canonicalPaths.map((path) => [
          path,
          readFileSync(join(root, path), 'utf8'),
        ]);
        const canonical = canonicalPaths.map((path) => {
          const parsed = parseMemoryFile(readFileSync(join(root, path), 'utf8'), path);
          return { memory: parsed.memory, claim: parsed.claim };
        });
        const historicalReceipt = admitWorkingMemory(canonical, {
          kind: 'brief',
          evaluatedAt: '2026-01-15T00:00:00.000Z',
        });
        const currentReceipt = admitWorkingMemory(canonical, {
          kind: 'brief',
          evaluatedAt: '2026-03-01T00:00:00.000Z',
        });
        const report = evaluateReplayCorpus({
          version: 'nacre.replay-corpus.v1',
          id: 'synthetic-lobstar-history',
          probes: [
            {
              id: 'historical-before-correction',
              receipt: historicalReceipt,
              candidateSet: 'complete_canonical' as const,
              expectedRelevantMemoryIds: [oldCandidate.id],
              forbiddenMemoryIds: [correctionCandidate.id],
            },
            {
              id: 'current-after-correction',
              receipt: currentReceipt,
              candidateSet: 'complete_canonical' as const,
              expectedRelevantMemoryIds: [correctionCandidate.id],
              forbiddenMemoryIds: [oldCandidate.id],
            },
          ],
        });
        return {
          candidateIds: candidates.map((candidate) => candidate.id).sort(),
          resolvedCandidates: store.listMemoryCandidates().sort((a, b) => a.id.localeCompare(b.id)),
          canonicalFiles,
          historicalReceipt,
          currentReceipt,
          report,
        };
      } finally {
        store.close();
        rmSync(root, { recursive: true, force: true });
      }
    };

    const first = runLifecycle();
    const second = runLifecycle();
    assert.deepEqual(second, first);
    assert.equal(first.report.passed, true, JSON.stringify(first.report));
    assert.equal(first.report.summary.probeCount, 2);
    assert.equal(first.report.summary.totalForbiddenLeakage, 0);
    assert.equal(first.report.summary.meanProvenanceCompleteness, 1);
  });
});
