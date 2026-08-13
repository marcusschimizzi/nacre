import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listMemoryFiles } from './memory-compile.js';
import { validateCanonicalBeliefSet, type CanonicalBelief } from './belief-validation.js';
import {
  beliefAuthority as authorityRank,
  beliefConfidence as confidenceFor,
  beliefConfidenceInputs as inputsFor,
  beliefEvidenceIdentity as evidenceIdentity,
  type BeliefConfidenceInputs,
} from './memory-belief-confidence.js';
import type { MemoryCandidate, MemoryEvidenceRef } from './memory-candidate.js';

import {
  memoryFilePath,
  parseMemoryFile,
  serializeMemoryFile,
  type MemoryObject,
} from './memory-file.js';
import {
  commitMemoryResolution,
  recoverMemoryResolutionTransactions,
  withMemoryResolutionLock,
  type MemoryResolutionFailurePoint,
} from './memory-resolution-transaction.js';
import type { SqliteStore } from './store.js';

export type ConsolidationConfidenceInputs = BeliefConfidenceInputs;

export interface MemoryResolutionReceipt {
  decision: 'created' | 'corroborated' | 'superseded' | 'no_op' | 'needs_review';
  candidateId: string;
  memoryId?: string;
  supersededMemoryId?: string;
  reason: string;
  confidence?: number;
  confidenceInputs: ConsolidationConfidenceInputs;
}

export interface ResolveMemoryCandidateOptions {
  now?: string;
  /** Test-only deterministic crash/I/O seam; the durable intent remains recoverable. */
  failAt?: MemoryResolutionFailurePoint;
}

type Canonical = CanonicalBelief;

function loadCanonicals(memoryDir: string): Canonical[] {
  return listMemoryFiles(memoryDir).map((path) => ({
    path,
    parsed: parseMemoryFile(readFileSync(join(memoryDir, path), 'utf8'), path),
  }));
}

export function resolveMemoryCandidate(
  store: SqliteStore,
  memoryDir: string,
  candidateId: string,
  options: ResolveMemoryCandidateOptions = {},
): MemoryResolutionReceipt {
  return withMemoryResolutionLock(memoryDir, () =>
    resolveMemoryCandidateLocked(store, memoryDir, candidateId, options),
  );
}

function resolveMemoryCandidateLocked(
  store: SqliteStore,
  memoryDir: string,
  candidateId: string,
  options: ResolveMemoryCandidateOptions,
): MemoryResolutionReceipt {
  recoverMemoryResolutionTransactions(store, memoryDir, { lockHeld: true });
  const candidate = store.getMemoryCandidate(candidateId);
  if (!candidate) throw new Error(`Memory candidate not found: ${candidateId}`);
  const initialInputs = inputsFor([candidate]);
  if (candidate.lifecycle === 'rejected')
    throw new Error(`Rejected memory candidate cannot be resolved: ${candidateId}`);
  if (candidate.lifecycle === 'promoted') {
    return {
      decision: 'no_op',
      candidateId,
      memoryId: candidate.resolvedMemoryId ?? candidate.id,
      reason: 'candidate_already_resolved',
      confidence: confidenceFor(initialInputs),
      confidenceInputs: initialInputs,
    };
  }
  if (candidate.scope === 'session' || candidate.sensitivity === 'secret')
    throw new Error('Session/secret candidates cannot become durable beliefs');

  const canonicals = loadCanonicals(memoryDir);
  validateCanonicalBeliefSet(canonicals);
  const matching = canonicals.filter(
    ({ parsed }) =>
      parsed.memory.lifecycle !== 'superseded' &&
      parsed.memory.scope === candidate.scope &&
      normalizeBeliefClaim(parsed.claim) === normalizeBeliefClaim(candidate.claim),
  );
  if (matching.length > 1)
    throw new Error(
      `Conflicting canonical beliefs for normalized claim: ${candidate.normalizedClaim}`,
    );
  if (matching.length === 1) {
    return corroborate(store, memoryDir, candidate, matching[0], options);
  }

  const contradictions = canonicals.filter(
    ({ parsed }) =>
      parsed.memory.lifecycle !== 'superseded' &&
      parsed.memory.scope === candidate.scope &&
      isCopularNegationPair(parsed.claim, candidate.claim),
  );
  if (contradictions.length > 1)
    throw new Error('Conflicting canonical lineage: multiple active contradiction targets');
  if (contradictions.length === 1) {
    const existing = contradictions[0];
    if (!isExplicitCorrection(candidate.claim))
      return needsReview(candidate, initialInputs, 'contradiction_requires_explicit_correction');
    const old = existing.parsed.memory;
    const validFrom = old.validFrom ?? old.eventTime ?? `${old.created}T00:00:00.000Z`;
    if (candidate.eventTime <= validFrom)
      return needsReview(candidate, initialInputs, 'correction_event_time_must_be_later');
    if (authorityRank(old.sourceAuthority) > authorityRank(candidate.sourceAuthority))
      return needsReview(
        candidate,
        initialInputs,
        'lower_authority_cannot_supersede_higher_authority',
      );
    return supersede(store, memoryDir, candidate, existing, options, initialInputs);
  }
  if (isExplicitCorrection(candidate.claim)) {
    return needsReview(candidate, initialInputs, 'correction_target_not_unique_or_unsupported');
  }
  return create(store, memoryDir, candidate, options, initialInputs);
}

