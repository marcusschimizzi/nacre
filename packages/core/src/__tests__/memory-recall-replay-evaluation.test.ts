import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  admitWorkingMemory,
  DEFAULT_CONFIG,
  DEFAULT_RECALL_REPLAY_THRESHOLDS,
  evaluateRecallReplayCorpus,
  stableRecallReplayJson,
  type AdmissionReceipt,
  type MemoryObject,
  type RecallReplayCorpusInput,
} from '../index.js';

const AT = '2026-07-20T00:00:00.000Z';

function memory(id: string, body: string): MemoryObject {
  return {
    id,
    type: 'claim',
    scope: 'user',
    confidence: 0.95,
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
    body,
  };
}

const relevant = memory('mem_aaaaaaaaaaaa', 'Relevant current memory.');
const distractor = {
  ...memory('mem_bbbbbbbbbbbb', 'Unrelated restricted memory.'),
  sensitivity: 'sensitive' as const,
};
const forbidden = {
  ...memory('mem_cccccccccccc', 'Forbidden stale memory.'),
  sensitivity: 'sensitive' as const,
};

function receipt(candidates: Array<{ memory: MemoryObject; relevance: number }>): AdmissionReceipt {
  return admitWorkingMemory(
    candidates.map(({ memory: candidate, relevance }) => ({
      memory: candidate,
      claim: candidate.body,
      retrievalRelevance: relevance,
    })),
    {
      kind: 'recall',
      query: 'current preference',
      evaluatedAt: AT,
      policy: { scopes: ['user'], tokenBudget: 1000 },
    },
  );
}

function trace(candidate: MemoryObject, score: number) {
  return {
    rank: 0,
    nodeId: candidate.id,
    canonicalMemoryId: candidate.id,
    canonicalPath: `user/decisions/${candidate.id}.md`,
    score,
    scores: { semantic: score, graph: score, recency: score, importance: score },
  };
}

function retrieval(results: ReturnType<typeof trace>[]) {
  return {
    kind: 'nacre_hybrid_recall' as const,
    limit: Math.max(1, results.length),
    hops: 2,
    minScore: 0,
    scopes: ['user'],
    includeProcedures: false as const,
    graphConfig: DEFAULT_CONFIG,
    weights: { semantic: 0.4, graph: 0.3, recency: 0.2, importance: 0.1 },
    results: results.map((result, index) => ({ ...result, rank: index + 1 })),
  };
}

function corpus(overrides: Partial<RecallReplayCorpusInput> = {}): RecallReplayCorpusInput {
  const admissionReceipt = receipt([
    { memory: relevant, relevance: 0.9 },
    { memory: distractor, relevance: 0.2 },
  ]);
  return {
    version: 'nacre.recall-replay-corpus.v1',
    id: 'synthetic-recall',
    candidateSet: 'complete_canonical',
    encoderFingerprint: 'mock:64',
    canonicalMemoryIds: [relevant.id, distractor.id, forbidden.id],
    thresholds: {
      ...DEFAULT_RECALL_REPLAY_THRESHOLDS,
      minRetrievalPrecisionAtK: 0.5,
    },
    probes: [
      {
        id: 'current-preference',
        query: 'current preference',
        evaluatedAt: AT,
        expectedRelevantMemoryIds: [relevant.id],
        forbiddenRetrievalMemoryIds: [forbidden.id],
        forbiddenAdmissionMemoryIds: [distractor.id, forbidden.id],
        retrieval: retrieval([trace(relevant, 0.9), trace(distractor, 0.2)]),
        admissionReceipt,
      },
    ],
    ...overrides,
  };
}

