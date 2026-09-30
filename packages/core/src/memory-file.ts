import { randomBytes } from 'node:crypto';
import YAML from 'yaml';
import { isValidScope, pathToScope, scopeToDir } from './scopes.js';
import { ENTITY_TYPES, type EntityType } from './types.js';
import {
  validateMemoryCandidate,
  validateMemoryEvidenceRef,
  validateMemoryExtractorIdentity,
  type MemoryCandidate,
  type MemoryEvidenceRef,
  type MemoryExtractorIdentity,
} from './memory-candidate.js';
import { beliefConfidence, beliefConfidenceInputs } from './memory-belief-confidence.js';

// ── Canonical memory files (V2-1 truth layer) ────────────────────
//
// One file per durable memory object: YAML frontmatter (a closed schema —
// the V2-3 Memory object) plus a markdown body whose first paragraph is the
// claim and whose optional `## Source` section preserves verbatim evidence.
// These files are the truth layer; SQLite/embeddings are compiled views.
// See docs/V2-1-TRUTH-LAYER.md.

export type MemoryObjectType = 'claim' | 'preference' | 'decision' | 'fact' | 'lesson';

export type Sensitivity = 'low' | 'personal' | 'sensitive' | 'secret';

export const MEMORY_OBJECT_TYPES: readonly MemoryObjectType[] = [
  'claim',
  'preference',
  'decision',
  'fact',
  'lesson',
];

export const SENSITIVITY_LEVELS: readonly Sensitivity[] = [
  'low',
  'personal',
  'sensitive',
  'secret',
];

export interface MemorySalience {
  /** Updated only during consolidation — never on the read/recall hot path. */
  reinforcementCount: number;
  lastReinforced?: string;
}

export interface MemoryObject {
  /** Stable identity — minted at capture, never reused. Filenames/paths may change. */
  id: string;
  type: MemoryObjectType;
  /**
   * Entity-graph node type this memory compiles to, when the memory type
   * alone would lose it (e.g. an API write about a person/tool). Absent means
   * the default memory-type → node-type projection applies.
   */
  entityType?: EntityType;
  /** 'user' | 'agent' | 'project/<name>'. Path encodes scope; on conflict the path wins. */
  scope: string;
  confidence: number;
  sensitivity: Sensitivity;
  created: string;
  lastConfirmed: string;
  supersedes?: string;
  supersededBy?: string;
  /** Belief lifecycle and event-time validity; canonical files are authoritative. */
  lifecycle?: 'active' | 'superseded';
  validFrom?: string;
  validUntil?: string;
  /** Candidate identities aggregated into this belief (evidence identity remains separate). */
  candidateIds?: string[];
  /** Complete promoted candidate records required to rebuild candidate→belief resolution. */
  candidateRecords?: MemoryCandidate[];
  independentEvidenceCount?: number;
  confidenceInputs?: {
    independentEvidenceCount: number;
    supports: Array<{
      sourceEventId: string;
      sourceAuthority: string;
      authority: number;
      trust: number;
    }>;
    formula: string;
  };
  /** Provenance refs, e.g. 'episode:ep_…', 'file:docs/REVIEW.md'. */
  sources: string[];
  /** Evidence-quality and extraction metadata for candidate-promoted memories. */
  sourceAuthority?: string;
  trust?: number;
  eventTime?: string;
  proposedAt?: string;
  evidence?: MemoryEvidenceRef[];
  subjectEntityIds?: string[];
  extractor?: MemoryExtractorIdentity;
  candidateCreatedAt?: string;
  candidateUpdatedAt?: string;
  salience: MemorySalience;
  /** Full markdown body (claim paragraph, prose, optional `## Source` section). */
  body: string;
}

export interface ParsedMemoryFile {
  memory: MemoryObject;
  /** First non-empty, non-heading paragraph of the body — what gets embedded. */
  claim: string;
  /** Raw content of the `## Source` section (verbatim evidence), if present. */
  source?: string;
  /** [[wikilinks]] found in the body, deduped in order of appearance. */
  wikilinks: string[];
  /** Non-fatal issues: unknown keys, scope/path disagreement, missing claim. */
  warnings: string[];
}

