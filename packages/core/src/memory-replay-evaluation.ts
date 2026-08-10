import { createHash } from 'node:crypto';
import { validateAdmissionReceipt, type AdmissionReceipt } from './memory-admission.js';
import { isMemoryId } from './memory-file.js';

export const REPLAY_CORPUS_VERSION = 'nacre.replay-corpus.v1' as const;
export const REPLAY_EVALUATION_VERSION = 'nacre.replay-evaluation.v1' as const;
const MAX_REPLAY_PROBES = 1_000;
const MAX_REPLAY_IDS_PER_SET = 1_000;
const MAX_REPLAY_LABEL_BYTES = 256;

export type ReplayFailureStage = 'extraction' | 'storage' | 'retrieval' | 'admission' | 'use';

export interface ReplayEvaluationThresholds {
  minCandidatePrecisionAtK: number;
  minCandidateRecallAtK: number;
  minCandidateNdcgAtK: number;
  minAdmissionPrecision: number;
  minAdmissionRecall: number;
  minProvenanceCompleteness: number;
  maxUnsupportedIncluded: number;
  maxForbiddenLeakage: number;
  maxContextTokensPerProbe: number;
}

export const DEFAULT_REPLAY_EVALUATION_THRESHOLDS: Readonly<ReplayEvaluationThresholds> =
  Object.freeze({
    minCandidatePrecisionAtK: 1,
    minCandidateRecallAtK: 1,
    minCandidateNdcgAtK: 1,
    minAdmissionPrecision: 1,
    minAdmissionRecall: 1,
    minProvenanceCompleteness: 1,
    maxUnsupportedIncluded: 0,
    maxForbiddenLeakage: 0,
    maxContextTokensPerProbe: 2_000,
  });

export interface ReplayProbeInput {
  id: string;
  receipt: AdmissionReceipt;
  candidateSet: 'complete_canonical';
  expectedRelevantMemoryIds: string[];
  forbiddenMemoryIds: string[];
}

export interface ReplayCorpusInput {
  version: typeof REPLAY_CORPUS_VERSION;
  id: string;
  probes: ReplayProbeInput[];
  thresholds?: Partial<ReplayEvaluationThresholds>;
}

export interface ReplayProbeMetrics {
  candidatePrecisionAtK: number;
  candidateRecallAtK: number;
  candidateNdcgAtK: number;
  admissionPrecision: number;
  admissionRecall: number;
  unsupportedIncluded: number;
  forbiddenLeakage: number;
  provenanceCompleteness: number;
  contextTokens: number;
}

export interface ReplayAttributionEvent {
  stage: ReplayFailureStage;
  memoryId: string;
  reason:
    | 'expected_not_stored'
    | 'expected_rejected'
    | 'unsupported_included'
    | 'forbidden_included';
}

export interface ReplayGateViolation {
  metric: keyof ReplayProbeMetrics;
  actual: number;
  comparator: '>=' | '<=';
  threshold: number;
}

export interface ReplayProbeReport {
  id: string;
  receiptId: string;
  candidateSet: 'complete_canonical';
  evaluatedAt: string;
  expectedRelevantMemoryIds: string[];
  forbiddenMemoryIds: string[];
  rankedCandidateMemoryIds: string[];
  includedMemoryIds: string[];
  passed: boolean;
  metrics: ReplayProbeMetrics;
  attributionEvents: ReplayAttributionEvent[];
  gateViolations: ReplayGateViolation[];
}

export interface ReplayEvaluationReport {
  version: typeof REPLAY_EVALUATION_VERSION;
  reportId: string;
  corpusId: string;
  thresholds: ReplayEvaluationThresholds;
  passed: boolean;
  probes: ReplayProbeReport[];
  summary: {
    probeCount: number;
    passedProbes: number;
    meanCandidatePrecisionAtK: number;
    meanCandidateRecallAtK: number;
    meanCandidateNdcgAtK: number;
    meanAdmissionPrecision: number;
    meanAdmissionRecall: number;
    totalUnsupportedIncluded: number;
    totalForbiddenLeakage: number;
    meanProvenanceCompleteness: number;
    totalContextTokens: number;
    stageCoverage: Record<ReplayFailureStage, boolean>;
    attributionEventsByStage: Record<ReplayFailureStage, number | null>;
  };
}