describe('deterministic explicit-recall replay evaluation', () => {
  it('keeps raw retrieval and admission metrics separate in a content-addressed report', () => {
    const report = evaluateRecallReplayCorpus(corpus());
    assert.equal(report.passed, true);
    assert.deepEqual(report.stageCoverage, {
      extraction: false,
      storage: true,
      retrieval: true,
      admission: true,
      use: true,
    });
    assert.deepEqual(report.probes[0].rawRetrieval, [
      { ...trace(relevant, 0.9), rank: 1 },
      { ...trace(distractor, 0.2), rank: 2 },
    ]);
    assert.deepEqual(report.probes[0].rawRetrievalIds, [relevant.id, distractor.id]);
    assert.deepEqual(report.probes[0].canonicalCandidateIds, [relevant.id, distractor.id]);
    assert.deepEqual(report.probes[0].admittedIds, [relevant.id]);
    assert.deepEqual(report.probes[0].metrics, {
      retrievalPrecisionAtK: 0.5,
      retrievalRecallAtK: 1,
      retrievalNdcgAtK: 1,
      admissionPrecision: 1,
      admissionRecall: 1,
      forbiddenRetrievalLeakage: 0,
      forbiddenAdmissionLeakage: 0,
      provenanceCompleteness: 1,
      contextTokens: report.probes[0].metrics.contextTokens,
    });
    assert.equal(report.probes[0].gateViolations.length, 0);

    const { id: _id, ...payload } = report;
    const expectedId = `recall_replay_${createHash('sha256').update(stableRecallReplayJson(payload)).digest('hex')}`;
    assert.equal(report.id, expectedId);
    assert.equal(
      stableRecallReplayJson(evaluateRecallReplayCorpus(corpus())),
      stableRecallReplayJson(report),
    );
  });

  it('attributes retrieval leakage independently from admission and threshold gates', () => {
    const admissionReceipt = receipt([
      { memory: distractor, relevance: 0.95 },
      { memory: relevant, relevance: 0.8 },
      { memory: forbidden, relevance: 0.7 },
    ]);
    const report = evaluateRecallReplayCorpus(
      corpus({
        thresholds: {
          minRetrievalPrecisionAtK: 1,
          minRetrievalRecallAtK: 1,
          minRetrievalNdcgAtK: 1,
          minAdmissionPrecision: 1,
          minAdmissionRecall: 1,
          minProvenanceCompleteness: 1,
          maxForbiddenRetrievalLeakage: 0,
          maxForbiddenAdmissionLeakage: 0,
          maxContextTokens: 1000,
        },
        probes: [
          {
            id: 'leaky-retrieval',
            query: 'current preference',
            evaluatedAt: AT,
            expectedRelevantMemoryIds: [relevant.id],
            forbiddenRetrievalMemoryIds: [forbidden.id],
            forbiddenAdmissionMemoryIds: [forbidden.id],
            retrieval: retrieval([
              trace(distractor, 0.95),
              trace(relevant, 0.8),
              trace(forbidden, 0.7),
            ]),
            admissionReceipt,
          },
        ],
      }),
    );

    assert.equal(report.passed, false);
    assert.equal(report.probes[0].metrics.retrievalPrecisionAtK, 1 / 3);
    assert.equal(report.probes[0].metrics.retrievalRecallAtK, 1);
    assert.equal(report.probes[0].metrics.forbiddenRetrievalLeakage, 1);
    assert.equal(report.probes[0].metrics.forbiddenAdmissionLeakage, 0);
    assert.deepEqual(
      report.probes[0].attributionEvents.map((event) => [
        event.stage,
        event.memoryId,
        event.reason,
      ]),
      [['retrieval', forbidden.id, 'forbidden_memory_retrieved']],
    );
    assert.deepEqual(
      report.probes[0].gateViolations.map((violation) => violation.metric),
      ['retrievalPrecisionAtK', 'retrievalNdcgAtK', 'forbiddenRetrievalLeakage'],
    );
  });

  it('attributes an expected object absent from the attested canonical set to storage', () => {
    const report = evaluateRecallReplayCorpus(
      corpus({
        canonicalMemoryIds: [distractor.id, forbidden.id],
        probes: [
          {
            id: 'missing-canonical',
            query: 'current preference',
            evaluatedAt: AT,
            expectedRelevantMemoryIds: [relevant.id],
            forbiddenRetrievalMemoryIds: [forbidden.id],
            forbiddenAdmissionMemoryIds: [forbidden.id],
            retrieval: retrieval([]),
            admissionReceipt: receipt([]),
          },
        ],
      }),
    );
    assert.deepEqual(report.probes[0].attributionEvents[0], {
      stage: 'storage',
      memoryId: relevant.id,
      reason: 'expected_memory_absent_from_complete_canonical_set',
    });
  });

  it('accepts admission reranking of exact retrieval-score ties without rewriting raw order', () => {
    const lowSalience = { ...memory('mem_dddddddddddd', 'Low salience tie.'), confidence: 0.2 };
    const highSalience = {
      ...memory('mem_eeeeeeeeeeee', 'High salience tie.'),
      type: 'decision' as const,
    };
    const rerankedReceipt = receipt([
      { memory: lowSalience, relevance: 0.5 },
      { memory: highSalience, relevance: 0.5 },
    ]);
    assert.deepEqual(
      rerankedReceipt.candidates.map((candidate) => candidate.memoryId),
      [highSalience.id, lowSalience.id],
    );
    const report = evaluateRecallReplayCorpus({
      version: 'nacre.recall-replay-corpus.v1',
      id: 'tie-reranking',
      candidateSet: 'complete_canonical',
      encoderFingerprint: 'mock:64',
      canonicalMemoryIds: [lowSalience.id, highSalience.id],
      thresholds: {
        ...DEFAULT_RECALL_REPLAY_THRESHOLDS,
        minRetrievalPrecisionAtK: 0,
        minRetrievalRecallAtK: 0,
        minRetrievalNdcgAtK: 0,
        minAdmissionPrecision: 0,
        minAdmissionRecall: 0,
      },
      probes: [
        {
          id: 'tie',
          query: 'current preference',
          evaluatedAt: AT,
          expectedRelevantMemoryIds: [lowSalience.id],
          forbiddenRetrievalMemoryIds: [],
          forbiddenAdmissionMemoryIds: [],
          retrieval: retrieval([trace(lowSalience, 0.5), trace(highSalience, 0.5)]),
          admissionReceipt: rerankedReceipt,
        },
      ],
    });
    assert.deepEqual(report.probes[0]?.canonicalCandidateIds, [lowSalience.id, highSalience.id]);
  });

  it('counts an unmapped forbidden memory-shaped graph id as raw retrieval leakage', () => {
    const valid = corpus();
    const probe = valid.probes[0];
    const report = evaluateRecallReplayCorpus({
      ...valid,
      probes: [
        {
          ...probe,
          forbiddenRetrievalMemoryIds: [forbidden.id],
          retrieval: {
            ...probe.retrieval,
            limit: 3,
            results: [
              ...probe.retrieval.results,
              {
                ...trace(forbidden, 0.1),
                rank: 3,
                canonicalMemoryId: null,
                canonicalPath: null,
              },
            ],
          },
        },
      ],
    });
    assert.equal(report.probes[0]?.metrics.forbiddenRetrievalLeakage, 1);
    assert.ok(
      report.probes[0]?.attributionEvents.some(
        (event) => event.memoryId === forbidden.id && event.reason === 'forbidden_memory_retrieved',
      ),
    );
    assert.equal(report.passed, false);
  });

  it('fails closed on malformed or incoherent retrieval traces', () => {
    const valid = corpus();
    const probe = valid.probes[0];
    const invalid: unknown[] = [
      { ...valid, candidateSet: 'subset' },
      { ...valid, canonicalMemoryIds: [relevant.id, relevant.id] },
      { ...valid, extra: true },
      { ...valid, probes: [{ ...probe, expectedRelevantMemoryIds: [] }] },
      {
        ...valid,
        probes: [
          {
            ...probe,
            retrieval: {
              ...probe.retrieval,
              results: [
                { ...trace(relevant, 0.9), rank: 1 },
                { ...trace(relevant, 0.8), rank: 2 },
              ],
            },
          },
        ],
      },
      {
        ...valid,
        probes: [
          {
            ...probe,
            retrieval: {
              ...probe.retrieval,
              results: [{ ...trace(relevant, Number.NaN), rank: 1 }],
            },
          },
        ],
      },
      { ...valid, probes: [{ ...probe, query: 'receipt mismatch' }] },
      {
        ...valid,
        probes: [{ ...probe, retrieval: { ...probe.retrieval, hops: 1 } }],
      },
      {
        ...valid,
        probes: [
          {
            ...probe,
            retrieval: {
              ...probe.retrieval,
              graphConfig: { ...DEFAULT_CONFIG, visibilityThreshold: 0.99 },
            },
          },
        ],
      },
      {
        ...valid,
        probes: [
          {
            ...probe,
            retrieval: {
              ...probe.retrieval,
              weights: { semantic: 0.5, graph: 0.2, recency: 0.2, importance: 0.1 },
            },
          },
        ],
      },
      {
        ...valid,
        probes: [
          {
            ...probe,
            admissionReceipt: { ...probe.admissionReceipt, kind: 'brief' },
          },
        ],
      },
    ];

    for (const value of invalid) {
      assert.throws(() => evaluateRecallReplayCorpus(value as RecallReplayCorpusInput));
    }
  });
});