function resolvedCandidate(
  candidate: MemoryCandidate,
  canonicalPath: string,
  memoryId: string,
  now: string,
): MemoryCandidate {
  return {
    ...candidate,
    lifecycle: 'promoted',
    canonicalPath,
    resolvedMemoryId: memoryId,
    updatedAt: now,
  };
}

function baseMemory(candidate: MemoryCandidate, now: string): MemoryObject {
  return {
    id: candidate.id,
    type: candidate.type,
    scope: candidate.scope,
    confidence: confidenceFor(inputsFor([candidate])),
    sensitivity: candidate.sensitivity,
    created: candidate.eventTime.slice(0, 10),
    lastConfirmed: candidate.eventTime.slice(0, 10),
    lifecycle: 'active',
    validFrom: candidate.eventTime,
    sources: uniqueSorted(candidate.evidence.map((ref) => ref.sourceRef)),
    sourceAuthority: candidate.sourceAuthority,
    trust: candidate.trust,
    eventTime: candidate.eventTime,
    proposedAt: candidate.proposedAt,
    evidence: sortedEvidence(candidate.evidence),
    subjectEntityIds: candidate.subjectEntityIds,
    extractor: candidate.extractor,
    candidateCreatedAt: candidate.createdAt,
    candidateUpdatedAt: now,
    candidateIds: [candidate.id],
    independentEvidenceCount: independentEvidence(candidate.evidence).size,
    confidenceInputs: inputsFor([candidate]),
    salience: { reinforcementCount: 0 },
    body: appendEvidence(candidate.claim, candidate.evidence),
  };
}

function create(
  store: SqliteStore,
  memoryDir: string,
  candidate: MemoryCandidate,
  options: ResolveMemoryCandidateOptions,
  inputs: ConsolidationConfidenceInputs,
): MemoryResolutionReceipt {
  const now = options.now ?? new Date().toISOString();
  const memory = baseMemory(candidate, now);
  const path = memoryFilePath(memory);
  const record = resolvedCandidate(candidate, path, memory.id, now);
  memory.candidateRecords = [record];
  commitMemoryResolution(
    store,
    memoryDir,
    [{ path, content: serializeMemoryFile(memory) }],
    [record],
    options.failAt,
    { lockHeld: true },
  );
  return {
    decision: 'created',
    candidateId: candidate.id,
    memoryId: memory.id,
    reason: 'no_matching_canonical_belief',
    confidence: memory.confidence,
    confidenceInputs: inputs,
  };
}

function corroborate(
  store: SqliteStore,
  memoryDir: string,
  candidate: MemoryCandidate,
  canonical: Canonical,
  options: ResolveMemoryCandidateOptions,
): MemoryResolutionReceipt {
  const memory = canonical.parsed.memory;
  const now = options.now ?? new Date().toISOString();
  const existingRecords = memory.candidateRecords ?? [];
  const candidateIdentities = independentEvidence(candidate.evidence);
  const existingIdentities = independentEvidence(memory.evidence ?? []);
  if ([...candidateIdentities].every((identity) => existingIdentities.has(identity))) {
    const inputs = memory.confidenceInputs ?? inputsFor(existingRecords);
    return {
      decision: 'no_op',
      candidateId: candidate.id,
      memoryId: memory.id,
      reason: 'same_claim_non_independent_evidence_ignored',
      confidence: memory.confidence,
      confidenceInputs: inputs,
    };
  }
  const record = resolvedCandidate(candidate, canonical.path, memory.id, now);
  const records = [...existingRecords, record].sort((a, b) => a.id.localeCompare(b.id));
  const evidence = sortedEvidence([...(memory.evidence ?? []), ...candidate.evidence]);
  const inputs = inputsFor(records);
  const newIdentityCount = independentEvidence(evidence).size;
  const updated: MemoryObject = {
    ...memory,
    confidence: confidenceFor(inputs),
    lastConfirmed:
      candidate.eventTime.slice(0, 10) > memory.lastConfirmed
        ? candidate.eventTime.slice(0, 10)
        : memory.lastConfirmed,
    sources: uniqueSorted([...memory.sources, ...candidate.evidence.map((ref) => ref.sourceRef)]),
    evidence,
    candidateIds: records.map((value) => value.id),
    candidateRecords: records,
    independentEvidenceCount: newIdentityCount,
    confidenceInputs: inputs,
    candidateUpdatedAt: now,
    body: appendEvidence(memory.body, candidate.evidence),
  };
  commitMemoryResolution(
    store,
    memoryDir,
    [{ path: canonical.path, content: serializeMemoryFile(updated) }],
    [record],
    options.failAt,
    { lockHeld: true },
  );
  return {
    decision: 'corroborated',
    candidateId: candidate.id,
    memoryId: memory.id,
    reason: 'same_normalized_claim_new_independent_evidence',
    confidence: updated.confidence,
    confidenceInputs: inputs,
  };
}

