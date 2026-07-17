import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CAPTURE_DIR, captureFileFor, readCaptureEntries } from './capture.js';
import { generateEdgeId, generateNodeId } from './graph.js';
import { MemoryFileError, parseMemoryFile } from './memory-file.js';
import { canonicalIdFor } from './memory-promote.js';
import type { SqliteStore } from './store.js';
import type { EntityType, MemoryNode } from './types.js';

// ── Memory-dir compiler (V2-1 truth layer) ───────────────────────
//
// Compiles a canonical memory directory (one markdown file per memory, see
// memory-file.ts) into the derived SQLite view. Deterministic: same directory
// contents → same nodes/edges, regardless of machine or run order. Timestamps
// come from the files themselves, never from the clock.

export interface CompileMemoryResult {
  /** Canonical files parsed successfully. */
  files: number;
  /** Memory nodes upserted. */
  memories: number;
  /** Entity nodes created for wikilink targets that didn't exist yet. */
  entitiesCreated: number;
  /** Explicit memory→entity edges created or reinforced. */
  edges: number;
  /** Recoverable issues (per-file, prefixed with the file path). */
  warnings: string[];
  /** Files that failed to parse — reported, never silently skipped. */
  errors: string[];
}

/** How canonical memory types project onto the entity graph's node types. */
const MEMORY_TYPE_TO_ENTITY: Record<string, EntityType> = {
  decision: 'decision',
  lesson: 'lesson',
  fact: 'concept',
  claim: 'concept',
  preference: 'concept',
};

const LABEL_MAX = 120;
const EXCERPT_MAX = 200;

