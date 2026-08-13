import type { MemoryObjectType, Sensitivity } from './memory-file.js';
import { isMemoryId } from './memory-file.js';
import { isDurableScope } from './scopes.js';

export type MemoryCandidateLifecycle = 'candidate' | 'promoted' | 'rejected';

export interface MemoryEvidenceRef {
  sourceRef: string;
  messageId: string;
  sourcePosition?: { line: number; ordinal: number };
  span: { start: number; end: number; text: string };
  contentHash?: string;
}

export interface MemoryExtractorIdentity {
  name: string;
  version: string;
  model?: string;
}

/** Durable proposal record. Candidates are beliefs, never graph entity nodes. */
export interface MemoryCandidate {
  /** Deterministic identity derived from normalized claim + exact independent evidence. */
  id: string;
  type: MemoryObjectType;
  claim: string;
  normalizedClaim: string;
  scope: string;
  sensitivity: Sensitivity;
  confidence: number;
  sourceAuthority: string;
  trust: number;
  eventTime: string;
  proposedAt: string;
  evidence: MemoryEvidenceRef[];
  subjectEntityIds: string[];
  extractor: MemoryExtractorIdentity;
  lifecycle: MemoryCandidateLifecycle;
  rejectionReason?: string;
  canonicalPath?: string;
  /** Canonical belief identity, distinct from this evidence-specific candidate id. */
  resolvedMemoryId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryCandidateFilter {
  lifecycle?: MemoryCandidateLifecycle;
  scope?: string;
  type?: MemoryObjectType;
}

const TYPES: readonly MemoryObjectType[] = ['claim', 'preference', 'decision', 'fact', 'lesson'];
const SENSITIVITIES: readonly Sensitivity[] = ['low', 'personal', 'sensitive', 'secret'];
const LIFECYCLES: readonly MemoryCandidateLifecycle[] = ['candidate', 'promoted', 'rejected'];

export class MemoryCandidateValidationError extends Error {
  constructor(message: string) {
    super(`Invalid memory candidate: ${message}`);
    this.name = 'MemoryCandidateValidationError';
  }
}

export function normalizeCandidateClaim(claim: string): string {
  return claim
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.!?]+$/g, '')
    .toLocaleLowerCase('en-US');
}

function validIso(value: string): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function requireIso(value: unknown, field: string): string {
  if (typeof value !== 'string' || !validIso(value)) {
    throw new MemoryCandidateValidationError(`${field} must be an ISO timestamp`);
  }
  return value;
}

function requireUnitInterval(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new MemoryCandidateValidationError(`${field} must be a number in [0, 1]`);
  }
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new MemoryCandidateValidationError(`${field} must be a non-empty string`);
  }
  return value;
}

export function assertConfinedCanonicalPath(path: string): void {
  if (
    path.startsWith('/') ||
    path.includes('\\') ||
    path.split('/').some((part) => part === '..' || part === '' || part === '.')
  ) {
    throw new MemoryCandidateValidationError('canonicalPath must be a confined relative path');
  }
  if (!path.endsWith('.md')) {
    throw new MemoryCandidateValidationError('canonicalPath must point to a markdown file');
  }
}

export function validateMemoryEvidenceRef(ref: unknown, field = 'evidence'): MemoryEvidenceRef {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) {
    throw new MemoryCandidateValidationError(`${field} must be an object`);
  }
  const value = ref as Record<string, unknown>;
  const sourceRef = requireString(value.sourceRef, `${field}.sourceRef`);
  const messageId = requireString(value.messageId, `${field}.messageId`);
  if (!value.span || typeof value.span !== 'object' || Array.isArray(value.span)) {
    throw new MemoryCandidateValidationError(`${field}.span must be an object`);
  }
  const span = value.span as Record<string, unknown>;
  if (
    typeof span.start !== 'number' ||
    typeof span.end !== 'number' ||
    !Number.isInteger(span.start) ||
    !Number.isInteger(span.end) ||
    span.start < 0 ||
    span.end <= span.start ||
    typeof span.text !== 'string' ||
    span.text.length !== span.end - span.start
  ) {
    throw new MemoryCandidateValidationError(`${field}.span must contain exact start/end/text`);
  }
  let sourcePosition: MemoryEvidenceRef['sourcePosition'];
  if (value.sourcePosition !== undefined) {
    if (
      !value.sourcePosition ||
      typeof value.sourcePosition !== 'object' ||
      Array.isArray(value.sourcePosition)
    ) {
      throw new MemoryCandidateValidationError(`${field}.sourcePosition must be an object`);
    }
    const pos = value.sourcePosition as Record<string, unknown>;
    if (
      typeof pos.line !== 'number' ||
      typeof pos.ordinal !== 'number' ||
      !Number.isInteger(pos.line) ||
      !Number.isInteger(pos.ordinal) ||
      pos.line < 1 ||
      pos.ordinal < 0
    ) {
      throw new MemoryCandidateValidationError(
        `${field}.sourcePosition must contain line >= 1 and ordinal >= 0`,
      );
    }
    sourcePosition = { line: pos.line, ordinal: pos.ordinal };
  }
  return {
    sourceRef,
    messageId,
    ...(sourcePosition ? { sourcePosition } : {}),
    span: { start: span.start, end: span.end, text: span.text },
    ...(typeof value.contentHash === 'string' && value.contentHash.trim()
      ? { contentHash: value.contentHash }
      : {}),
  };
}

