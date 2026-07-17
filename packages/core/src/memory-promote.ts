import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { captureFileFor, readCaptureEntries, type CaptureEntry } from './capture.js';
import {
  MEMORY_OBJECT_TYPES,
  MemoryFileError,
  isMemoryId,
  isValidScope,
  memoryFilePath,
  parseMemoryFile,
  serializeMemoryFile,
  type MemoryObject,
  type MemoryObjectType,
} from './memory-file.js';
import type { SqliteStore } from './store.js';

// ── Capture → canonical promotion (V2-1 truth layer) ─────────────
//
// The consolidation-time step that materializes canonical memory files for
// spooled capture entries. This is the ONLY path from Tier 1 (capture) into
// Tier 2 (canonical markdown). Idempotent: an entry whose canonical file
// already exists is never rewritten — once a file exists, the file is the
// truth and hand edits must survive re-promotion.

export interface PromoteResult {
  /** Canonical files written this run. */
  promoted: string[];
  /** Entries whose canonical file already existed (or node already promoted). */
  skipped: number;
  warnings: string[];
  /** Spool read errors plus per-entry failures. */
  errors: string[];
}

/** Fallback when a capture entry has no scope: agent-local, the narrowest durable scope. */
const DEFAULT_SCOPE = 'agent';

/**
 * The id a spool entry promotes under. Well-formed ids pass through; a
 * malformed id (a canonical file must never be written unparseable) maps to a
 * DETERMINISTIC replacement — hash of old id + timestamp — so repeated
 * consolidations converge on one file instead of minting fresh ids per run.
 */
export function canonicalIdFor(entry: CaptureEntry): string {
  if (isMemoryId(entry.id)) return entry.id;
  return `mem_${createHash('sha256').update(`${entry.id}|${entry.ts}`).digest('hex').slice(0, 12)}`;
}

export function promoteCaptured(store: SqliteStore, memoryDir: string): PromoteResult {
  const result: PromoteResult = { promoted: [], skipped: 0, warnings: [], errors: [] };
  const { entries, tombstones, errors } = readCaptureEntries(memoryDir);
  result.errors.push(...errors);
  const forgotten = new Set(tombstones.map((t) => t.id));

  for (const entry of entries) {
    try {
      const id = canonicalIdFor(entry);
      // Explicitly forgotten — never resurrect from the spool.
      if (forgotten.has(id)) {
        result.skipped++;
        continue;
      }
      if (id !== entry.id) {
        result.warnings.push(`${entry.id}: malformed capture id — promoting as ${id}`);
        if (store.getNode(entry.id) && !store.getNode(id)) {
          store.renameNode(entry.id, id);
        }
      }
      const node = store.getNode(id);

      if (node?.status === 'promoted' && node.canonicalPath) {
        result.skipped++;
        continue;
      }

      const rawType = entry.payload.type;
      const type: MemoryObjectType = MEMORY_OBJECT_TYPES.includes(rawType) ? rawType : 'fact';
      if (type !== rawType) {
        result.warnings.push(`${entry.id}: unknown memory type "${rawType}" — promoted as fact`);
      }

      let scope = DEFAULT_SCOPE;
      if (entry.payload.scope) {
        if (isValidScope(entry.payload.scope)) {
          scope = entry.payload.scope;
        } else {
          result.warnings.push(
            `${entry.id}: invalid scope "${entry.payload.scope}" — promoted as ${DEFAULT_SCOPE}`,
          );
        }
      }

      const date = entry.ts.slice(0, 10);
      let body = entry.payload.content.trim();
      const links = entry.payload.links?.filter((l) => l.trim().length > 0) ?? [];
      if (links.length > 0) {
        body += `\n\nRelated: ${links.map((l) => `[[${l}]]`).join(', ')}`;
      }

      const memory: MemoryObject = {
        id,
        type,
        scope,
        confidence: 1,
        sensitivity: 'low',
        created: date,
        lastConfirmed: date,
        sources: [`capture:${captureFileFor(entry.ts)}`],
        salience: {
          reinforcementCount: node?.reinforcementCount ?? 0,
          ...(node ? { lastReinforced: node.lastReinforced.slice(0, 10) } : {}),
        },
        body,
      };

      const relPath = resolveTargetPath(memoryDir, memory);
      if (relPath === null) {
        // A canonical file with this id already exists — the file is the truth.
        result.skipped++;
        markPromoted(store, id, existingPathForId(memoryDir, memory));
        continue;
      }

      const absPath = join(memoryDir, relPath);
      mkdirSync(dirname(absPath), { recursive: true });
      writeFileSync(absPath, serializeMemoryFile(memory), 'utf-8');
      result.promoted.push(relPath);
      markPromoted(store, id, relPath);
    } catch (err) {
      result.errors.push(`${entry.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
}

function markPromoted(store: SqliteStore, id: string, relPath: string | undefined): void {
  const node = store.getNode(id);
  if (!node) return;
  node.status = 'promoted';
  if (relPath) node.canonicalPath = relPath;
  store.putNode(node);
}

/**
 * Where to write the canonical file: the slug path, or a -2/-3 suffix when a
 * *different* memory already owns it. Null when a file with this same id
 * already exists (never overwrite — hand edits are truth). An existing file
 * that fails to parse is a hard error: silently suffixing past it would pile
 * up duplicate files on every consolidation while the broken file stays
 * invisible.
 */
export function resolveTargetPath(memoryDir: string, memory: MemoryObject): string | null {
  const base = memoryFilePath(memory);
  const stem = base.slice(0, -'.md'.length);
  for (let i = 1; i < 100; i++) {
    const candidate = i === 1 ? base : `${stem}-${i}.md`;
    const abs = join(memoryDir, candidate);
    if (!existsSync(abs)) return candidate;
    if (fileIdAt(abs, candidate) === memory.id) return null;
  }
  throw new Error(`Could not find a free filename for ${memory.id} near ${base}`);
}

export function existingPathForId(memoryDir: string, memory: MemoryObject): string | undefined {
  const base = memoryFilePath(memory);
  const stem = base.slice(0, -'.md'.length);
  for (let i = 1; i < 100; i++) {
    const candidate = i === 1 ? base : `${stem}-${i}.md`;
    const abs = join(memoryDir, candidate);
    if (!existsSync(abs)) return undefined;
    try {
      if (fileIdAt(abs, candidate) === memory.id) return candidate;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** The id owning an existing canonical file. Unparseable → MemoryFileError. */
function fileIdAt(absPath: string, relPath: string): string {
  try {
    return parseMemoryFile(readFileSync(absPath, 'utf-8'), relPath).memory.id;
  } catch (err) {
    throw new MemoryFileError(
      `existing file ${relPath} is unparseable (${err instanceof Error ? err.message : String(err)}) — fix or remove it before promotion can proceed`,
    );
  }
}
