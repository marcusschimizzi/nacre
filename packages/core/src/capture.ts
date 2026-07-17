import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { MemoryObjectType } from './memory-file.js';

// ── Capture spool (V2-1 truth layer, Tier 1) ─────────────────────
//
// Durable WAL for MCP/API memory writes: append-only JSONL under
// <memoryDir>/.capture/, one file per UTC day. Append is the only operation
// on the write path — no parsing, no network, no LLM. Consolidation is the
// only promotion path from here into canonical memory files.

export const CAPTURE_DIR = '.capture';

export interface CaptureEntry {
  /**
   * The memory's stable id, minted at capture so the immediately-compiled
   * candidate row and the later canonical file share one identity.
   */
  id: string;
  /** ISO timestamp of the capture. */
  ts: string;
  /** Where the write came from, e.g. 'mcp', 'api', 'cli'. */
  origin: string;
  tool?: string;
  agent?: string;
  sessionId?: string;
  payload: {
    content: string;
    type: MemoryObjectType;
    scope?: string;
    context?: string;
    links?: string[];
  };
}

/** Spool filename (relative to the capture dir) for a given ISO timestamp. */
export function captureFileFor(ts: string): string {
  return `${ts.slice(0, 10)}.jsonl`;
}

/**
 * Append an entry to the spool. The durable act of a two-phase memory write —
 * everything else (candidate row, embedding, promotion) can be recovered from
 * here.
 */
export function appendCapture(memoryDir: string, entry: CaptureEntry): string {
  const dir = join(memoryDir, CAPTURE_DIR);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, captureFileFor(entry.ts));
  appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf-8');
  return file;
}

export interface ReadCaptureResult {
  entries: CaptureEntry[];
  /** Unparseable spool lines, reported as '<file>:<line>: <reason>' — never silently dropped. */
  errors: string[];
}

/** Read every spool entry in chronological order (file name, then line order). */
export function readCaptureEntries(memoryDir: string): ReadCaptureResult {
  const dir = join(memoryDir, CAPTURE_DIR);
  const result: ReadCaptureResult = { entries: [], errors: [] };
  if (!existsSync(dir)) return result;

  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort();

  for (const file of files) {
    const lines = readFileSync(join(dir, file), 'utf-8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as CaptureEntry;
        if (
          typeof parsed.id !== 'string' ||
          typeof parsed.ts !== 'string' ||
          typeof parsed.payload?.content !== 'string'
        ) {
          result.errors.push(`${file}:${i + 1}: missing id/ts/payload.content`);
          continue;
        }
        result.entries.push(parsed);
      } catch (err) {
        result.errors.push(`${file}:${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return result;
}