type ReplayEvaluationReportContent = Omit<ReplayEvaluationReport, 'reportId'>;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export function stableReplayJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function computeReplayReportId(content: ReplayEvaluationReportContent): string {
  return `replay_${createHash('sha256').update(stableReplayJson(content)).digest('hex')}`;
}

function exactObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} has an invalid shape`);
  }
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !keys.includes(key)) || keys.some((key) => !allowed.has(key))) {
    throw new Error(`${label} has an invalid shape`);
  }
}

function validateLabel(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    Buffer.byteLength(value, 'utf8') > MAX_REPLAY_LABEL_BYTES
  ) {
    throw new Error(`${label} must be non-empty, trimmed, and at most 256 bytes`);
  }
}

function finiteUnit(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${field} must be a finite number in [0,1]`);
  }
}

function validateThresholds(value: ReplayEvaluationThresholds): void {
  for (const field of [
    'minCandidatePrecisionAtK',
    'minCandidateRecallAtK',
    'minCandidateNdcgAtK',
    'minAdmissionPrecision',
    'minAdmissionRecall',
    'minProvenanceCompleteness',
  ] as const) {
    finiteUnit(value[field], field);
  }
  for (const field of [
    'maxUnsupportedIncluded',
    'maxForbiddenLeakage',
    'maxContextTokensPerProbe',
  ] as const) {
    if (!Number.isSafeInteger(value[field]) || value[field] < 0) {
      throw new Error(`${field} must be a non-negative safe integer`);
    }
  }
}