function supersede(
  store: SqliteStore,
  memoryDir: string,
  candidate: MemoryCandidate,
  canonical: Canonical,
  options: ResolveMemoryCandidateOptions,
  inputs: ConsolidationConfidenceInputs,
): MemoryResolutionReceipt {
  const now = options.now ?? new Date().toISOString();
  const old = canonical.parsed.memory;
  const memory = { ...baseMemory(candidate, now), supersedes: old.id };
  const path = memoryFilePath(memory);
  const record = resolvedCandidate(candidate, path, memory.id, now);
  memory.candidateRecords = [record];
  const retired: MemoryObject = {
    ...old,
    lifecycle: 'superseded',
    supersededBy: memory.id,
    validUntil: candidate.eventTime,
  };
  commitMemoryResolution(
    store,
    memoryDir,
    [
      { path: canonical.path, content: serializeMemoryFile(retired) },
      { path, content: serializeMemoryFile(memory) },
    ],
    [record],
    options.failAt,
    { lockHeld: true },
  );
  return {
    decision: 'superseded',
    candidateId: candidate.id,
    memoryId: memory.id,
    supersededMemoryId: old.id,
    reason: 'explicit_supported_copular_correction',
    confidence: memory.confidence,
    confidenceInputs: inputs,
  };
}

function needsReview(
  candidate: MemoryCandidate,
  confidenceInputs: ConsolidationConfidenceInputs,
  reason: string,
): MemoryResolutionReceipt {
  return {
    decision: 'needs_review',
    candidateId: candidate.id,
    reason,
    confidence: confidenceFor(confidenceInputs),
    confidenceInputs,
  };
}

function normalizeBeliefClaim(claim: string): string {
  return claim
    .normalize('NFKC')
    .trim()
    .replace(/^(?:remember that|correction:|actually,|i need to correct that:)\s*/i, '')
    .replace(/\s+/g, ' ')
    .replace(/[.!?]+$/g, '')
    .toLowerCase();
}
function isExplicitCorrection(claim: string): boolean {
  return /^(?:correction:|actually,|i need to correct that:)\s*\S/i.test(claim.trim());
}
function isCopularNegationPair(left: string, right: string): boolean {
  const a = normalizeBeliefClaim(left);
  const b = normalizeBeliefClaim(right);
  const negated = /\s+(?:is|are|was|were)\s+not\s+/;
  const remove = (value: string) => value.replace(/\s+(is|are|was|were)\s+not\s+/, ' $1 ');
  return a !== b && remove(a) === remove(b) && negated.test(a) !== negated.test(b);
}
function evidenceRecordIdentity(ref: MemoryEvidenceRef): string {
  return JSON.stringify([evidenceIdentity(ref), ref.span.start, ref.span.end, ref.span.text]);
}
function independentEvidence(evidence: MemoryEvidenceRef[]): Set<string> {
  return new Set(evidence.map(evidenceIdentity));
}
function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}
function sortedEvidence(values: MemoryEvidenceRef[]): MemoryEvidenceRef[] {
  const byIdentity = new Map<string, MemoryEvidenceRef>();
  for (const value of values) byIdentity.set(evidenceRecordIdentity(value), value);
  return [...byIdentity.values()].sort((a, b) =>
    evidenceRecordIdentity(a).localeCompare(evidenceRecordIdentity(b)),
  );
}

function renderEvidence(refs: MemoryEvidenceRef[]): string {
  return sortedEvidence(refs)
    .map(
      (ref) =>
        `> ${ref.span.text.replaceAll('\n', '\n> ')}\n> — ${ref.sourceRef} (${ref.messageId}:${ref.span.start}-${ref.span.end})`,
    )
    .join('\n\n');
}
function appendEvidence(body: string, refs: MemoryEvidenceRef[]): string {
  const block = renderEvidence(refs);
  if (!block) return body;
  return body.includes('\n## Source')
    ? `${body.trimEnd()}\n\n${block}`
    : `${body.trimEnd()}\n\n## Source\n\n${block}`;
}
