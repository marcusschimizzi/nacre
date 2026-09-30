import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { isDurablyRejected, readDurableMemoryCandidates } from './memory-candidate-durable.js';
import { indexCanonicalIds, resolveTargetPath } from './memory-promote.js';
import { serializeMemoryFile, type MemoryObject } from './memory-file.js';
import type { MemoryCandidate } from './memory-candidate.js';
import type { SqliteStore } from './store.js';

export interface CandidateLifecycleOptions {
  now?: string;
}

export interface CandidatePromotionResult {
  status: 'promoted' | 'already_promoted';
  candidate: MemoryCandidate;
  canonicalPath: string;
}

export interface CandidateReplayResult {
  replayed: number;
  skipped: number;
  errors: string[];
}

function requireCandidate(store: SqliteStore, id: string): MemoryCandidate {
  const candidate = store.getMemoryCandidate(id);
  if (!candidate) throw new Error(`Memory candidate not found: ${id}`);
  return candidate;
}

function sourceBody(candidate: MemoryCandidate): string {
  const evidence = candidate.evidence
    .map(
      (ref) =>
        `> ${ref.span.text.replaceAll('\n', '\n> ')}\n> — ${ref.sourceRef} (${ref.messageId}:${ref.span.start}-${ref.span.end})`,
    )
    .join('\n\n');
  return `${candidate.claim}\n\n## Source\n\n${evidence}`;
}

function ensureCanonicalDirectory(memoryDir: string, canonicalPath: string): string {
  const root = resolve(memoryDir);
  const destination = resolve(root, canonicalPath);
  const rel = relative(root, destination);
  if (!rel || rel.startsWith('..') || resolve(root, rel) !== destination) {
    throw new Error('Canonical candidate path escapes the configured memory root');
  }
  let current = root;
  const rootStat = lstatSync(root, { throwIfNoEntry: false });
  if (rootStat?.isSymbolicLink() || (rootStat && !rootStat.isDirectory())) {
    throw new Error(`Canonical memory root must be a real directory: ${root}`);
  }
  if (!rootStat) mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const component of relative(root, dirname(destination)).split(/[/\\]/).filter(Boolean)) {
    current = join(current, component);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink() || (stat && !stat.isDirectory())) {
      throw new Error(`Canonical memory ancestor must be a real directory: ${current}`);
    }
    if (!stat) mkdirSync(current, { mode: 0o700 });
  }
  return destination;
}