function validateIds(ids: string[], field: string): string[] {
  if (!Array.isArray(ids)) throw new Error(`${field} must be an array`);
  if (ids.length > MAX_REPLAY_IDS_PER_SET) {
    throw new Error(`${field} must contain at most ${MAX_REPLAY_IDS_PER_SET} memory ids`);
  }
  const sorted = [...ids].sort();
  if (sorted.some((id) => !isMemoryId(id)))
    throw new Error(`${field} contains an invalid memory id`);
  if (new Set(sorted).size !== sorted.length)
    throw new Error(`${field} contains duplicate memory ids`);
  if (JSON.stringify(ids) !== JSON.stringify(sorted)) throw new Error(`${field} must be sorted`);
  return sorted;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

function ndcgAtK(ranked: string[], relevant: Set<string>, k: number): number {
  if (k === 0) return 1;
  let dcg = 0;
  for (let index = 0; index < Math.min(k, ranked.length); index++) {
    if (relevant.has(ranked[index])) dcg += 1 / Math.log2(index + 2);
  }
  let ideal = 0;
  for (let index = 0; index < Math.min(k, relevant.size); index++)
    ideal += 1 / Math.log2(index + 2);
  return ideal === 0 ? 1 : dcg / ideal;
}

function collectGateViolations(
  metrics: ReplayProbeMetrics,
  thresholds: ReplayEvaluationThresholds,
): ReplayGateViolation[] {
  const violations: ReplayGateViolation[] = [];
  const minimum = (metric: keyof ReplayProbeMetrics, threshold: number): void => {
    if (metrics[metric] < threshold) {
      violations.push({ metric, actual: metrics[metric], comparator: '>=', threshold });
    }
  };
  const maximum = (metric: keyof ReplayProbeMetrics, threshold: number): void => {
    if (metrics[metric] > threshold) {
      violations.push({ metric, actual: metrics[metric], comparator: '<=', threshold });
    }
  };
  minimum('candidatePrecisionAtK', thresholds.minCandidatePrecisionAtK);
  minimum('candidateRecallAtK', thresholds.minCandidateRecallAtK);
  minimum('candidateNdcgAtK', thresholds.minCandidateNdcgAtK);
  minimum('admissionPrecision', thresholds.minAdmissionPrecision);
  minimum('admissionRecall', thresholds.minAdmissionRecall);
  minimum('provenanceCompleteness', thresholds.minProvenanceCompleteness);
  maximum('unsupportedIncluded', thresholds.maxUnsupportedIncluded);
  maximum('forbiddenLeakage', thresholds.maxForbiddenLeakage);
  maximum('contextTokens', thresholds.maxContextTokensPerProbe);
  return violations;
}

function evaluateProbe(
  probe: ReplayProbeInput,
  thresholds: ReplayEvaluationThresholds,
): ReplayProbeReport {
  exactObject(
    probe,
    ['id', 'receipt', 'candidateSet', 'expectedRelevantMemoryIds', 'forbiddenMemoryIds'],
    [],
    'replay probe',
  );
  validateLabel(probe.id, 'probe id');
  if (probe.candidateSet !== 'complete_canonical') {
    throw new Error('replay probe candidateSet must be complete_canonical');
  }
  const receipt = validateAdmissionReceipt(probe.receipt);
  if (receipt.kind !== 'brief') {
    throw new Error('canonical replay probes require a brief receipt');
  }
  const expectedIds = validateIds(probe.expectedRelevantMemoryIds, 'expectedRelevantMemoryIds');
  if (expectedIds.length === 0) {
    throw new Error('replay probe requires at least one expected relevant memory');
  }
  const forbiddenIds = validateIds(probe.forbiddenMemoryIds, 'forbiddenMemoryIds');
  const overlap = expectedIds.find((id) => forbiddenIds.includes(id));
  if (overlap) throw new Error(`memory cannot be both relevant and forbidden: ${overlap}`);

  const relevant = new Set(expectedIds);
  const forbidden = new Set(forbiddenIds);
  const ranked = receipt.candidates.map((candidate) => candidate.memoryId);
  const included = new Set(receipt.included);
  const candidateById = new Map(
    receipt.candidates.map((candidate) => [candidate.memoryId, candidate]),
  );
  const k = expectedIds.length;
  const topK = ranked.slice(0, k);
  const topKRelevant = topK.filter((id) => relevant.has(id)).length;
  const admittedRelevant = receipt.included.filter((id) => relevant.has(id)).length;
  const unsupported = receipt.included.filter((id) => !relevant.has(id) && !forbidden.has(id));
  const leaked = receipt.included.filter((id) => forbidden.has(id));
  const includedCandidates = receipt.included.map((id) => candidateById.get(id));
  const completeProvenance = includedCandidates.filter(
    (candidate) => candidate && candidate.sourceRefs.length > 0,
  ).length;

  const metrics: ReplayProbeMetrics = {
    candidatePrecisionAtK: ratio(topKRelevant, k),
    candidateRecallAtK: ratio(topKRelevant, relevant.size),
    candidateNdcgAtK: ndcgAtK(ranked, relevant, k),
    admissionPrecision: ratio(admittedRelevant, receipt.included.length),
    admissionRecall: ratio(admittedRelevant, relevant.size),
    unsupportedIncluded: unsupported.length,
    forbiddenLeakage: leaked.length,
    provenanceCompleteness: ratio(completeProvenance, receipt.included.length),
    contextTokens: receipt.budget.usedTokens,
  };
  const gateViolations = collectGateViolations(metrics, thresholds);

  const attributionEvents: ReplayAttributionEvent[] = [];
  for (const memoryId of expectedIds) {
    if (!candidateById.has(memoryId)) {
      attributionEvents.push({ stage: 'storage', memoryId, reason: 'expected_not_stored' });
    } else if (!included.has(memoryId)) {
      attributionEvents.push({ stage: 'admission', memoryId, reason: 'expected_rejected' });
    }
  }
  for (const memoryId of unsupported) {
    attributionEvents.push({ stage: 'use', memoryId, reason: 'unsupported_included' });
  }
  for (const memoryId of leaked) {
    attributionEvents.push({ stage: 'use', memoryId, reason: 'forbidden_included' });
  }
  attributionEvents.sort(
    (a, b) =>
      a.stage.localeCompare(b.stage) ||
      a.memoryId.localeCompare(b.memoryId) ||
      a.reason.localeCompare(b.reason),
  );

  return {
    id: probe.id,
    receiptId: receipt.id,
    candidateSet: probe.candidateSet,
    evaluatedAt: receipt.evaluatedAt,
    expectedRelevantMemoryIds: expectedIds,
    forbiddenMemoryIds: forbiddenIds,
    rankedCandidateMemoryIds: ranked,
    includedMemoryIds: [...receipt.included],
    passed: gateViolations.length === 0,
    metrics,
    attributionEvents,
    gateViolations,
  };
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function evaluateReplayCorpus(input: ReplayCorpusInput): ReplayEvaluationReport {
  exactObject(input, ['version', 'id', 'probes'], ['thresholds'], 'replay corpus');
  if (!input || input.version !== REPLAY_CORPUS_VERSION) {
    throw new Error(`replay corpus version must be ${REPLAY_CORPUS_VERSION}`);
  }
  validateLabel(input.id, 'corpus id');
  if (!Array.isArray(input.probes) || input.probes.length === 0) {
    throw new Error('replay corpus requires at least one probe');
  }
  if (input.probes.length > MAX_REPLAY_PROBES) {
    throw new Error(`replay corpus supports at most ${MAX_REPLAY_PROBES} probes`);
  }
  const probeIds = input.probes.map((probe) => probe.id);
  if (new Set(probeIds).size !== probeIds.length)
    throw new Error('replay probe ids must be unique');
  if (input.thresholds !== undefined) {
    exactObject(
      input.thresholds,
      [],
      [
        'minCandidatePrecisionAtK',
        'minCandidateRecallAtK',
        'minCandidateNdcgAtK',
        'minAdmissionPrecision',
        'minAdmissionRecall',
        'minProvenanceCompleteness',
        'maxUnsupportedIncluded',
        'maxForbiddenLeakage',
        'maxContextTokensPerProbe',
      ],
      'replay thresholds',
    );
    const allowedThresholds = new Set([
      'minCandidatePrecisionAtK',
      'minCandidateRecallAtK',
      'minCandidateNdcgAtK',
      'minAdmissionPrecision',
      'minAdmissionRecall',
      'minProvenanceCompleteness',
      'maxUnsupportedIncluded',
      'maxForbiddenLeakage',
      'maxContextTokensPerProbe',
    ]);
    if (Object.keys(input.thresholds).some((key) => !allowedThresholds.has(key))) {
      throw new Error('replay thresholds have an invalid shape');
    }
  }
  const thresholds = { ...DEFAULT_REPLAY_EVALUATION_THRESHOLDS, ...input.thresholds };
  validateThresholds(thresholds);
  const probes = input.probes.map((probe) => evaluateProbe(probe, thresholds));
  const attributionEventsByStage: Record<ReplayFailureStage, number | null> = {
    extraction: null,
    storage: 0,
    retrieval: null,
    admission: 0,
    use: 0,
  };
  for (const probe of probes) {
    for (const event of probe.attributionEvents) {
      const count = attributionEventsByStage[event.stage];
      if (count !== null) attributionEventsByStage[event.stage] = count + 1;
    }
  }
  const content: ReplayEvaluationReportContent = {
    version: REPLAY_EVALUATION_VERSION,
    corpusId: input.id,
    thresholds,
    passed: probes.every((probe) => probe.passed),
    probes,
    summary: {
      probeCount: probes.length,
      passedProbes: probes.filter((probe) => probe.passed).length,
      meanCandidatePrecisionAtK: mean(probes.map((probe) => probe.metrics.candidatePrecisionAtK)),
      meanCandidateRecallAtK: mean(probes.map((probe) => probe.metrics.candidateRecallAtK)),
      meanCandidateNdcgAtK: mean(probes.map((probe) => probe.metrics.candidateNdcgAtK)),
      meanAdmissionPrecision: mean(probes.map((probe) => probe.metrics.admissionPrecision)),
      meanAdmissionRecall: mean(probes.map((probe) => probe.metrics.admissionRecall)),
      totalUnsupportedIncluded: probes.reduce(
        (sum, probe) => sum + probe.metrics.unsupportedIncluded,
        0,
      ),
      totalForbiddenLeakage: probes.reduce((sum, probe) => sum + probe.metrics.forbiddenLeakage, 0),
      meanProvenanceCompleteness: mean(probes.map((probe) => probe.metrics.provenanceCompleteness)),
      totalContextTokens: probes.reduce((sum, probe) => sum + probe.metrics.contextTokens, 0),
      stageCoverage: {
        extraction: false,
        storage: true,
        retrieval: false,
        admission: true,
        use: true,
      },
      attributionEventsByStage,
    },
  };
  return { ...content, reportId: computeReplayReportId(content) };
}
