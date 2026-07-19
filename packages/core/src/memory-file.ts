import { randomBytes } from 'node:crypto';
import YAML from 'yaml';
import { ENTITY_TYPES, type EntityType } from './types.js';

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
  /** Provenance refs, e.g. 'episode:ep_…', 'file:docs/REVIEW.md'. */
  sources: string[];
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

// ── Scopes ───────────────────────────────────────────────────────

const PROJECT_SCOPE_RE = /^project\/[a-z0-9][a-z0-9._-]*$/;

export function isValidScope(scope: string): boolean {
  return scope === 'user' || scope === 'agent' || PROJECT_SCOPE_RE.test(scope);
}

/** Directory (relative to the memory root) where a scope's memories live. */
export function scopeToDir(scope: string): string {
  if (!isValidScope(scope)) throw new MemoryFileError(`Invalid scope: "${scope}"`);
  if (scope.startsWith('project/')) return `projects/${scope.slice('project/'.length)}`;
  return scope;
}

/**
 * Scope encoded by a memory file's path relative to the memory root, e.g.
 * 'projects/nacre/decisions/x.md' → 'project/nacre'. Undefined for paths
 * outside the scope directories (e.g. '.capture/').
 */
export function pathToScope(relPath: string): string | undefined {
  const parts = relPath.split('/').filter(Boolean);
  if (parts.length < 2) return undefined;
  if (parts[0] === 'user') return 'user';
  if (parts[0] === 'agent') return 'agent';
  if (parts[0] === 'projects' && parts.length >= 3) {
    const scope = `project/${parts[1]}`;
    return isValidScope(scope) ? scope : undefined;
  }
  return undefined;
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
  'sources',
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
  if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) {
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
  if (typeof record.supersedes === 'string') memory.supersedes = record.supersedes;
  if (typeof record.superseded_by === 'string') memory.supersededBy = record.superseded_by;

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
  if (memory.sources.length > 0) fm.sources = memory.sources;
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