function publishCanonicalMemory(memoryDir: string, canonicalPath: string, body: string): void {
  const destination = ensureCanonicalDirectory(memoryDir, canonicalPath);
  const temporary = join(dirname(destination), `.candidate-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, body, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    const file = openSync(temporary, 'r');
    try {
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    // Hard-link publication is atomic and fails rather than overwriting a
    // destination created by a non-SQLite writer between indexing and publish.
    linkSync(temporary, destination);
    const directory = openSync(dirname(destination), 'r');
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Explicit candidate → canonical truth-layer transition. Never overwrites a file. */
export function promoteMemoryCandidate(
  store: SqliteStore,
  memoryDir: string,
  id: string,
  options: CandidateLifecycleOptions = {},
): CandidatePromotionResult {
  return store.immediateTransaction(() => {
    const candidate = requireCandidate(store, id);
    if (isDurablyRejected(memoryDir, id)) {
      throw new Error(`Rejected memory candidate cannot be promoted: ${id}`);
    }
    if (candidate.lifecycle === 'rejected') {
      throw new Error(`Rejected memory candidate cannot be promoted: ${id}`);
    }

    const byId = indexCanonicalIds(memoryDir);
    const existingPath = byId.get(id) ?? candidate.canonicalPath;
    if (candidate.lifecycle === 'promoted') {
      if (!existingPath) throw new Error(`Promoted candidate has no canonical path: ${id}`);
      return { status: 'already_promoted', candidate, canonicalPath: existingPath };
    }
    if (candidate.sensitivity === 'secret') {
      throw new Error('sensitivity "secret" is zero-retention and cannot be promoted');
    }
    if (existingPath) {
      const promoted = {
        ...candidate,
        lifecycle: 'promoted' as const,
        canonicalPath: existingPath,
        updatedAt: options.now ?? new Date().toISOString(),
      };
      store.updateMemoryCandidate(promoted, { memoryDir });
      return { status: 'already_promoted', candidate: promoted, canonicalPath: existingPath };
    }

    const updatedAt = options.now ?? new Date().toISOString();
    const memory: MemoryObject = {
      id: candidate.id,
      type: candidate.type,
      scope: candidate.scope,
      confidence: candidate.confidence,
      sensitivity: candidate.sensitivity,
      created: candidate.eventTime.slice(0, 10),
      lastConfirmed: candidate.eventTime.slice(0, 10),
      sources: [...new Set(candidate.evidence.map((ref) => ref.sourceRef))],
      sourceAuthority: candidate.sourceAuthority,
      trust: candidate.trust,
      eventTime: candidate.eventTime,
      proposedAt: candidate.proposedAt,
      evidence: candidate.evidence,
      subjectEntityIds: candidate.subjectEntityIds,
      extractor: candidate.extractor,
      candidateCreatedAt: candidate.createdAt,
      candidateUpdatedAt: updatedAt,
      salience: { reinforcementCount: 0 },
      body: sourceBody(candidate),
    };
    const canonicalPath = resolveTargetPath(memoryDir, memory);
    if (canonicalPath === null) {
      throw new Error(`Canonical memory ${id} appeared during promotion; retry safely`);
    }
    const absolutePath = join(memoryDir, canonicalPath);
    publishCanonicalMemory(memoryDir, canonicalPath, serializeMemoryFile(memory));
    // Confirm the bytes are readable before changing lifecycle state.
    readFileSync(absolutePath, 'utf8');

    const promoted: MemoryCandidate = {
      ...candidate,
      lifecycle: 'promoted',
      canonicalPath,
      updatedAt,
    };
    try {
      if (!store.transitionMemoryCandidate('candidate', promoted, { memoryDir })) {
        const latest = requireCandidate(store, id);
        if (latest.lifecycle === 'promoted' && latest.canonicalPath) {
          return {
            status: 'already_promoted',
            candidate: latest,
            canonicalPath: latest.canonicalPath,
          };
        }
        throw new Error(`Memory candidate changed during promotion: ${id}`);
      }
    } catch (err) {
      // We exclusively created this path above. If the durable/SQLite
      // transition fails, remove the unpublished canonical truth before the
      // transaction rolls back so rejection cannot disagree with the files.
      rmSync(absolutePath, { force: true });
      const directory = openSync(dirname(absolutePath), 'r');
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
      throw err;
    }
    return { status: 'promoted', candidate: promoted, canonicalPath };
  });
}

/** Explicit review rejection. Idempotent for an already rejected candidate. */
export function rejectMemoryCandidate(
  store: SqliteStore,
  memoryDir: string,
  id: string,
  reason: string,
  options: CandidateLifecycleOptions = {},
): MemoryCandidate {
  if (!reason.trim()) throw new Error('reject requires a non-empty rejection reason');
  return store.immediateTransaction(() => {
    const candidate = requireCandidate(store, id);
    const canonicalPath = indexCanonicalIds(memoryDir).get(id);
    if (canonicalPath) {
      throw new Error(
        `Canonical memory already exists for ${id} at ${canonicalPath}; reconcile promotion before rejection`,
      );
    }
    if (candidate.lifecycle === 'promoted') {
      throw new Error(`Promoted memory candidate cannot be rejected: ${id}`);
    }
    if (candidate.lifecycle === 'rejected') return candidate;
    const rejected: MemoryCandidate = {
      ...candidate,
      lifecycle: 'rejected',
      rejectionReason: reason.trim() || 'rejected by reviewer',
      updatedAt: options.now ?? new Date().toISOString(),
    };
    if (!store.transitionMemoryCandidate('candidate', rejected, { memoryDir })) {
      const latest = requireCandidate(store, id);
      if (latest.lifecycle === 'rejected') return latest;
      throw new Error(`Memory candidate changed during rejection: ${id}`);
    }
    return rejected;
  });
}

export function rebuildDurableMemoryCandidates(
  store: SqliteStore,
  memoryDir: string,
): CandidateReplayResult {
  const result: CandidateReplayResult = { replayed: 0, skipped: 0, errors: [] };
  const durable = readDurableMemoryCandidates(memoryDir);
  result.errors.push(...durable.errors);
  for (const candidate of durable.candidates) {
    if (candidate.lifecycle === 'promoted') {
      result.skipped++;
      continue;
    }
    const existing = store.getMemoryCandidate(candidate.id);
    if (!existing) {
      store.createMemoryCandidate(candidate);
      result.replayed++;
      continue;
    }
    if (existing.lifecycle === 'promoted') {
      result.skipped++;
      continue;
    }
    store.updateMemoryCandidate(candidate);
    result.replayed++;
  }
  return result;
}
