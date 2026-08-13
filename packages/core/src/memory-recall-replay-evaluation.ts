import { createHash } from 'node:crypto';
import type { AdmissionReceipt } from './memory-admission.js';
import { validateAdmissionReceipt } from './memory-admission.js';
import { DEFAULT_CONFIG, type GraphConfig } from './types.js';

export const RECALL_REPLAY_CORPUS_VERSION = 'nacre.recall-replay-corpus.v1' as const;
export const RECALL_REPLAY_REPORT_VERSION = 'nacre.recall-replay-report.v1' as const;

const MAX_PROBES = 1_000;
const MAX_IDS = 10_000;
const MAX_STRING_BYTES = 4_096;
const PINNED_HOPS = 2;
const PINNED_MIN_SCORE = 0;
const PINNED_WEIGHTS = { semantic: 0.4, graph: 0.3, recency: 0.2, importance: 0.1 } as const;
const MEMORY_ID = /^mem_[0-9a-f]{12}$/;
const RESULT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface RecallReplayThresholds {
  minRetrievalPrecisionAtK: number;
  minRetrievalRecallAtK: number;
  minRetrievalNdcgAtK: number;
  minAdmissionPrecision: number;
  minAdmissionRecall: number;
  minProvenanceCompleteness: number;
  maxForbiddenRetrievalLeakage: number;
  maxForbiddenAdmissionLeakage: number;
  maxContextTokens: number;
}

export const DEFAULT_RECALL_REPLAY_THRESHOLDS: Readonly<RecallReplayThresholds> = Object.freeze({
  minRetrievalPrecisionAtK: 1,
  minRetrievalRecallAtK: 1,
  minRetrievalNdcgAtK: 1,
  minAdmissionPrecision: 1,
  minAdmissionRecall: 1,
  minProvenanceCompleteness: 1,
  maxForbiddenRetrievalLeakage: 0,
  maxForbiddenAdmissionLeakage: 0,
  maxContextTokens: 2_000,
});

export interface RecallTraceResult {
  rank: number;
  nodeId: string;
  canonicalMemoryId: string | null;
  canonicalPath: string | null;
  score: number;
  scores: {
    semantic: number;
    graph: number;
    recency: number;
    importance: number;
  };
}

export interface RecallReplayProbeInput {
  id: string;
  query: string;
  evaluatedAt: string;
  expectedRelevantMemoryIds: string[];
  forbiddenRetrievalMemoryIds: string[];
  forbiddenAdmissionMemoryIds: string[];
  retrieval: {
    kind: 'nacre_hybrid_recall';
    limit: number;
    hops: number;
    minScore: number;
    scopes: string[];
    includeProcedures: false;
    graphConfig: GraphConfig;
    weights: {
      semantic: number;
      graph: number;
      recency: number;
      importance: number;
    };
    results: RecallTraceResult[];
  };
  admissionReceipt: AdmissionReceipt;
}

export interface RecallReplayCorpusInput {
  version: typeof RECALL_REPLAY_CORPUS_VERSION;
  id: string;
  candidateSet: 'complete_canonical';
  encoderFingerprint: string;
  canonicalMemoryIds: string[];
  probes: RecallReplayProbeInput[];
  thresholds?: Partial<RecallReplayThresholds>;
}

export type RecallReplayStage = 'storage' | 'retrieval' | 'admission' | 'use';

export interface RecallReplayAttributionEvent {
  stage: RecallReplayStage;
  memoryId: string;
  reason:
    | 'expected_memory_absent_from_complete_canonical_set'
    | 'canonical_graph_mapping_broken'
    | 'expected_memory_missing_from_top_k'
    | 'forbidden_memory_retrieved'
    | 'expected_memory_rejected_by_admission'
    | 'forbidden_memory_admitted'
    | 'unsupported_memory_admitted';
}

export interface RecallReplayGateViolation {
  metric: keyof RecallReplayProbeMetrics;
  actual: number;
  comparator: '>=' | '<=';
  threshold: number;
}