export function validateMemoryExtractorIdentity(value: unknown): MemoryExtractorIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MemoryCandidateValidationError('extractor must be an object');
  }
  const record = value as Record<string, unknown>;
  const extractor: MemoryExtractorIdentity = {
    name: requireString(record.name, 'extractor.name'),
    version: requireString(record.version, 'extractor.version'),
  };
  if (record.model !== undefined) extractor.model = requireString(record.model, 'extractor.model');
  return extractor;
}

export function validateMemoryCandidate(candidate: MemoryCandidate): MemoryCandidate {
  if (!isMemoryId(candidate.id)) {
    throw new MemoryCandidateValidationError('id must be mem_<hex>');
  }
  if (!TYPES.includes(candidate.type)) {
    throw new MemoryCandidateValidationError('type must be a supported memory object type');
  }
  const claim = requireString(candidate.claim, 'claim').trim();
  if (candidate.normalizedClaim !== normalizeCandidateClaim(claim)) {
    throw new MemoryCandidateValidationError('normalizedClaim must match normalized claim');
  }
  if (!isDurableScope(candidate.scope)) {
    throw new MemoryCandidateValidationError('scope must be durable');
  }
  if (!SENSITIVITIES.includes(candidate.sensitivity)) {
    throw new MemoryCandidateValidationError('sensitivity must be supported');
  }
  if (candidate.sensitivity === 'secret') {
    throw new MemoryCandidateValidationError('secret sensitivity is zero-retention');
  }
  const confidence = requireUnitInterval(candidate.confidence, 'confidence');
  const trust = requireUnitInterval(candidate.trust, 'trust');
  const eventTime = requireIso(candidate.eventTime, 'eventTime');
  const proposedAt = requireIso(candidate.proposedAt, 'proposedAt');
  const createdAt = requireIso(candidate.createdAt, 'createdAt');
  const updatedAt = requireIso(candidate.updatedAt, 'updatedAt');
  if (Date.parse(eventTime) > Date.parse(proposedAt)) {
    throw new MemoryCandidateValidationError('eventTime must be <= proposedAt');
  }
  if (Date.parse(createdAt) > Date.parse(updatedAt)) {
    throw new MemoryCandidateValidationError('createdAt must be <= updatedAt');
  }
  if (!Array.isArray(candidate.evidence) || candidate.evidence.length === 0) {
    throw new MemoryCandidateValidationError('evidence must be a non-empty array');
  }
  const evidence = candidate.evidence.map((ref, index) =>
    validateMemoryEvidenceRef(ref, `evidence[${index}]`),
  );
  if (!Array.isArray(candidate.subjectEntityIds)) {
    throw new MemoryCandidateValidationError('subjectEntityIds must be an array');
  }
  if (candidate.subjectEntityIds.some((id) => typeof id !== 'string' || !id.trim())) {
    throw new MemoryCandidateValidationError('subjectEntityIds must contain strings');
  }
  const subjectEntityIds = [...new Set(candidate.subjectEntityIds)].sort();
  if (JSON.stringify(subjectEntityIds) !== JSON.stringify(candidate.subjectEntityIds)) {
    throw new MemoryCandidateValidationError('subjectEntityIds must be unique and sorted');
  }
  const extractor = validateMemoryExtractorIdentity(candidate.extractor);
  if (!LIFECYCLES.includes(candidate.lifecycle)) {
    throw new MemoryCandidateValidationError('lifecycle must be candidate, promoted, or rejected');
  }
  if (candidate.lifecycle === 'rejected' && !candidate.rejectionReason?.trim()) {
    throw new MemoryCandidateValidationError('rejected candidates require a rejectionReason');
  }
  if (candidate.lifecycle !== 'rejected' && candidate.rejectionReason !== undefined) {
    throw new MemoryCandidateValidationError('only rejected candidates may have rejectionReason');
  }
  if (candidate.lifecycle === 'promoted') {
    if (!candidate.canonicalPath) {
      throw new MemoryCandidateValidationError('promoted candidates require canonicalPath');
    }
    assertConfinedCanonicalPath(candidate.canonicalPath);
    if (candidate.resolvedMemoryId !== undefined && !isMemoryId(candidate.resolvedMemoryId)) {
      throw new MemoryCandidateValidationError('resolvedMemoryId must be a memory id');
    }
  } else if (candidate.canonicalPath !== undefined) {
    throw new MemoryCandidateValidationError('only promoted candidates may have canonicalPath');
  } else if (candidate.resolvedMemoryId !== undefined) {
    throw new MemoryCandidateValidationError('only promoted candidates may have resolvedMemoryId');
  }
  return {
    ...candidate,
    claim,
    confidence,
    trust,
    eventTime,
    proposedAt,
    evidence,
    subjectEntityIds,
    extractor,
    createdAt,
    updatedAt,
  };
}
