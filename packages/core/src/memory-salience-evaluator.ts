import { beliefAuthority } from './memory-belief-confidence.js';
import { validateMemoryCandidate, type MemoryCandidate } from './memory-candidate.js';
import type { MemoryObject, MemoryObjectType } from './memory-file.js';
import type { MemoryEdge } from './types.js';

export const SALIENCE_RECEIPT_VERSION = 'nacre.salience.v1' as const;

export const SALIENCE_WEIGHTS = Object.freeze({
  confidence: 0.25,
  authority: 0.15,
  corroboration: 0.15,
  typeRelevance: 0.1,
  temporalPersistence: 0.1,
  freshness: 0.1,
  centrality: 0.1,
  explicitConfirmationCorrection: 0.05,
});

export interface SalienceEvaluationOptions {
  evaluatedAt: string;
  entityDegrees?: Readonly<Record<string, number>>;
}

export interface SalienceReceipt {
  version: typeof SALIENCE_RECEIPT_VERSION;
  formula: 'sum(weight * component) * validity * provenance';
  memoryId: string;
  evaluatedAt: string;
  inputs: {
    type: MemoryObjectType;
    lifecycle: MemoryObject['lifecycle'] | 'legacy_active';
    validFrom?: string;
    validUntil?: string;
    provenanceMode: 'candidate_records' | 'legacy_fallback';
    supports: Array<{
      sourceEventId: string;
      sourceAuthority: string;
      authority: number;
      trust: number;
      eventTime: string;
    }>;
    legacyFallback?: {
      confidence: number;
      sourceAuthority: string;
      authority: number;
      trust: number;
      eventTime?: string;
    };
    entityDegrees: Array<{ entityId: string; degree: number }>;
    explicitConfirmation: boolean;
    explicitCorrection: boolean;
    freshnessPolicy: 'event_time_exponential_180d' | 'not_applicable';
  };
  weights: typeof SALIENCE_WEIGHTS;
  components: {
    confidence: number;
    authority: number;
    corroboration: number;
    typeRelevance: number;
    temporalPersistence: number;
    freshness: number;
    centrality: number;
    explicitConfirmationCorrection: number;
  };
  gates: { validity: 0 | 1; provenance: 0 | 0.5 | 1 };
  reasons: string[];
  rawScore: number;
  score: number;
  tieBreak: string;
}

const TYPE_RELEVANCE: Record<MemoryObjectType, number> = {
  claim: 0.6,
  preference: 0.85,
  decision: 1,
  fact: 0.7,
  lesson: 0.9,
};

function strictIso(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

/** Fixed graph degree: count unique adjacent node ids, never normalize against the batch. */
export function computeDeterministicEntityDegrees(
  edges: readonly Pick<MemoryEdge, 'source' | 'target'>[],
): Record<string, number> {
  const neighbors = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!edge.source || !edge.target) throw new Error('graph edge endpoints must be non-empty');
    if (edge.source === edge.target) continue;
    if (!neighbors.has(edge.source)) neighbors.set(edge.source, new Set());
    if (!neighbors.has(edge.target)) neighbors.set(edge.target, new Set());
    neighbors.get(edge.source)?.add(edge.target);
    neighbors.get(edge.target)?.add(edge.source);
  }
  return Object.fromEntries(
    [...neighbors]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, adjacent]) => [id, adjacent.size]),
  );
}

function normalizedSupports(candidates: MemoryCandidate[], evaluatedAtMs: number) {
  const byEvent = new Map<
    string,
    {
      sourceEventId: string;
      sourceAuthority: string;
      authority: number;
      trust: number;
      eventTime: string;
    }
  >();
  for (const candidate of candidates) {
    if (!strictIso(candidate.eventTime)) {
      throw new Error('candidate eventTime must be a strict ISO timestamp');
    }
    if (Date.parse(candidate.eventTime) > evaluatedAtMs) continue;
    validateMemoryCandidate(candidate);
    for (const evidence of candidate.evidence) {
      const sourceEventId = JSON.stringify([evidence.sourceRef, evidence.messageId]);
      const support = {
        sourceEventId,
        sourceAuthority: candidate.sourceAuthority,
        authority: beliefAuthority(candidate.sourceAuthority),
        trust: candidate.trust,
        eventTime: candidate.eventTime,
      };
      if (support.authority * support.trust === 0) continue;
      const previous = byEvent.get(sourceEventId);
      if (
        previous &&
        (previous.sourceAuthority !== support.sourceAuthority ||
          previous.authority !== support.authority ||
          previous.trust !== support.trust ||
          previous.eventTime !== support.eventTime)
      ) {
        throw new Error('one source event has conflicting salience provenance');
      }
      byEvent.set(sourceEventId, support);
    }
  }
  return [...byEvent.values()].sort((a, b) => a.sourceEventId.localeCompare(b.sourceEventId));
}