export class MemoryFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryFileError';
  }
}

// ── Identity & slugs ─────────────────────────────────────────────

export function mintMemoryId(): string {
  return `mem_${randomBytes(6).toString('hex')}`;
}

const MEMORY_ID_RE = /^mem_[0-9a-f]{6,}$/;

/** Whether a string is a well-formed canonical memory id. */
export function isMemoryId(id: string): boolean {
  return MEMORY_ID_RE.test(id);
}

/** Human-readable filename slug derived from the claim. Not an identity — renames are safe. */
export function memorySlug(claim: string, maxLength = 60): string {
  const slug = claim
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length <= maxLength) return slug || 'memory';
  const cut = slug.slice(0, maxLength);
  const lastDash = cut.lastIndexOf('-');
  return lastDash > maxLength / 2 ? cut.slice(0, lastDash) : cut;
}

// ── Parsing ──────────────────────────────────────────────────────

const KNOWN_KEYS = new Set([
  'id',
  'type',
  'entity_type',
  'scope',
  'confidence',
  'sensitivity',
  'created',
  'last_confirmed',
  'supersedes',
  'superseded_by',
  'lifecycle',
  'valid_from',
  'valid_until',
  'candidate_ids',
  'candidate_records',
  'independent_evidence_count',
  'confidence_inputs',
  'sources',
  'source_authority',
  'trust',
  'event_time',
  'proposed_at',
  'evidence',
  'subject_entity_ids',
  'extractor',
  'candidate_created_at',
  'candidate_updated_at',
  'salience',
]);

const KNOWN_SALIENCE_KEYS = new Set(['reinforcement_count', 'last_reinforced']);

const WIKILINK_RE = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;

function asDateString(value: unknown, field: string): string {
  // The yaml core schema keeps unquoted dates as strings; guard against
  // hand-edited files where a value parsed as something else.
  if (typeof value === 'string' && value.length > 0) return value;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  throw new MemoryFileError(`Frontmatter field "${field}" must be a date string`);
}

function asIsoTimestamp(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    throw new MemoryFileError(`Frontmatter field "${field}" must be an ISO timestamp`);
  }
  return value;
}

export function extractWikilinks(body: string): string[] {
  const seen = new Set<string>();
  const links: string[] = [];
  for (const match of body.matchAll(WIKILINK_RE)) {
    const target = match[1].trim();
    if (target && !seen.has(target)) {
      seen.add(target);
      links.push(target);
    }
  }
  return links;
}

/**
 * First non-empty, non-heading paragraph of a markdown body, taken from
 * before the first `##` section — `## Source` evidence is not the claim.
 */
export function extractClaim(body: string): string {
  const sectionStart = body.search(/^##\s+/m);
  const head = sectionStart === -1 ? body : body.slice(0, sectionStart);
  const blocks = head.split(/\n\s*\n/);
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    return trimmed.replace(/\s*\n\s*/g, ' ');
  }
  return '';
}