export interface RecallReplayProbeMetrics {
  retrievalPrecisionAtK: number;
  retrievalRecallAtK: number;
  retrievalNdcgAtK: number;
  admissionPrecision: number;
  admissionRecall: number;
  forbiddenRetrievalLeakage: number;
  forbiddenAdmissionLeakage: number;
  provenanceCompleteness: number;
  contextTokens: number;
}

export interface RecallReplayProbeReport {
  id: string;
  query: string;
  evaluatedAt: string;
  retrievalKind: 'nacre_hybrid_recall';
  retrievalLimit: number;
  admissionReceiptId: string;
  expectedRelevantMemoryIds: string[];
  forbiddenRetrievalMemoryIds: string[];
  forbiddenAdmissionMemoryIds: string[];
  rawRetrieval: RecallTraceResult[];
  rawRetrievalIds: string[];
  canonicalCandidateIds: string[];
  admittedIds: string[];
  metrics: RecallReplayProbeMetrics;
  attributionEvents: RecallReplayAttributionEvent[];
  gateViolations: RecallReplayGateViolation[];
  passed: boolean;
}

export interface RecallReplayReport {
  version: typeof RECALL_REPLAY_REPORT_VERSION;
  id: string;
  corpusId: string;
  corpusVersion: typeof RECALL_REPLAY_CORPUS_VERSION;
  encoderFingerprint: string;
  candidateSet: 'complete_canonical';
  canonicalMemoryIds: string[];
  thresholds: RecallReplayThresholds;
  stageCoverage: {
    extraction: false;
    storage: true;
    retrieval: true;
    admission: true;
    use: true;
  };
  probes: RecallReplayProbeReport[];
  summary: {
    probeCount: number;
    passedProbeCount: number;
    meanRetrievalPrecisionAtK: number;
    meanRetrievalRecallAtK: number;
    meanRetrievalNdcgAtK: number;
    meanAdmissionPrecision: number;
    meanAdmissionRecall: number;
    totalForbiddenRetrievalLeakage: number;
    totalForbiddenAdmissionLeakage: number;
    meanProvenanceCompleteness: number;
    totalContextTokens: number;
    attributionEventsByStage: {
      extraction: null;
      storage: number;
      retrieval: number;
      admission: number;
      use: number;
    };
    gateViolationCount: number;
  };
  passed: boolean;
}

function fail(message: string): never {
  throw new Error(`invalid recall replay corpus: ${message}`);
}

function exactObject(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    fail(`${label} must be an object`);
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record))
    if (!keys.includes(key)) fail(`${label} has unknown field: ${key}`);
  return record;
}