export function rankMemorySalience(
  memories: readonly MemoryObject[],
  options: SalienceEvaluationOptions,
): SalienceReceipt[] {
  return memories
    .map((memory) => evaluateMemorySalience(memory, options))
    .sort((a, b) => b.rawScore - a.rawScore || a.tieBreak.localeCompare(b.tieBreak));
}

export function evaluateMemorySalience(
  memory: MemoryObject,
  options: SalienceEvaluationOptions,
): SalienceReceipt {
  if (!strictIso(options.evaluatedAt)) {
    throw new Error('evaluatedAt must be a strict ISO timestamp');
  }
  const evaluatedAtMs = Date.parse(options.evaluatedAt);
  let provenanceMalformed = false;
  let supports: SalienceReceipt['inputs']['supports'] = [];
  try {
    supports = normalizedSupports(memory.candidateRecords ?? [], evaluatedAtMs);
  } catch {
    provenanceMalformed = true;
  }
  const legacyMode = memory.candidateRecords === undefined;
  if (memory.candidateRecords) {
    const recordIds = memory.candidateRecords.map((candidate) => candidate.id).sort();
    const candidateIds = [...(memory.candidateIds ?? [])].sort();
    const coherentIds =
      recordIds.length === candidateIds.length &&
      recordIds.every((candidateId, index) => candidateId === candidateIds[index]);
    const eligibleOwnership = memory.candidateRecords
      .filter(
        (candidate) =>
          strictIso(candidate.eventTime) && Date.parse(candidate.eventTime) <= evaluatedAtMs,
      )
      .every(
        (candidate) =>
          candidate.lifecycle === 'promoted' &&
          candidate.resolvedMemoryId === memory.id &&
          candidate.scope === memory.scope &&
          candidate.type === memory.type,
      );
    if (!coherentIds || !eligibleOwnership) provenanceMalformed = true;
  }
  const legacyTrustInput = memory.trust ?? 0.5;
  const legacyMalformed =
    legacyMode &&
    (!Number.isFinite(memory.confidence) ||
      memory.confidence < 0 ||
      memory.confidence > 1 ||
      !Number.isFinite(legacyTrustInput) ||
      legacyTrustInput < 0 ||
      legacyTrustInput > 1 ||
      (memory.eventTime !== undefined && !strictIso(memory.eventTime)));
  if (legacyMalformed) provenanceMalformed = true;
  const legacyTrust = legacyMalformed ? 0 : legacyTrustInput;
  const legacyAuthority = legacyMalformed ? 0 : beliefAuthority(memory.sourceAuthority);
  const legacyEventTime =
    memory.eventTime && strictIso(memory.eventTime) && Date.parse(memory.eventTime) <= evaluatedAtMs
      ? memory.eventTime
      : undefined;
  const legacyFallback = legacyMode
    ? {
        confidence: legacyMalformed ? 0 : Math.min(memory.confidence, 0.9) * 0.5,
        sourceAuthority: memory.sourceAuthority ?? 'unknown',
        authority: legacyAuthority,
        trust: legacyTrust,
        ...(legacyEventTime ? { eventTime: legacyEventTime } : {}),
      }
    : undefined;
  let centralityMalformed = false;
  const entityDegrees = (memory.subjectEntityIds ?? [])
    .map((entityId) => {
      const degree = options.entityDegrees?.[entityId] ?? 0;
      if (!Number.isSafeInteger(degree) || degree < 0) {
        centralityMalformed = true;
        return { entityId, degree: 0 };
      }
      return { entityId, degree };
    })
    .sort((a, b) => a.entityId.localeCompare(b.entityId));
  const confidence = legacyFallback
    ? legacyFallback.confidence
    : 1 -
      supports.reduce((product, support) => product * (1 - support.authority * support.trust), 1);
  const authority = legacyFallback
    ? legacyFallback.authority * legacyFallback.trust
    : supports.length === 0
      ? 0
      : Math.max(...supports.map((support) => support.authority * support.trust));
  const eventTimes = legacyEventTime
    ? [Date.parse(legacyEventTime)]
    : supports.map((support) => Date.parse(support.eventTime));
  const temporalPersistence =
    eventTimes.length < 2
      ? 0
      : Math.min(1, (Math.max(...eventTimes) - Math.min(...eventTimes)) / (180 * 86_400_000));
  const newestEvent = eventTimes.length === 0 ? undefined : Math.max(...eventTimes);
  const freshness =
    memory.type === 'claim' || memory.type === 'fact'
      ? newestEvent === undefined
        ? 0
        : Math.exp(-(evaluatedAtMs - newestEvent) / (180 * 86_400_000))
      : 1;
  const centrality = entityDegrees.reduce(
    (maximum, input) => Math.max(maximum, 1 - Math.exp(-input.degree / 4)),
    0,
  );
  const explicitCorrection = Boolean(
    memory.supersedes && (!memory.validFrom || options.evaluatedAt >= memory.validFrom),
  );
  const explicitConfirmation = legacyMode
    ? memory.lastConfirmed > memory.created &&
      memory.lastConfirmed <= options.evaluatedAt.slice(0, 10)
    : supports.length > 1;
  const components = {
    confidence,
    authority,
    corroboration: 1 - Math.exp(-Math.max(0, supports.length - 1) / 2),
    typeRelevance: TYPE_RELEVANCE[memory.type],
    temporalPersistence,
    freshness,
    centrality,
    explicitConfirmationCorrection: explicitCorrection ? 1 : explicitConfirmation ? 0.5 : 0,
  };
  const validityMalformed =
    (memory.validFrom !== undefined && !strictIso(memory.validFrom)) ||
    (memory.validUntil !== undefined && !strictIso(memory.validUntil)) ||
    (memory.validFrom !== undefined &&
      memory.validUntil !== undefined &&
      memory.validUntil <= memory.validFrom);
  const validity =
    !validityMalformed &&
    (!memory.validFrom || options.evaluatedAt >= memory.validFrom) &&
    (!memory.validUntil || options.evaluatedAt < memory.validUntil)
      ? 1
      : 0;
  const provenance =
    provenanceMalformed || centralityMalformed
      ? 0
      : memory.candidateRecords
        ? supports.length > 0
          ? 1
          : 0
        : memory.sources.length > 0 &&
            Number.isFinite(memory.confidence) &&
            (memory.eventTime === undefined || legacyEventTime !== undefined)
          ? 0.5
          : 0;
  const additive = Object.entries(SALIENCE_WEIGHTS).reduce(
    (sum, [name, weight]) => sum + components[name as keyof typeof components] * weight,
    0,
  );
  const rawScore = additive * validity * provenance;
  return {
    version: SALIENCE_RECEIPT_VERSION,
    formula: 'sum(weight * component) * validity * provenance',
    memoryId: memory.id,
    evaluatedAt: options.evaluatedAt,
    inputs: {
      type: memory.type,
      lifecycle: memory.lifecycle ?? 'legacy_active',
      ...(memory.validFrom ? { validFrom: memory.validFrom } : {}),
      ...(memory.validUntil ? { validUntil: memory.validUntil } : {}),
      provenanceMode: memory.candidateRecords ? 'candidate_records' : 'legacy_fallback',
      supports,
      ...(legacyFallback ? { legacyFallback } : {}),
      entityDegrees,
      explicitConfirmation,
      explicitCorrection,
      freshnessPolicy:
        memory.type === 'claim' || memory.type === 'fact'
          ? 'event_time_exponential_180d'
          : 'not_applicable',
    },
    weights: SALIENCE_WEIGHTS,
    components,
    gates: { validity, provenance },
    reasons: [
      ...(validityMalformed
        ? ['invalid_validity_interval']
        : validity === 0
          ? ['outside_validity_interval']
          : []),
      ...(centralityMalformed ? ['invalid_centrality_input'] : []),
      ...(provenanceMalformed ? ['invalid_provenance'] : []),
      ...(provenance === 0 && !centralityMalformed && !provenanceMalformed
        ? ['provenance_gate_failed']
        : []),
      ...(provenance === 0.5 ? ['legacy_provenance_fallback'] : []),
    ],
    rawScore,
    score: Number(rawScore.toFixed(6)),
    tieBreak: memory.id,
  };
}