/** Raw content of the `## Source` section, up to the next `##` heading or EOF. */
export function extractSource(body: string): string | undefined {
  const match = body.match(/^##\s+Source\s*$/m);
  if (!match || match.index === undefined) return undefined;
  const after = body.slice(match.index + match[0].length);
  const next = after.search(/^##\s+/m);
  const section = (next === -1 ? after : after.slice(0, next)).trim();
  return section.length > 0 ? section : undefined;
}

/**
 * Parse a canonical memory file. Structural problems (missing frontmatter,
 * invalid required fields, `sensitivity: secret`) throw MemoryFileError;
 * recoverable issues (unknown keys, scope/path disagreement) are warnings.
 *
 * When `relPath` (relative to the memory root) is given, the path-encoded
 * scope is authoritative: a disagreeing frontmatter scope produces a warning
 * and the path wins.
 */
export function parseMemoryFile(content: string, relPath?: string): ParsedMemoryFile {
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) {
    throw new MemoryFileError('Memory file must start with YAML frontmatter (---)');
  }
  const end = content.indexOf('\n---', 3);
  if (end === -1) {
    throw new MemoryFileError('Unterminated frontmatter: closing --- not found');
  }
  const rawFrontmatter = content.slice(content.indexOf('\n') + 1, end);
  const body = content
    .slice(end + '\n---'.length)
    .replace(/^\r?\n/, '')
    .trim();

  let fm: unknown;
  try {
    fm = YAML.parse(rawFrontmatter);
  } catch (err) {
    throw new MemoryFileError(
      `Invalid YAML frontmatter: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (fm === null || typeof fm !== 'object' || Array.isArray(fm)) {
    throw new MemoryFileError('Frontmatter must be a YAML mapping');
  }
  const record = fm as Record<string, unknown>;
  const warnings: string[] = [];

  // Closed schema: unknown keys are compile warnings, never silent.
  for (const key of Object.keys(record)) {
    if (!KNOWN_KEYS.has(key)) warnings.push(`Unknown frontmatter key: "${key}"`);
  }

  const id = record.id;
  if (typeof id !== 'string' || !MEMORY_ID_RE.test(id)) {
    throw new MemoryFileError(
      `Missing or invalid "id" (expected mem_<hex>, got ${JSON.stringify(id)})`,
    );
  }

  const type = record.type;
  if (typeof type !== 'string' || !MEMORY_OBJECT_TYPES.includes(type as MemoryObjectType)) {
    throw new MemoryFileError(
      `Invalid "type": ${JSON.stringify(type)} (expected one of ${MEMORY_OBJECT_TYPES.join(', ')})`,
    );
  }

  const entityType = record.entity_type;
  if (
    entityType !== undefined &&
    (typeof entityType !== 'string' || !ENTITY_TYPES.includes(entityType as EntityType))
  ) {
    throw new MemoryFileError(
      `Invalid "entity_type": ${JSON.stringify(entityType)} (expected one of ${ENTITY_TYPES.join(', ')})`,
    );
  }

  const sensitivity = record.sensitivity ?? 'low';
  if (typeof sensitivity !== 'string' || !SENSITIVITY_LEVELS.includes(sensitivity as Sensitivity)) {
    throw new MemoryFileError(
      `Invalid "sensitivity": ${JSON.stringify(sensitivity)} (expected one of ${SENSITIVITY_LEVELS.join(', ')})`,
    );
  }
  if (sensitivity === 'secret') {
    // Zero-retention class: secrets must never exist as durable memory.
    throw new MemoryFileError(
      'sensitivity "secret" is not allowed in durable memory (zero-retention class)',
    );
  }

  const rawScope = record.scope;
  if (typeof rawScope !== 'string' || !isValidScope(rawScope)) {
    throw new MemoryFileError(
      `Invalid "scope": ${JSON.stringify(rawScope)} (expected 'user', 'agent', or 'project/<name>')`,
    );
  }
  let scope: string = rawScope;
  if (relPath) {
    const pathScope = pathToScope(relPath);
    if (pathScope && pathScope !== scope) {
      warnings.push(
        `Scope mismatch: frontmatter says "${scope}" but path encodes "${pathScope}" — path wins`,
      );
      scope = pathScope;
    }
  }

  const confidence = record.confidence ?? 1;
  if (
    typeof confidence !== 'number' ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    throw new MemoryFileError(
      `Invalid "confidence": ${JSON.stringify(confidence)} (expected a number in [0, 1])`,
    );
  }

  const created = asDateString(record.created, 'created');
  const lastConfirmed =
    record.last_confirmed === undefined
      ? created
      : asDateString(record.last_confirmed, 'last_confirmed');

  for (const field of ['supersedes', 'superseded_by'] as const) {
    const value = record[field];
    if (value !== undefined && value !== null && typeof value !== 'string') {
      throw new MemoryFileError(`Invalid "${field}": expected a memory id string`);
    }
  }

  const rawSources = record.sources ?? [];
  if (!Array.isArray(rawSources) || rawSources.some((s) => typeof s !== 'string')) {
    throw new MemoryFileError('Invalid "sources": expected a list of strings');
  }

  const rawSalience = (record.salience ?? {}) as Record<string, unknown>;
  if (typeof rawSalience !== 'object' || Array.isArray(rawSalience)) {
    throw new MemoryFileError('Invalid "salience": expected a mapping');
  }
  for (const key of Object.keys(rawSalience)) {
    if (!KNOWN_SALIENCE_KEYS.has(key)) warnings.push(`Unknown salience key: "${key}"`);
  }
  const reinforcementCount = rawSalience.reinforcement_count ?? 0;
  if (typeof reinforcementCount !== 'number' || reinforcementCount < 0) {
    throw new MemoryFileError(
      'Invalid "salience.reinforcement_count": expected a non-negative number',
    );
  }
  const salience: MemorySalience = { reinforcementCount };
  if (rawSalience.last_reinforced !== undefined) {
    salience.lastReinforced = asDateString(rawSalience.last_reinforced, 'salience.last_reinforced');
  }

  const claim = extractClaim(body);
  if (!claim) warnings.push('Body has no claim paragraph (nothing to embed)');

  const memory: MemoryObject = {
    id,
    type: type as MemoryObjectType,
    scope,
    confidence,
    sensitivity: sensitivity as Sensitivity,
    created,
    lastConfirmed,
    sources: rawSources as string[],
    salience,
    body,
  };
  if (typeof entityType === 'string') memory.entityType = entityType as EntityType;
  if (record.source_authority !== undefined) {
    if (typeof record.source_authority !== 'string' || !record.source_authority.trim()) {
      throw new MemoryFileError('Invalid "source_authority": expected a non-empty string');
    }
    memory.sourceAuthority = record.source_authority;
  }
  if (record.trust !== undefined) {
    if (
      typeof record.trust !== 'number' ||
      !Number.isFinite(record.trust) ||
      record.trust < 0 ||
      record.trust > 1
    ) {
      throw new MemoryFileError('Invalid "trust": expected a number in [0, 1]');
    }
    memory.trust = record.trust;
  }
  if (record.event_time !== undefined)
    memory.eventTime = asIsoTimestamp(record.event_time, 'event_time');
  if (record.proposed_at !== undefined) {
    memory.proposedAt = asIsoTimestamp(record.proposed_at, 'proposed_at');
  }
  if (record.evidence !== undefined) {
    if (!Array.isArray(record.evidence) || record.evidence.length === 0) {
      throw new MemoryFileError('Invalid "evidence": expected a non-empty list');
    }
    try {
      memory.evidence = record.evidence.map((ref, index) =>
        validateMemoryEvidenceRef(ref, `evidence[${index}]`),
      );
    } catch (err) {
      throw new MemoryFileError(err instanceof Error ? err.message : String(err));
    }
  }
  if (Array.isArray(record.subject_entity_ids)) {
    if (record.subject_entity_ids.some((id) => typeof id !== 'string' || !id.trim())) {
      throw new MemoryFileError('Invalid "subject_entity_ids": expected a list of strings');
    }
    const sorted = [...new Set(record.subject_entity_ids)].sort();
    if (JSON.stringify(sorted) !== JSON.stringify(record.subject_entity_ids)) {
      throw new MemoryFileError('Invalid "subject_entity_ids": expected unique sorted strings');
    }
    memory.subjectEntityIds = sorted;
  } else if (record.subject_entity_ids !== undefined) {
    throw new MemoryFileError('Invalid "subject_entity_ids": expected a list of strings');
  }
  if (record.extractor !== undefined) {
    try {
      memory.extractor = validateMemoryExtractorIdentity(record.extractor);
    } catch (err) {
      throw new MemoryFileError(err instanceof Error ? err.message : String(err));
    }
  }
  if (typeof record.candidate_created_at === 'string') {
    memory.candidateCreatedAt = asIsoTimestamp(record.candidate_created_at, 'candidate_created_at');
  }
  if (typeof record.candidate_updated_at === 'string') {
    memory.candidateUpdatedAt = asIsoTimestamp(record.candidate_updated_at, 'candidate_updated_at');
  }
  if (typeof record.supersedes === 'string') memory.supersedes = record.supersedes;
  if (typeof record.superseded_by === 'string') memory.supersededBy = record.superseded_by;
  if (memory.supersedes !== undefined && !isMemoryId(memory.supersedes)) {
    throw new MemoryFileError('Invalid lineage: "supersedes" must be a memory id');
  }
  if (memory.supersededBy !== undefined && !isMemoryId(memory.supersededBy)) {
    throw new MemoryFileError('Invalid lineage: "superseded_by" must be a memory id');
  }
  if (memory.supersedes === memory.id || memory.supersededBy === memory.id) {
    throw new MemoryFileError('Invalid lineage: a belief cannot supersede itself');
  }
  if (record.lifecycle !== undefined) {
    if (record.lifecycle !== 'active' && record.lifecycle !== 'superseded') {
      throw new MemoryFileError('Invalid "lifecycle": expected active or superseded');
    }
    memory.lifecycle = record.lifecycle;
  }
  if (record.valid_from !== undefined)
    memory.validFrom = asIsoTimestamp(record.valid_from, 'valid_from');
  if (record.valid_until !== undefined)
    memory.validUntil = asIsoTimestamp(record.valid_until, 'valid_until');
  if (memory.lifecycle === 'active' && (memory.supersededBy || memory.validUntil)) {
    throw new MemoryFileError(
      'Invalid lineage: active belief cannot have superseded_by or valid_until',
    );
  }
  if (memory.lifecycle === 'superseded' && (!memory.supersededBy || !memory.validUntil)) {
    throw new MemoryFileError(
      'Invalid lineage: superseded belief requires superseded_by and valid_until',
    );
  }
  if (memory.validFrom && memory.validUntil && memory.validFrom >= memory.validUntil) {
    throw new MemoryFileError('Invalid validity interval: valid_from must precede valid_until');
  }
  if (record.candidate_ids !== undefined) {
    if (
      !Array.isArray(record.candidate_ids) ||
      record.candidate_ids.some((id) => typeof id !== 'string' || !isMemoryId(id))
    ) {
      throw new MemoryFileError('Invalid "candidate_ids": expected memory ids');
    }
    const ids = [...new Set(record.candidate_ids)].sort() as string[];
    if (JSON.stringify(ids) !== JSON.stringify(record.candidate_ids)) {
      throw new MemoryFileError('Invalid "candidate_ids": expected unique sorted ids');
    }
    memory.candidateIds = ids;
  }
  if (record.candidate_records !== undefined) {
    if (!Array.isArray(record.candidate_records)) {
      throw new MemoryFileError('Invalid "candidate_records": expected array');
    }
    try {
      const records = record.candidate_records.map((value) =>
        validateMemoryCandidate(value as MemoryCandidate),
      );
      const sorted = [...records].sort((a, b) => a.id.localeCompare(b.id));
      if (
        records.some((value, index) => value.id !== sorted[index]?.id) ||
        new Set(records.map((value) => value.id)).size !== records.length
      ) {
        throw new Error('expected unique records sorted by id');
      }
      if (records.some((value) => value.lifecycle !== 'promoted' || !value.resolvedMemoryId)) {
        throw new Error('expected promoted records with resolvedMemoryId');
      }
      memory.candidateRecords = records;
    } catch (error) {
      throw new MemoryFileError(
        `Invalid "candidate_records": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (record.independent_evidence_count !== undefined) {
    if (
      !Number.isInteger(record.independent_evidence_count) ||
      (record.independent_evidence_count as number) < 1
    ) {
      throw new MemoryFileError('Invalid "independent_evidence_count": expected positive integer');
    }
    memory.independentEvidenceCount = record.independent_evidence_count as number;
  }
  if (record.confidence_inputs !== undefined) {
    const inputs = record.confidence_inputs as Record<string, unknown>;
    if (
      !inputs ||
      typeof inputs !== 'object' ||
      Array.isArray(inputs) ||
      !Number.isInteger(inputs.independent_evidence_count) ||
      !Array.isArray(inputs.supports) ||
      typeof inputs.formula !== 'string'
    ) {
      throw new MemoryFileError('Invalid "confidence_inputs"');
    }
    const supports = inputs.supports.map((support) => {
      const value = support as Record<string, unknown>;
      if (
        typeof value.source_event_id !== 'string' ||
        typeof value.source_authority !== 'string' ||
        typeof value.authority !== 'number' ||
        value.authority < 0 ||
        value.authority > 1 ||
        typeof value.trust !== 'number' ||
        value.trust < 0 ||
        value.trust > 1
      ) {
        throw new MemoryFileError('Invalid "confidence_inputs.supports"');
      }
      return {
        sourceEventId: value.source_event_id,
        sourceAuthority: value.source_authority,
        authority: value.authority,
        trust: value.trust,
      };
    });
    if (supports.length !== inputs.independent_evidence_count) {
      throw new MemoryFileError('Invalid "confidence_inputs": support count mismatch');
    }
    memory.confidenceInputs = {
      independentEvidenceCount: inputs.independent_evidence_count as number,
      supports,
      formula: inputs.formula,
    };
  }

  if (memory.candidateRecords) {
    if (!memory.candidateIds || !memory.confidenceInputs || !memory.independentEvidenceCount) {
      throw new MemoryFileError(
        'Invalid belief provenance: candidate records require ids, evidence count, and confidence inputs',
      );
    }
    const recordIds = memory.candidateRecords.map((candidate) => candidate.id);
    if (JSON.stringify(recordIds) !== JSON.stringify(memory.candidateIds)) {
      throw new MemoryFileError('Invalid belief provenance: candidate_ids disagree with records');
    }
    if (
      memory.candidateRecords.some(
        (candidate) =>
          candidate.resolvedMemoryId !== memory.id || candidate.canonicalPath !== relPath,
      )
    ) {
      throw new MemoryFileError(
        'Invalid belief provenance: candidate resolution does not identify this canonical memory',
      );
    }
    const expectedInputs = beliefConfidenceInputs(memory.candidateRecords);
    if (JSON.stringify(memory.confidenceInputs) !== JSON.stringify(expectedInputs)) {
      throw new MemoryFileError(
        'Invalid belief provenance: confidence inputs disagree with candidate records',
      );
    }
    if (
      memory.independentEvidenceCount !== expectedInputs.independentEvidenceCount ||
      memory.confidence !== beliefConfidence(expectedInputs)
    ) {
      throw new MemoryFileError(
        'Invalid belief provenance: confidence or evidence count disagrees with its inputs',
      );
    }
  }

  const hasCandidateMetadata = [
    'evidence',
    'extractor',
    'candidate_created_at',
    'candidate_updated_at',
  ].some((key) => record[key] !== undefined);
  if (hasCandidateMetadata) {
    const missing = [
      !claim && 'claim body',
      !memory.sourceAuthority && 'source_authority',
      memory.trust === undefined && 'trust',
      !memory.eventTime && 'event_time',
      !memory.proposedAt && 'proposed_at',
      !memory.evidence && 'evidence',
      !memory.extractor && 'extractor',
      !memory.candidateCreatedAt && 'candidate_created_at',
      !memory.candidateUpdatedAt && 'candidate_updated_at',
    ].filter(Boolean);
    if (missing.length > 0) {
      throw new MemoryFileError(`Incomplete candidate metadata: missing ${missing.join(', ')}`);
    }
    const { eventTime, proposedAt, candidateCreatedAt, candidateUpdatedAt } = memory;
    if (!eventTime || !proposedAt || !candidateCreatedAt || !candidateUpdatedAt) {
      throw new MemoryFileError('Incomplete candidate metadata timestamps');
    }
    if (Date.parse(eventTime) > Date.parse(proposedAt)) {
      throw new MemoryFileError('Invalid candidate metadata: event_time must be <= proposed_at');
    }
    if (Date.parse(candidateCreatedAt) > Date.parse(candidateUpdatedAt)) {
      throw new MemoryFileError(
        'Invalid candidate metadata: candidate_created_at must be <= candidate_updated_at',
      );
    }
  }

  return {
    memory,
    claim,
    source: extractSource(body),
    wikilinks: extractWikilinks(body),
    warnings,
  };
}

// ── Serialization ────────────────────────────────────────────────

/**
 * Serialize a memory object to its canonical file form. Deterministic: fixed
 * key order, optional fields omitted when absent, so parse → serialize is
 * stable and git diffs stay minimal.
 */
export function serializeMemoryFile(memory: MemoryObject): string {
  if (memory.sensitivity === 'secret') {
    throw new MemoryFileError(
      'sensitivity "secret" is not allowed in durable memory (zero-retention class)',
    );
  }
  if (!isValidScope(memory.scope)) {
    throw new MemoryFileError(`Invalid scope: "${memory.scope}"`);
  }

  const fm: Record<string, unknown> = {
    id: memory.id,
    type: memory.type,
    ...(memory.entityType ? { entity_type: memory.entityType } : {}),
    scope: memory.scope,
    confidence: memory.confidence,
    sensitivity: memory.sensitivity,
    created: memory.created,
    last_confirmed: memory.lastConfirmed,
  };
  if (memory.supersedes) fm.supersedes = memory.supersedes;
  if (memory.supersededBy) fm.superseded_by = memory.supersededBy;
  if (memory.lifecycle) fm.lifecycle = memory.lifecycle;
  if (memory.validFrom) fm.valid_from = memory.validFrom;
  if (memory.validUntil) fm.valid_until = memory.validUntil;
  if (memory.candidateIds) fm.candidate_ids = memory.candidateIds;
  if (memory.candidateRecords) fm.candidate_records = memory.candidateRecords;
  if (memory.independentEvidenceCount !== undefined)
    fm.independent_evidence_count = memory.independentEvidenceCount;
  if (memory.confidenceInputs) {
    fm.confidence_inputs = {
      independent_evidence_count: memory.confidenceInputs.independentEvidenceCount,
      supports: memory.confidenceInputs.supports.map((support) => ({
        source_event_id: support.sourceEventId,
        source_authority: support.sourceAuthority,
        authority: support.authority,
        trust: support.trust,
      })),
      formula: memory.confidenceInputs.formula,
    };
  }
  if (memory.sources.length > 0) fm.sources = memory.sources;
  if (memory.sourceAuthority) fm.source_authority = memory.sourceAuthority;
  if (memory.trust !== undefined) fm.trust = memory.trust;
  if (memory.eventTime) fm.event_time = memory.eventTime;
  if (memory.proposedAt) fm.proposed_at = memory.proposedAt;
  if (memory.evidence) fm.evidence = memory.evidence;
  if (memory.subjectEntityIds) fm.subject_entity_ids = memory.subjectEntityIds;
  if (memory.extractor) fm.extractor = memory.extractor;
  if (memory.candidateCreatedAt) fm.candidate_created_at = memory.candidateCreatedAt;
  if (memory.candidateUpdatedAt) fm.candidate_updated_at = memory.candidateUpdatedAt;
  const salience: Record<string, unknown> = {
    reinforcement_count: memory.salience.reinforcementCount,
  };
  if (memory.salience.lastReinforced) salience.last_reinforced = memory.salience.lastReinforced;
  fm.salience = salience;

  const yaml = YAML.stringify(fm, { lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---\n\n${memory.body.trim()}\n`;
}

/** Relative path (from the memory root) where a memory's canonical file belongs. */
export function memoryFilePath(memory: MemoryObject, claim?: string): string {
  const dir = scopeToDir(memory.scope);
  const slug = memorySlug(claim ?? extractClaim(memory.body));
  return `${dir}/${memory.type}s/${slug}.md`;
}
