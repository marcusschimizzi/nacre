import { appendTombstone, tombstonedIds } from './capture.js';
import { compileMemoryDir, type CompileMemoryResult } from './memory-compile.js';
import { promoteCaptured, type PromoteResult } from './memory-promote.js';
import { writeBackSalience, type SalienceWriteBackResult } from './memory-salience.js';
import { SESSION_SCOPE, scopePolicy, type ScopePolicyOverrides } from './scopes.js';
import type { SqliteStore } from './store.js';

// ── Truth-layer consolidation sequence (V2-1) ────────────────────
//
// The one canonical ordering, shared by every consolidation surface (CLI,
// REST, future hooks): promote spooled captures to canonical files, write
// accumulated salience back into frontmatter BEFORE compiling (so files
// carry it and the compile reads it back as truth), then compile the
// directory into the derived store.

export interface TruthLayerOptions {
  /** Per-scope policy overrides (nacre.config.json → scopes). */
  scopeOverrides?: ScopePolicyOverrides;
  /** Purge clock; defaults to now. */
  now?: Date;
}

export interface ScratchPurgeResult {
  nodes: number;
  episodes: number;
  procedures: number;
}

export interface TruthLayerResult {
  promotion: PromoteResult;
  salience: SalienceWriteBackResult;
  compiled: CompileMemoryResult;
  /** Session-scoped rows past their retention window, removed this run (D4). */
  purged: ScratchPurgeResult;
  /** All stage warnings, in stage order. */
  warnings: string[];
  /** All stage errors, in stage order — entries/files that were NOT processed. */
  errors: string[];
}

/**
 * Session scratch expires: remove session-scoped rows whose last use is older
 * than the scope's retention window. Nothing durable is ever touched — only
 * scope === 'session', which by construction has no file or spool presence.
 */
export function purgeExpiredScratch(
  store: SqliteStore,
  overrides?: ScopePolicyOverrides,
  now: Date = new Date(),
): ScratchPurgeResult {
  const purged: ScratchPurgeResult = { nodes: 0, episodes: 0, procedures: 0 };
  const retention = scopePolicy(SESSION_SCOPE, overrides).retentionDays;
  if (retention === null) return purged;
  const cutoff = new Date(now.getTime() - retention * 86_400_000).toISOString();

  for (const node of store.listNodes()) {
    if (node.scope !== SESSION_SCOPE) continue;
    if (node.lastReinforced >= cutoff) continue;
    store.deleteNode(node.id);
    store.deleteEmbedding(node.id);
    purged.nodes++;
  }
  for (const episode of store.listEpisodes()) {
    if (episode.scope !== SESSION_SCOPE) continue;
    if ((episode.lastAccessed || episode.timestamp) >= cutoff) continue;
    store.deleteEpisode(episode.id);
    purged.episodes++;
  }
  for (const procedure of store.listProcedures()) {
    if (procedure.scope !== SESSION_SCOPE) continue;
    if (procedure.updatedAt >= cutoff) continue;
    store.deleteProcedure(procedure.id);
    purged.procedures++;
  }
  return purged;
}

export function consolidateTruthLayer(
  store: SqliteStore,
  memoryDir: string,
  opts?: TruthLayerOptions,
): TruthLayerResult {
  // Migrate store-side forget records (written when no memory dir resolved
  // at forget time, or a different one did) into THIS spool, so the forget
  // becomes durable and git-synced wherever the truth layer now lives.
  const spooled = tombstonedIds(memoryDir);
  for (const record of store.listForgotten()) {
    if (!spooled.has(record.id)) {
      appendTombstone(memoryDir, { op: 'forget', ...record });
    }
  }

  const promotion = promoteCaptured(store, memoryDir);
  const salience = writeBackSalience(store, memoryDir);
  const compiled = compileMemoryDir(store, memoryDir);
  const purged = purgeExpiredScratch(store, opts?.scopeOverrides, opts?.now);
  return {
    promotion,
    salience,
    compiled,
    purged,
    warnings: [...promotion.warnings, ...salience.warnings, ...compiled.warnings],
    errors: [...promotion.errors, ...salience.errors, ...compiled.errors],
  };
}
