import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryFileError, parseMemoryFile, serializeMemoryFile } from './memory-file.js';
import type { SqliteStore } from './store.js';

// ── Salience write-back (V2-1 truth layer) ───────────────────────
//
// Reinforcement accumulates in the store between consolidations (feedback,
// recall-driven strengthening). This step batches it back into canonical
// frontmatter so salience is shared-durable — it travels through git and
// survives rebuilds. Runs ONLY at consolidation, before compile, so local
// increments reach the file before the file is read back as truth.
//
// Merge is monotone (max count, later date): a higher count synced in from
// another device is never regressed by a stale local store.

export interface SalienceWriteBackResult {
  /** Canonical files whose frontmatter was updated. */
  updated: string[];
  /** Promoted nodes whose files already matched (no write, no git churn). */
  unchanged: number;
  warnings: string[];
  errors: string[];
}

export function writeBackSalience(store: SqliteStore, memoryDir: string): SalienceWriteBackResult {
  const result: SalienceWriteBackResult = { updated: [], unchanged: 0, warnings: [], errors: [] };

  for (const node of store.listNodes()) {
    if (node.status !== 'promoted' || !node.canonicalPath) continue;

    const absPath = join(memoryDir, node.canonicalPath);
    if (!existsSync(absPath)) {
      result.warnings.push(
        `${node.id}: canonical file missing (${node.canonicalPath}) — will re-promote or recompile`,
      );
      continue;
    }

    try {
      const parsed = parseMemoryFile(readFileSync(absPath, 'utf-8'), node.canonicalPath);
      const memory = parsed.memory;

      const mergedCount = Math.max(memory.salience.reinforcementCount, node.reinforcementCount);
      const nodeDate = node.lastReinforced.slice(0, 10);
      const fileDate = memory.salience.lastReinforced;
      const mergedDate = !fileDate || nodeDate > fileDate ? nodeDate : fileDate;

      if (
        mergedCount === memory.salience.reinforcementCount &&
        mergedDate === memory.salience.lastReinforced
      ) {
        result.unchanged++;
        continue;
      }

      memory.salience = { reinforcementCount: mergedCount, lastReinforced: mergedDate };
      writeFileSync(absPath, serializeMemoryFile(memory), 'utf-8');
      result.updated.push(node.canonicalPath);
    } catch (err) {
      if (err instanceof MemoryFileError) {
        result.errors.push(`${node.canonicalPath}: ${err.message}`);
      } else {
        throw err;
      }
    }
  }

  return result;
}
