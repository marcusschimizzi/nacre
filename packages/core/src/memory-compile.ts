import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  CAPTURE_DIR,
  appendTombstone,
  canonicalIdFor,
  captureFileFor,
  readCaptureEntries,
  tombstonedIds,
} from './capture.js';
import { generateEdgeId, generateNodeId } from './graph.js';
import { MemoryFileError, parseMemoryFile } from './memory-file.js';
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
  /** Promoted rows deleted because their canonical file no longer exists. */
  removed: number;
  /** Stale explicit edges deleted because their [[link]] was edited out of a file. */
  edgesRemoved: number;
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
  // A configured-but-not-yet-created memory dir is an empty truth layer,
  // not a crash.
  if (!existsSync(join(memoryDir, subdir))) return [];
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
    removed: 0,
    edgesRemoved: 0,
    warnings: [],
    errors: [],
  };
  // Entity ids each compiled memory currently links — the file-derived truth
  // for that memory's explicit edges.
  const currentLinks = new Map<string, Set<string>>();
  const forgotten = tombstonedIds(memoryDir);
  // Which memory id each compiled file currently declares — reconciliation
  // must match on id, not mere path existence, or an id edited in a file's
  // frontmatter leaves the old promoted row behind as a duplicate.
  const pathOwner = new Map<string, string>();
  // First file (sorted order) to declare each id. Two files claiming one id
  // is a broken state: the first wins deterministically, the duplicate is a
  // loud error — never a silent last-write-wins by path order.
  const idOwner = new Map<string, string>();
  // Unparseable files: identity unknown, so any row they back is preserved —
  // a syntax error must not delete the memory it backs.
  const errorPaths = new Set<string>();

  for (const relPath of listMemoryFiles(memoryDir)) {
    let content: string;
    try {
      content = readFileSync(join(memoryDir, relPath), 'utf-8');
    } catch (err) {
      result.errors.push(`${relPath}: ${err instanceof Error ? err.message : String(err)}`);
      errorPaths.add(relPath);
      continue;
    }

    try {
      const parsed = parseMemoryFile(content, relPath);
      // A tombstoned memory whose file reappeared (e.g. synced back in from
      // another device after a local forget) must not be resurrected. The
      // stray file is surfaced for the human to delete.
      if (forgotten.has(parsed.memory.id)) {
        result.warnings.push(
          `${relPath}: memory ${parsed.memory.id} was forgotten (tombstoned) — file skipped; remove it`,
        );
        continue;
      }
      const firstPath = idOwner.get(parsed.memory.id);
      if (firstPath) {
        result.errors.push(
          `${relPath}: duplicate memory id ${parsed.memory.id} (already declared by ${firstPath}) — remove one of the files`,
        );
        continue;
      }
      idOwner.set(parsed.memory.id, relPath);
      result.files++;
      pathOwner.set(relPath, parsed.memory.id);
      for (const warning of parsed.warnings) {
        result.warnings.push(`${relPath}: ${warning}`);
      }
      compileMemory(store, parsed, relPath, result, currentLinks);
    } catch (err) {
      if (err instanceof MemoryFileError) {
        result.errors.push(`${relPath}: ${err.message}`);
        errorPaths.add(relPath);
      } else {
        throw err;
      }
    }
  }

  // Wikilink edges are file-derived state: a [[link]] edited out of a file
  // takes its edge with it. Only edges touching a memory compiled THIS run
  // are candidates — entity↔entity edges from raw ingestion, and edges of
  // candidate (not yet file-backed) memories, are untouched.
  for (const edge of store.listEdges({ type: 'explicit' })) {
    const sourceLinks = currentLinks.get(edge.source);
    const targetLinks = currentLinks.get(edge.target);
    if (!sourceLinks && !targetLinks) continue;
    const kept = sourceLinks?.has(edge.target) || targetLinks?.has(edge.source);
    if (!kept) {
      store.deleteEdge(edge.id);
      result.edgesRemoved++;
    }
  }

  // Files are the truth in both directions: a promoted row whose canonical
  // file is gone (deleted by hand or via git sync) — or whose file now
  // declares a DIFFERENT id (frontmatter edited) — must leave the store, or
  // stale memories stay recallable forever. Removals are tombstoned;
  // otherwise the original spool entry would re-promote the memory and
  // recreate the file on the next consolidation.
  for (const node of store.listNodes()) {
    if (node.status !== 'promoted' || !node.canonicalPath) continue;
    if (errorPaths.has(node.canonicalPath)) continue;
    const owner = pathOwner.get(node.canonicalPath);
    if (owner === node.id) continue;
    store.deleteNode(node.id);
    store.deleteEmbedding(node.id);
    if (!forgotten.has(node.id)) {
      appendTombstone(memoryDir, {
        op: 'forget',
        id: node.id,
        ts: new Date().toISOString(),
        origin: 'reconcile',
        reason: owner
          ? `canonical file ${node.canonicalPath} now declares id ${owner}`
          : `canonical file removed: ${node.canonicalPath}`,
      });
    }
    result.removed++;
    result.warnings.push(
      owner
        ? `${node.canonicalPath}: file id changed to ${owner} — deleted stale promoted row ${node.id} (tombstoned)`
        : `${node.canonicalPath}: canonical file removed — deleted promoted memory ${node.id} from the store (tombstoned)`,
    );
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
  const { entries, tombstones, errors } = readCaptureEntries(memoryDir);
  result.errors.push(...errors);
  const forgotten = new Set(tombstones.map((t) => t.id));

  for (const entry of entries) {
    // Same id normalization as promotion, so a rebuilt candidate and its
    // eventual canonical file share one identity even for malformed spool ids.
    const id = canonicalIdFor(entry);

    // Explicitly forgotten — a rebuild must not resurrect it.
    if (forgotten.has(id)) {
      result.skipped++;
      continue;
    }

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
  currentLinks: Map<string, Set<string>>,
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

  const linked = new Set<string>();
  currentLinks.set(memory.id, linked);

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
    linked.add(entity.id);

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