/** Recursively list canonical memory files, sorted for deterministic compile order. */
export function listMemoryFiles(memoryDir: string, subdir = ''): string[] {
  const result: string[] = [];
  const entries = readdirSync(join(memoryDir, subdir), { withFileTypes: true });
  for (const entry of entries) {
    // Dot-directories (.capture, .git, .obsidian) are not canonical memory.
    if (entry.name.startsWith('.')) continue;
    const rel = subdir ? `${subdir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      result.push(...listMemoryFiles(memoryDir, rel));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      result.push(rel);
    }
  }
  return result.sort();
}

/**
 * Compile every canonical memory file under `memoryDir` into the store.
 * Malformed files land in `errors` (the caller decides whether that fails the
 * run); recoverable issues land in `warnings`. Existing rows with the same
 * ids are overwritten — the files are the truth, the store is the view.
 */
export function compileMemoryDir(store: SqliteStore, memoryDir: string): CompileMemoryResult {
  const result: CompileMemoryResult = {
    files: 0,
    memories: 0,
    entitiesCreated: 0,
    edges: 0,
    warnings: [],
    errors: [],
  };

  for (const relPath of listMemoryFiles(memoryDir)) {
    let content: string;
    try {
      content = readFileSync(join(memoryDir, relPath), 'utf-8');
    } catch (err) {
      result.errors.push(`${relPath}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    try {
      const parsed = parseMemoryFile(content, relPath);
      result.files++;
      for (const warning of parsed.warnings) {
        result.warnings.push(`${relPath}: ${warning}`);
      }
      compileMemory(store, parsed, relPath, result);
    } catch (err) {
      if (err instanceof MemoryFileError) {
        result.errors.push(`${relPath}: ${err.message}`);
      } else {
        throw err;
      }
    }
  }

  return result;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export interface ReplayCaptureResult {
  /** Candidate nodes recreated from unpromoted spool entries. */
  candidates: number;
  /** Entries already present in the store (promoted or previously replayed). */
  skipped: number;
  /** Explicit edges recreated from capture links. */
  edges: number;
  errors: string[];
}

/**
 * Replay unpromoted capture entries as candidate rows. Together with
 * compileMemoryDir this completes the rebuild contract: canonical files plus
 * the spool are the only durable state, so a rebuilt store must contain
 * candidates for every entry that has not yet been promoted to a file.
 */
export function replayCaptureCandidates(
  store: SqliteStore,
  memoryDir: string,
): ReplayCaptureResult {
  const result: ReplayCaptureResult = { candidates: 0, skipped: 0, edges: 0, errors: [] };
  const { entries, errors } = readCaptureEntries(memoryDir);
  result.errors.push(...errors);

  for (const entry of entries) {
    // Same id normalization as promotion, so a rebuilt candidate and its
    // eventual canonical file share one identity even for malformed spool ids.
    const id = canonicalIdFor(entry);

    // Promoted entries were compiled from their canonical file (same id);
    // already-replayed ones are equally present. Never double-create.
    if (store.getNode(id)) {
      result.skipped++;
      continue;
    }

    const spoolFile = `${CAPTURE_DIR}/${captureFileFor(entry.ts)}`;
    const date = entry.ts.slice(0, 10);
    store.putNode({
      id,
      label: truncate(entry.payload.content, LABEL_MAX),
      aliases: [],
      type: MEMORY_TYPE_TO_ENTITY[entry.payload.type] ?? 'concept',
      firstSeen: entry.ts,
      lastReinforced: entry.ts,
      mentionCount: 1,
      reinforcementCount: 0,
      sourceFiles: [spoolFile],
      excerpts: [{ file: spoolFile, text: entry.payload.content, date }],
      status: 'candidate',
    });
    result.candidates++;

    for (const target of entry.payload.links ?? []) {
      const entity = store.findNode(target);
      if (!entity) continue;
      const edgeId = generateEdgeId(id, entity.id, 'explicit');
      if (store.getEdge(edgeId)) continue;
      store.putEdge({
        id: edgeId,
        source: id,
        target: entity.id,
        type: 'explicit',
        directed: false,
        weight: 0.8,
        baseWeight: 0.8,
        reinforcementCount: 1,
        firstFormed: date,
        lastReinforced: date,
        stability: 1.0,
        evidence: [
          { file: spoolFile, date, context: truncate(entry.payload.content, EXCERPT_MAX) },
        ],
      });
      result.edges++;
    }
  }

  return result;
}

/**
 * Verbatim recall: read a promoted memory's claim and `## Source` evidence
 * straight from its canonical file — exact identifiers survive even when the
 * compiled label/excerpt truncated them. Undefined if the file is missing or
 * unparseable (callers degrade to the compiled view).
 */
export function readMemorySource(
  memoryDir: string,
  canonicalPath: string,
): { claim: string; source?: string } | undefined {
  try {
    const parsed = parseMemoryFile(
      readFileSync(join(memoryDir, canonicalPath), 'utf-8'),
      canonicalPath,
    );
    return { claim: parsed.claim, source: parsed.source };
  } catch {
    return undefined;
  }
}

function compileMemory(
  store: SqliteStore,
  parsed: ReturnType<typeof parseMemoryFile>,
  relPath: string,
  result: CompileMemoryResult,
): void {
  const { memory, claim, wikilinks } = parsed;
  const lastReinforced = memory.salience.lastReinforced ?? memory.lastConfirmed;

  // The memory keeps its minted id — stable across claim edits and file
  // renames — rather than a label-derived hash.
  const memoryNode: MemoryNode = {
    id: memory.id,
    label: truncate(claim || memory.id, LABEL_MAX),
    aliases: [],
    type: MEMORY_TYPE_TO_ENTITY[memory.type] ?? 'concept',
    firstSeen: memory.created,
    lastReinforced,
    mentionCount: 1,
    reinforcementCount: memory.salience.reinforcementCount,
    sourceFiles: [relPath],
    excerpts: [{ file: relPath, text: truncate(claim, EXCERPT_MAX), date: memory.created }],
    status: 'promoted',
    canonicalPath: relPath,
  };
  store.putNode(memoryNode);
  result.memories++;

  for (const target of wikilinks) {
    let entity = store.findNode(target);
    if (!entity) {
      entity = {
        id: generateNodeId(target),
        label: target,
        aliases: [],
        type: 'concept',
        firstSeen: memory.created,
        lastReinforced,
        mentionCount: 1,
        reinforcementCount: 0,
        sourceFiles: [relPath],
        excerpts: [],
      };
      store.putNode(entity);
      result.entitiesCreated++;
    }

    const edgeId = generateEdgeId(memory.id, entity.id, 'explicit');
    const existing = store.getEdge(edgeId);
    if (existing) {
      if (!existing.evidence.some((e) => e.file === relPath)) {
        existing.evidence.push({
          file: relPath,
          date: memory.created,
          context: truncate(claim, EXCERPT_MAX),
        });
        existing.reinforcementCount += 1;
        if (existing.lastReinforced < lastReinforced) existing.lastReinforced = lastReinforced;
        store.putEdge(existing);
        result.edges++;
      }
    } else {
      store.putEdge({
        id: edgeId,
        source: memory.id,
        target: entity.id,
        type: 'explicit',
        directed: false,
        weight: 0.8,
        baseWeight: 0.8,
        reinforcementCount: 1,
        firstFormed: memory.created,
        lastReinforced,
        stability: 1.0,
        evidence: [{ file: relPath, date: memory.created, context: truncate(claim, EXCERPT_MAX) }],
      });
      result.edges++;
    }
  }
}
