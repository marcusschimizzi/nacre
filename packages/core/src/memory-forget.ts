import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { appendTombstone } from './capture.js';
import { SESSION_SCOPE } from './scopes.js';
import type { SqliteStore } from './store.js';

// ── Truth-layer-aware forgetting (V2-1) ──────────────────────────
//
// Forgetting is a truth-layer operation, not a row delete. A forgotten memory
// must be verifiably absent after any consolidate or rebuild, so forgetting
// removes every representation: the store row, the embedding, the canonical
// file (a git-visible deletion), and — because spool entries are append-only
// and may be git-synced from other devices — an appended tombstone that
// promotion, replay, and compile all honor.

export interface ForgetOptions {
  /** ISO timestamp of the forget action. */
  ts: string;
  origin: string;
  reason?: string;
}

export interface ForgetResult {
  nodeDeleted: boolean;
  embeddingDeleted: boolean;
  /** Canonical file removed, if the memory was promoted. */
  fileDeleted?: string;
  /** Whether a tombstone was appended (false when no memory dir is configured). */
  tombstoned: boolean;
}

export function forgetMemory(
  store: SqliteStore,
  memoryDir: string | null,
  id: string,
  opts: ForgetOptions,
): ForgetResult {
  const node = store.getNode(id);
  const result: ForgetResult = {
    nodeDeleted: Boolean(node),
    embeddingDeleted: Boolean(store.getEmbedding(id)),
    tombstoned: false,
  };

  if (memoryDir && node?.canonicalPath) {
    const abs = join(memoryDir, node.canonicalPath);
    if (existsSync(abs)) {
      rmSync(abs);
      result.fileDeleted = node.canonicalPath;
    }
  }

  if (node) store.deleteNode(id);
  store.deleteEmbedding(id);

  // Session scratch has no file, no spool entry, and nothing that could ever
  // resurrect it — deleting the row is complete. Writing durable tombstones
  // for ephemeral scratch would leak its existence into the synced spool and
  // grow the forgotten set forever.
  if (node?.scope === SESSION_SCOPE) {
    return result;
  }

  // Always record the forget in the store: a spool tombstone can only be
  // written when a memory dir resolves HERE and NOW, but the spool entry may
  // live in a dir that resolves later (or elsewhere). Promotion, replay, and
  // compile honor store-side records too, and consolidation migrates them
  // into the spool so they become durable and git-synced.
  store.recordForgotten({
    id,
    ts: opts.ts,
    origin: opts.origin,
    ...(opts.reason ? { reason: opts.reason } : {}),
  });

  if (memoryDir) {
    appendTombstone(memoryDir, {
      op: 'forget',
      id,
      ts: opts.ts,
      origin: opts.origin,
      ...(opts.reason ? { reason: opts.reason } : {}),
    });
    result.tombstoned = true;
  }

  return result;
}