function boundedString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must be a nonempty string`);
  if (Buffer.byteLength(value, 'utf8') > MAX_STRING_BYTES) fail(`${label} is too large`);
  return value;
}

function strictIso(value: unknown, label: string): string {
  const text = boundedString(value, label);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== text)
    fail(`${label} must be strict ISO`);
  return text;
}

function sortedUniqueIds(value: unknown, label: string, memoryOnly = true): string[] {
  if (!Array.isArray(value) || value.length > MAX_IDS) fail(`${label} must be a bounded array`);
  const ids = value.map((item, index) => {
    const id = boundedString(item, `${label}[${index}]`);
    if (!(memoryOnly ? MEMORY_ID : RESULT_ID).test(id)) fail(`${label}[${index}] is invalid`);
    return id;
  });
  if (new Set(ids).size !== ids.length) fail(`${label} must not contain duplicates`);
  if (ids.some((id, index) => index > 0 && ids[index - 1].localeCompare(id) >= 0))
    fail(`${label} must be sorted`);
  return ids;
}

function finiteUnit(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)
    fail(`${label} must be finite in [0,1]`);
  return value;
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    fail(`${label} must be a nonnegative safe integer`);
  return value;
}

function validateThresholds(value: unknown): RecallReplayThresholds {
  if (value === undefined) return { ...DEFAULT_RECALL_REPLAY_THRESHOLDS };
  const keys = Object.keys(DEFAULT_RECALL_REPLAY_THRESHOLDS) as Array<keyof RecallReplayThresholds>;
  const record = exactObject(value, keys, 'thresholds');
  const merged = { ...DEFAULT_RECALL_REPLAY_THRESHOLDS };
  for (const key of keys) {
    if (!(key in record)) continue;
    merged[key] =
      key === 'maxContextTokens' || key.includes('Leakage')
        ? nonnegativeInteger(record[key], `thresholds.${key}`)
        : finiteUnit(record[key], `thresholds.${key}`);
  }
  return merged;
}

function validateInput(input: RecallReplayCorpusInput): RecallReplayCorpusInput {
  const top = exactObject(
    input,
    [
      'version',
      'id',
      'candidateSet',
      'encoderFingerprint',
      'canonicalMemoryIds',
      'probes',
      'thresholds',
    ],
    'corpus',
  );
  if (top.version !== RECALL_REPLAY_CORPUS_VERSION) fail('unsupported version');
  if (top.candidateSet !== 'complete_canonical') fail('candidateSet must be complete_canonical');
  boundedString(top.id, 'id');
  boundedString(top.encoderFingerprint, 'encoderFingerprint');
  const canonicalMemoryIds = sortedUniqueIds(top.canonicalMemoryIds, 'canonicalMemoryIds');
  if (canonicalMemoryIds.length === 0) fail('canonicalMemoryIds must not be empty');
  const canonicalMemoryIdSet = new Set(canonicalMemoryIds);
  if (!Array.isArray(top.probes) || top.probes.length === 0 || top.probes.length > MAX_PROBES)
    fail('probes must be a nonempty bounded array');

  const seenProbeIds = new Set<string>();
  for (const [probeIndex, rawProbe] of top.probes.entries()) {
    const label = `probes[${probeIndex}]`;
    const probe = exactObject(
      rawProbe,
      [
        'id',
        'query',
        'evaluatedAt',
        'expectedRelevantMemoryIds',
        'forbiddenRetrievalMemoryIds',
        'forbiddenAdmissionMemoryIds',
        'retrieval',
        'admissionReceipt',
      ],
      label,
    );
    const probeId = boundedString(probe.id, `${label}.id`);
    if (seenProbeIds.has(probeId)) fail('probe ids must be unique');
    seenProbeIds.add(probeId);
    const query = boundedString(probe.query, `${label}.query`);
    const evaluatedAt = strictIso(probe.evaluatedAt, `${label}.evaluatedAt`);
    const expected = sortedUniqueIds(
      probe.expectedRelevantMemoryIds,
      `${label}.expectedRelevantMemoryIds`,
    );
    if (expected.length === 0) fail(`${label}.expectedRelevantMemoryIds must not be empty`);
    const forbiddenRetrieval = sortedUniqueIds(
      probe.forbiddenRetrievalMemoryIds,
      `${label}.forbiddenRetrievalMemoryIds`,
    );
    const forbiddenAdmission = sortedUniqueIds(
      probe.forbiddenAdmissionMemoryIds,
      `${label}.forbiddenAdmissionMemoryIds`,
    );
    if (expected.some((id) => forbiddenRetrieval.includes(id) || forbiddenAdmission.includes(id)))
      fail(`${label} relevance and forbidden ids overlap`);

    const retrieval = exactObject(
      probe.retrieval,
      [
        'kind',
        'limit',
        'hops',
        'minScore',
        'scopes',
        'includeProcedures',
        'graphConfig',
        'weights',
        'results',
      ],
      `${label}.retrieval`,
    );
    if (retrieval.kind !== 'nacre_hybrid_recall') fail(`${label}.retrieval.kind is unsupported`);
    const limit = nonnegativeInteger(retrieval.limit, `${label}.retrieval.limit`);
    if (limit < 1 || limit > MAX_IDS) fail(`${label}.retrieval.limit is out of range`);
    const hops = nonnegativeInteger(retrieval.hops, `${label}.retrieval.hops`);
    if (hops !== PINNED_HOPS) fail(`${label}.retrieval.hops must equal ${PINNED_HOPS}`);
    if (typeof retrieval.minScore !== 'number' || !Number.isFinite(retrieval.minScore))
      fail(`${label}.retrieval.minScore must be finite`);
    if (retrieval.minScore !== PINNED_MIN_SCORE)
      fail(`${label}.retrieval.minScore must equal ${PINNED_MIN_SCORE}`);
    if (retrieval.includeProcedures !== false)
      fail(`${label}.retrieval.includeProcedures must be false`);
    const graphConfig = exactObject(
      retrieval.graphConfig,
      [
        'decayRate',
        'reinforcementBoost',
        'visibilityThreshold',
        'coOccurrenceThreshold',
        'baseWeights',
      ],
      `${label}.retrieval.graphConfig`,
    );
    const baseWeights = exactObject(
      graphConfig.baseWeights,
      ['explicit', 'coOccurrence', 'temporal', 'causal'],
      `${label}.retrieval.graphConfig.baseWeights`,
    );
    for (const key of [
      'decayRate',
      'reinforcementBoost',
      'visibilityThreshold',
      'coOccurrenceThreshold',
    ] as const) {
      if (graphConfig[key] !== DEFAULT_CONFIG[key])
        fail(`${label}.retrieval.graphConfig.${key} does not match the pinned configuration`);
    }
    for (const key of ['explicit', 'coOccurrence', 'temporal', 'causal'] as const) {
      if (baseWeights[key] !== DEFAULT_CONFIG.baseWeights[key])
        fail(
          `${label}.retrieval.graphConfig.baseWeights.${key} does not match the pinned configuration`,
        );
    }
    const scopes = sortedUniqueIds(retrieval.scopes, `${label}.retrieval.scopes`, false);
    if (scopes.length === 0) fail(`${label}.retrieval.scopes must not be empty`);
    const weights = exactObject(
      retrieval.weights,
      ['semantic', 'graph', 'recency', 'importance'],
      `${label}.retrieval.weights`,
    );
    const effectiveWeights = {
      semantic: finiteUnit(weights.semantic, `${label}.retrieval.weights.semantic`),
      graph: finiteUnit(weights.graph, `${label}.retrieval.weights.graph`),
      recency: finiteUnit(weights.recency, `${label}.retrieval.weights.recency`),
      importance: finiteUnit(weights.importance, `${label}.retrieval.weights.importance`),
    };
    const weightSum = Object.values(effectiveWeights).reduce((sum, value) => sum + value, 0);
    if (Math.abs(weightSum - 1) > 1e-12) fail(`${label}.retrieval.weights must sum to 1`);
    for (const key of Object.keys(PINNED_WEIGHTS) as Array<keyof typeof PINNED_WEIGHTS>) {
      if (effectiveWeights[key] !== PINNED_WEIGHTS[key])
        fail(`${label}.retrieval.weights.${key} does not match the pinned configuration`);
    }
    if (!Array.isArray(retrieval.results) || retrieval.results.length > limit)
      fail(`${label}.retrieval.results exceeds limit`);
    const seenResults = new Set<string>();
    let previous: RecallTraceResult | undefined;
    for (const [resultIndex, rawResult] of retrieval.results.entries()) {
      const result = exactObject(
        rawResult,
        ['rank', 'nodeId', 'canonicalMemoryId', 'canonicalPath', 'score', 'scores'],
        `${label}.retrieval.results[${resultIndex}]`,
      );
      if (!Number.isSafeInteger(result.rank) || result.rank !== resultIndex + 1)
        fail(`${label}.retrieval result rank is invalid`);
      const rank = result.rank as number;
      const nodeId = boundedString(
        result.nodeId,
        `${label}.retrieval.results[${resultIndex}].nodeId`,
      );
      if (!RESULT_ID.test(nodeId)) fail(`${label}.retrieval result node id is invalid`);
      if (seenResults.has(nodeId)) fail(`${label}.retrieval results contain duplicate node ids`);
      seenResults.add(nodeId);
      const canonicalMemoryId =
        result.canonicalMemoryId === null
          ? null
          : boundedString(
              result.canonicalMemoryId,
              `${label}.retrieval.results[${resultIndex}].canonicalMemoryId`,
            );
      if (canonicalMemoryId !== null && !MEMORY_ID.test(canonicalMemoryId))
        fail(`${label}.retrieval canonical memory id is invalid`);
      const canonicalPath =
        result.canonicalPath === null
          ? null
          : boundedString(
              result.canonicalPath,
              `${label}.retrieval.results[${resultIndex}].canonicalPath`,
            );
      if ((canonicalMemoryId === null) !== (canonicalPath === null))
        fail(`${label}.retrieval canonical mapping must be explicit`);
      if (
        canonicalMemoryId !== null &&
        (canonicalMemoryId !== nodeId || !canonicalMemoryIdSet.has(canonicalMemoryId))
      )
        fail(`${label}.retrieval canonical mapping is incoherent`);
      if (
        canonicalPath !== null &&
        (canonicalPath.startsWith('/') ||
          canonicalPath.split('/').includes('..') ||
          !canonicalPath.endsWith('.md'))
      )
        fail(`${label}.retrieval canonical path is invalid`);
      if (typeof result.score !== 'number' || !Number.isFinite(result.score))
        fail(`${label}.retrieval result score must be finite`);
      const scores = exactObject(
        result.scores,
        ['semantic', 'graph', 'recency', 'importance'],
        `${label}.retrieval.results[${resultIndex}].scores`,
      );
      const components = {
        semantic:
          typeof scores.semantic === 'number' && Number.isFinite(scores.semantic)
            ? scores.semantic
            : Number.NaN,
        graph: finiteUnit(scores.graph, `${label}.retrieval result graph score`),
        recency: finiteUnit(scores.recency, `${label}.retrieval result recency score`),
        importance: finiteUnit(scores.importance, `${label}.retrieval result importance score`),
      };
      if (!Number.isFinite(components.semantic))
        fail(`${label}.retrieval result semantic score must be finite`);
      const recomputed =
        effectiveWeights.semantic * components.semantic +
        effectiveWeights.graph * components.graph +
        effectiveWeights.recency * components.recency +
        effectiveWeights.importance * components.importance;
      if (Math.abs(recomputed - result.score) > 1e-12)
        fail(`${label}.retrieval result score disagrees with pinned weights`);
      const current = {
        rank,
        nodeId,
        canonicalMemoryId,
        canonicalPath,
        score: result.score,
        scores: components,
      };
      if (
        previous &&
        (current.score > previous.score ||
          (current.score === previous.score && previous.nodeId.localeCompare(current.nodeId) >= 0))
      )
        fail(`${label}.retrieval results are not deterministically ordered`);
      previous = current;
    }

    const receipt = validateAdmissionReceipt(probe.admissionReceipt);
    if (receipt.kind !== 'recall') fail(`${label}.admissionReceipt must be recall kind`);
    if (receipt.query !== query) fail(`${label}.query disagrees with admission receipt`);
    if (receipt.evaluatedAt !== evaluatedAt)
      fail(`${label}.evaluatedAt disagrees with admission receipt`);
    if (
      receipt.policy.scopes.length !== scopes.length ||
      receipt.policy.scopes.some((scope, index) => scope !== scopes[index])
    )
      fail(`${label}.retrieval scopes disagree with admission receipt`);
    const resultScoreById = new Map(
      (retrieval.results as RecallTraceResult[]).map((result) => [result.nodeId, result.score]),
    );
    const expectedCandidateIds = (retrieval.results as RecallTraceResult[])
      .filter((result) => result.canonicalMemoryId !== null)
      .map((result) => result.canonicalMemoryId as string);
    const receiptCandidateIds = receipt.candidates.map((candidate) => candidate.memoryId);
    const receiptCandidateSet = new Set(receiptCandidateIds);
    if (
      expectedCandidateIds.length !== receiptCandidateIds.length ||
      expectedCandidateIds.some((id) => !receiptCandidateSet.has(id))
    ) {
      fail(`${label}.admission candidates must equal the raw canonical retrieval result set`);
    }
    for (const candidate of receipt.candidates) {
      const score = resultScoreById.get(candidate.memoryId);
      if (score === undefined) fail(`${label}.admission candidate is absent from raw retrieval`);
      if (candidate.retrievalRelevance !== score)
        fail(`${label}.admission candidate relevance disagrees with raw retrieval`);
    }
  }
  validateThresholds(top.thresholds);
  return input;
}

function rankingMetrics(ranked: string[], relevant: Set<string>, limit: number) {
  const k = limit;
  const top = ranked.slice(0, k);
  const hits = top.filter((id) => relevant.has(id)).length;
  let dcg = 0;
  for (let index = 0; index < top.length; index++) {
    if (relevant.has(top[index])) dcg += 1 / Math.log2(index + 2);
  }
  let idcg = 0;
  for (let index = 0; index < Math.min(k, relevant.size); index++) {
    idcg += 1 / Math.log2(index + 2);
  }
  return {
    precision: hits / k,
    recall: hits / relevant.size,
    ndcg: idcg === 0 ? 0 : dcg / idcg,
  };
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

function collectGateViolations(
  metrics: RecallReplayProbeMetrics,
  thresholds: RecallReplayThresholds,
): RecallReplayGateViolation[] {
  const checks: Array<[keyof RecallReplayProbeMetrics, number, '>=' | '<=', number]> = [
    [
      'retrievalPrecisionAtK',
      metrics.retrievalPrecisionAtK,
      '>=',
      thresholds.minRetrievalPrecisionAtK,
    ],
    ['retrievalRecallAtK', metrics.retrievalRecallAtK, '>=', thresholds.minRetrievalRecallAtK],
    ['retrievalNdcgAtK', metrics.retrievalNdcgAtK, '>=', thresholds.minRetrievalNdcgAtK],
    ['admissionPrecision', metrics.admissionPrecision, '>=', thresholds.minAdmissionPrecision],
    ['admissionRecall', metrics.admissionRecall, '>=', thresholds.minAdmissionRecall],
    [
      'provenanceCompleteness',
      metrics.provenanceCompleteness,
      '>=',
      thresholds.minProvenanceCompleteness,
    ],
    [
      'forbiddenRetrievalLeakage',
      metrics.forbiddenRetrievalLeakage,
      '<=',
      thresholds.maxForbiddenRetrievalLeakage,
    ],
    [
      'forbiddenAdmissionLeakage',
      metrics.forbiddenAdmissionLeakage,
      '<=',
      thresholds.maxForbiddenAdmissionLeakage,
    ],
    ['contextTokens', metrics.contextTokens, '<=', thresholds.maxContextTokens],
  ];
  const violations: RecallReplayGateViolation[] = [];
  for (const [metric, actual, comparator, threshold] of checks) {
    const violated = comparator === '>=' ? actual < threshold : actual > threshold;
    if (violated) violations.push({ metric, actual, comparator, threshold });
  }
  return violations;
}

export function stableRecallReplayJson(value: unknown): string {
  const canonicalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonicalize);
    if (item && typeof item === 'object') {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, canonicalize(child)]),
      );
    }
    return item;
  };
  return JSON.stringify(canonicalize(value));
}

export function evaluateRecallReplayCorpus(input: RecallReplayCorpusInput): RecallReplayReport {
  validateInput(input);
  const thresholds = validateThresholds(input.thresholds);
  const canonical = new Set(input.canonicalMemoryIds);
  const probes: RecallReplayProbeReport[] = input.probes.map((probe) => {
    const receipt = validateAdmissionReceipt(probe.admissionReceipt);
    const expected = new Set(probe.expectedRelevantMemoryIds);
    const forbiddenRetrieval = new Set(probe.forbiddenRetrievalMemoryIds);
    const forbiddenAdmission = new Set(probe.forbiddenAdmissionMemoryIds);
    const rawRetrievalIds = probe.retrieval.results.map((result) => result.nodeId);
    const rankedCanonicalIds = probe.retrieval.results.map(
      (result) => result.canonicalMemoryId ?? `unmapped:${result.nodeId}`,
    );
    const retrievedCanonicalIds = probe.retrieval.results.flatMap((result) =>
      result.canonicalMemoryId === null ? [] : [result.canonicalMemoryId],
    );
    const canonicalCandidateIds = [...retrievedCanonicalIds];
    const admittedIds = [...receipt.included];
    const admitted = new Set(admittedIds);
    const ranking = rankingMetrics(rankedCanonicalIds, expected, probe.retrieval.limit);
    const admittedRelevant = admittedIds.filter((id) => expected.has(id)).length;
    const admittedForbidden = admittedIds.filter((id) => forbiddenAdmission.has(id)).length;
    const retrievedForbidden = probe.retrieval.results.filter((result) =>
      forbiddenRetrieval.has(result.canonicalMemoryId ?? result.nodeId),
    ).length;
    const includedCandidates = receipt.candidates.filter((candidate) =>
      admitted.has(candidate.memoryId),
    );
    const provenanceComplete = includedCandidates.filter(
      (candidate) => candidate.sourceRefs.length > 0,
    ).length;
    const metrics: RecallReplayProbeMetrics = {
      retrievalPrecisionAtK: ranking.precision,
      retrievalRecallAtK: ranking.recall,
      retrievalNdcgAtK: ranking.ndcg,
      admissionPrecision: ratio(admittedRelevant, admittedIds.length),
      admissionRecall: admittedRelevant / expected.size,
      forbiddenRetrievalLeakage: retrievedForbidden,
      forbiddenAdmissionLeakage: admittedForbidden,
      provenanceCompleteness: ratio(provenanceComplete, includedCandidates.length),
      contextTokens: receipt.budget.usedTokens,
    };

    const attributionEvents: RecallReplayAttributionEvent[] = [];
    const topK = new Set(rankedCanonicalIds.slice(0, probe.retrieval.limit));
    for (const id of probe.expectedRelevantMemoryIds) {
      if (!canonical.has(id)) {
        attributionEvents.push({
          stage: 'storage',
          memoryId: id,
          reason: 'expected_memory_absent_from_complete_canonical_set',
        });
      } else if (
        probe.retrieval.results.some(
          (result) => result.nodeId === id && result.canonicalMemoryId === null,
        )
      ) {
        attributionEvents.push({
          stage: 'storage',
          memoryId: id,
          reason: 'canonical_graph_mapping_broken',
        });
      } else if (!topK.has(id)) {
        attributionEvents.push({
          stage: 'retrieval',
          memoryId: id,
          reason: 'expected_memory_missing_from_top_k',
        });
      } else if (!admitted.has(id)) {
        attributionEvents.push({
          stage: 'admission',
          memoryId: id,
          reason: 'expected_memory_rejected_by_admission',
        });
      }
    }
    for (const id of probe.forbiddenRetrievalMemoryIds) {
      if (
        probe.retrieval.results.some((result) => (result.canonicalMemoryId ?? result.nodeId) === id)
      ) {
        attributionEvents.push({
          stage: 'retrieval',
          memoryId: id,
          reason: 'forbidden_memory_retrieved',
        });
      }
    }
    for (const id of probe.forbiddenAdmissionMemoryIds) {
      if (admitted.has(id)) {
        attributionEvents.push({ stage: 'use', memoryId: id, reason: 'forbidden_memory_admitted' });
      }
    }
    for (const id of admittedIds) {
      if (!expected.has(id) && !forbiddenAdmission.has(id)) {
        attributionEvents.push({
          stage: 'use',
          memoryId: id,
          reason: 'unsupported_memory_admitted',
        });
      }
    }
    const gateViolations = collectGateViolations(metrics, thresholds);
    return {
      id: probe.id,
      query: probe.query,
      evaluatedAt: probe.evaluatedAt,
      retrievalKind: probe.retrieval.kind,
      retrievalLimit: probe.retrieval.limit,
      admissionReceiptId: receipt.id,
      expectedRelevantMemoryIds: [...probe.expectedRelevantMemoryIds],
      forbiddenRetrievalMemoryIds: [...probe.forbiddenRetrievalMemoryIds],
      forbiddenAdmissionMemoryIds: [...probe.forbiddenAdmissionMemoryIds],
      rawRetrieval: probe.retrieval.results.map((result) => ({
        ...result,
        scores: { ...result.scores },
      })),
      rawRetrievalIds,
      canonicalCandidateIds,
      admittedIds,
      metrics,
      attributionEvents,
      gateViolations,
      passed: gateViolations.length === 0,
    };
  });

  const mean = (selector: (probe: RecallReplayProbeReport) => number) =>
    probes.reduce((sum, probe) => sum + selector(probe), 0) / probes.length;
  const eventsByStage = (stage: RecallReplayStage) =>
    probes.reduce(
      (count, probe) =>
        count + probe.attributionEvents.filter((event) => event.stage === stage).length,
      0,
    );
  const payload: Omit<RecallReplayReport, 'id'> = {
    version: RECALL_REPLAY_REPORT_VERSION,
    corpusId: input.id,
    corpusVersion: input.version,
    encoderFingerprint: input.encoderFingerprint,
    candidateSet: input.candidateSet,
    canonicalMemoryIds: [...input.canonicalMemoryIds],
    thresholds,
    stageCoverage: {
      extraction: false,
      storage: true,
      retrieval: true,
      admission: true,
      use: true,
    },
    probes,
    summary: {
      probeCount: probes.length,
      passedProbeCount: probes.filter((probe) => probe.passed).length,
      meanRetrievalPrecisionAtK: mean((probe) => probe.metrics.retrievalPrecisionAtK),
      meanRetrievalRecallAtK: mean((probe) => probe.metrics.retrievalRecallAtK),
      meanRetrievalNdcgAtK: mean((probe) => probe.metrics.retrievalNdcgAtK),
      meanAdmissionPrecision: mean((probe) => probe.metrics.admissionPrecision),
      meanAdmissionRecall: mean((probe) => probe.metrics.admissionRecall),
      totalForbiddenRetrievalLeakage: probes.reduce(
        (sum, probe) => sum + probe.metrics.forbiddenRetrievalLeakage,
        0,
      ),
      totalForbiddenAdmissionLeakage: probes.reduce(
        (sum, probe) => sum + probe.metrics.forbiddenAdmissionLeakage,
        0,
      ),
      meanProvenanceCompleteness: mean((probe) => probe.metrics.provenanceCompleteness),
      totalContextTokens: probes.reduce((sum, probe) => sum + probe.metrics.contextTokens, 0),
      attributionEventsByStage: {
        extraction: null,
        storage: eventsByStage('storage'),
        retrieval: eventsByStage('retrieval'),
        admission: eventsByStage('admission'),
        use: eventsByStage('use'),
      },
      gateViolationCount: probes.reduce((sum, probe) => sum + probe.gateViolations.length, 0),
    },
    passed: probes.every((probe) => probe.passed),
  };
  const id = `recall_replay_${createHash('sha256').update(stableRecallReplayJson(payload)).digest('hex')}`;
  return { ...payload, id };
}
