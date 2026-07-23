import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineCommand } from 'citty';
import {
  listMemoryFiles,
  parseMemoryFile,
  rankMemorySalience,
  SALIENCE_RECEIPT_VERSION,
  type SalienceReceipt,
} from '@nacre/core';
import { formatJSON } from '../output.js';

export interface SalienceCommandOptions {
  memoryDir: string;
  evaluatedAt: string;
  limit?: number;
}

export interface SalienceCommandResult {
  version: typeof SALIENCE_RECEIPT_VERSION;
  evaluatedAt: string;
  count: number;
  results: SalienceReceipt[];
}

export function executeSalienceCommand(options: SalienceCommandOptions): SalienceCommandResult {
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1)) {
    throw new Error('limit must be a positive integer');
  }
  const memories = listMemoryFiles(options.memoryDir).map(
    (path) => parseMemoryFile(readFileSync(join(options.memoryDir, path), 'utf8'), path).memory,
  );
  const ranked = rankMemorySalience(memories, { evaluatedAt: options.evaluatedAt });
  return {
    version: SALIENCE_RECEIPT_VERSION,
    evaluatedAt: options.evaluatedAt,
    count: ranked.length,
    results: ranked.slice(0, options.limit ?? ranked.length),
  };
}

export default defineCommand({
  meta: {
    name: 'salience',
    description:
      'Inspect deterministic salience receipts without mutating canonical or derived state',
  },
  args: {
    'memory-dir': {
      type: 'string',
      description: 'Canonical memory root',
      required: true,
    },
    at: {
      type: 'string',
      description: 'Strict ISO evaluation timestamp',
      required: true,
    },
    limit: {
      type: 'string',
      description: 'Maximum receipts to return',
    },
  },
  run({ args }) {
    const rawLimit = args.limit as string | undefined;
    const limit = rawLimit === undefined ? undefined : Number(rawLimit);
    console.log(
      formatJSON(
        executeSalienceCommand({
          memoryDir: args['memory-dir'] as string,
          evaluatedAt: args.at as string,
          limit,
        }),
      ),
    );
  },
});
