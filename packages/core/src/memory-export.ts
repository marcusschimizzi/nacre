import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  isMemoryId,
  mintMemoryId,
  serializeMemoryFile,
  type MemoryObject,
  type MemoryObjectType,
} from './memory-file.js';
import { existingPathForId, resolveTargetPath } from './memory-promote.js';
import type { SqliteStore } from './store.js';
import type { EntityType, MemoryNode } from './types.js';

// ── Canonical export migration (V2-1 truth layer) ────────────────
//
// One-shot migration for graphs that predate the truth layer: every
// SQLite-only memory (candidate rows and legacy MCP-written nodes) gets a
// canonical file, so no durable memory is stranded in the database. Legacy
// node ids (e.g. 'n-1a2b3c') are migrated to minted mem_ ids; edges,
// embeddings, and episode links follow via renameNode.

export interface ExportCanonicalResult {
  /** Canonical files written, as memory-root-relative paths. */
  exported: string[];
  /** Legacy id migrations performed: [oldId, newId]. */
  renamed: Array<[string, string]>;
  /** Nodes already promoted / already file-backed. */
  skipped: number;
  warnings: string[];
  errors: string[];
}

const ENTITY_TO_MEMORY_TYPE: Partial<Record<EntityType, MemoryObjectType>> = {
  decision: 'decision',
  lesson: 'lesson',
};

/** SQLite-only memories: candidates, plus legacy MCP/API writes that predate node status. */
function isDatabaseOnlyMemory(node: MemoryNode): boolean {
  if (node.status === 'promoted') return false;
  if (node.status === 'candidate') return true;
  return (
    node.sourceFiles.includes('mcp') ||
    node.sourceFiles.includes('api') ||
    node.excerpts.some((e) => e.file === 'mcp' || e.file === 'api')
  );
}

export function exportCanonical(store: SqliteStore, memoryDir: string): ExportCanonicalResult {
  const result: ExportCanonicalResult = {
    exported: [],
    renamed: [],
    skipped: 0,
    warnings: [],
    errors: [],
  };

  for (const node of store.listNodes()) {
    if (!isDatabaseOnlyMemory(node)) {
      if (node.status === 'promoted') result.skipped++;
      continue;
    }

    try {
      // Full content lives in the MCP/API excerpt; the label is truncated.
      const content =
        node.excerpts.find((e) => e.file === 'mcp' || e.file === 'api')?.text ??
        node.excerpts[0]?.text ??
        node.label;

      let id = node.id;
      if (!isMemoryId(id)) {
        id = mintMemoryId();
      }

      const created = node.firstSeen.slice(0, 10);
      const memory: MemoryObject = {
        id,
        type: ENTITY_TO_MEMORY_TYPE[node.type] ?? 'fact',
        scope: 'agent',
        confidence: 1,
        sensitivity: 'low',
        created,
        lastConfirmed: node.lastReinforced.slice(0, 10),
        sources: id === node.id ? ['export:sqlite'] : [`export:sqlite:${node.id}`],
        salience: {
          reinforcementCount: node.reinforcementCount,
          lastReinforced: node.lastReinforced.slice(0, 10),
        },
        body: content.trim(),
      };

      const relPath = resolveTargetPath(memoryDir, memory);
      if (relPath === null) {
        // A canonical file with this id already exists — just reattach.
        result.skipped++;
        finalizeNode(store, node, id, existingPathForId(memoryDir, memory), result);
        continue;
      }

      const absPath = join(memoryDir, relPath);
      mkdirSync(dirname(absPath), { recursive: true });
      writeFileSync(absPath, serializeMemoryFile(memory), 'utf-8');
      result.exported.push(relPath);
      finalizeNode(store, node, id, relPath, result);
    } catch (err) {
      result.errors.push(`${node.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
}

function finalizeNode(
  store: SqliteStore,
  node: MemoryNode,
  newId: string,
  relPath: string | undefined,
  result: ExportCanonicalResult,
): void {
  if (newId !== node.id) {
    store.renameNode(node.id, newId);
    result.renamed.push([node.id, newId]);
  }
  const current = store.getNode(newId);
  if (!current) return;
  current.status = 'promoted';
  if (relPath) current.canonicalPath = relPath;
  store.putNode(current);
}
