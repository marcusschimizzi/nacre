import { compileMemoryDir, type CompileMemoryResult } from './memory-compile.js';
import { promoteCaptured, type PromoteResult } from './memory-promote.js';
import { writeBackSalience, type SalienceWriteBackResult } from './memory-salience.js';
import type { SqliteStore } from './store.js';

// ── Truth-layer consolidation sequence (V2-1) ────────────────────
//
// The one canonical ordering, shared by every consolidation surface (CLI,
// REST, future hooks): promote spooled captures to canonical files, write
// accumulated salience back into frontmatter BEFORE compiling (so files
// carry it and the compile reads it back as truth), then compile the
// directory into the derived store.

export interface TruthLayerResult {
  promotion: PromoteResult;
  salience: SalienceWriteBackResult;
  compiled: CompileMemoryResult;
  /** All stage warnings, in stage order. */
  warnings: string[];
  /** All stage errors, in stage order — entries/files that were NOT processed. */
  errors: string[];
}

export function consolidateTruthLayer(store: SqliteStore, memoryDir: string): TruthLayerResult {
  const promotion = promoteCaptured(store, memoryDir);
  const salience = writeBackSalience(store, memoryDir);
  const compiled = compileMemoryDir(store, memoryDir);
  return {
    promotion,
    salience,
    compiled,
    warnings: [...promotion.warnings, ...salience.warnings, ...compiled.warnings],
    errors: [...promotion.errors, ...salience.errors, ...compiled.errors],
  };
}
