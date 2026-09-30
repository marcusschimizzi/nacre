import { defineCommand } from 'citty';
import { existsSync } from 'node:fs';
import { SqliteStore, type AdmissionReceipt } from '@nacre/core';
import { formatJSON } from '../output.js';

export interface ReceiptsCommandOptions {
  graphPath: string;
  id?: string;
  kind?: AdmissionReceipt['kind'];
  limit?: number;
}

export interface ReceiptSummary {
  id: string;
  kind: AdmissionReceipt['kind'];
  evaluatedAt: string;
  included: number;
  rejected: number;
}

export function executeReceiptsCommand(
  options: ReceiptsCommandOptions,
): AdmissionReceipt | ReceiptSummary[] {
  if (!options.graphPath.endsWith('.db')) throw new Error('receipts requires a SQLite --graph');
  if (options.kind !== undefined && options.kind !== 'brief' && options.kind !== 'recall')
    throw new Error('receipt list kind must be brief or recall');
  if (options.id !== undefined && !/^rcpt_[0-9a-f]{64}$/.test(options.id))
    throw new Error('receipt id must be rcpt_<64 lowercase hex>');
  if (
    options.limit !== undefined &&
    (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 1000)
  )
    throw new Error('receipt list limit must be an integer from 1 to 1000');
  if (!existsSync(options.graphPath))
    throw new Error(`Graph database not found: ${options.graphPath}`);
  const store = SqliteStore.open(options.graphPath);
  try {
    if (options.id) {
      const receipt = store.getAdmissionReceipt(options.id);
      if (!receipt) throw new Error(`Admission receipt not found: ${options.id}`);
      return receipt;
    }
    return store
      .listAdmissionReceipts({ kind: options.kind, limit: options.limit })
      .map((receipt) => ({
        id: receipt.id,
        kind: receipt.kind,
        evaluatedAt: receipt.evaluatedAt,
        included: receipt.included.length,
        rejected: receipt.rejected.length,
      }));
  } finally {
    store.close();
  }
}

export default defineCommand({
  meta: { name: 'receipts', description: 'List or inspect persisted admission receipts' },
  args: {
    graph: { type: 'string', description: 'Path to graph database (.db)', required: true },
    id: { type: 'string', description: 'Full admission receipt id' },
    kind: { type: 'string', description: 'Filter list by brief or recall' },
    limit: { type: 'string', description: 'Maximum receipts to list', default: '100' },
  },
  run({ args }) {
    console.log(
      formatJSON(
        executeReceiptsCommand({
          graphPath: args.graph as string,
          id: args.id as string | undefined,
          kind: args.kind as AdmissionReceipt['kind'] | undefined,
          limit: Number(args.limit),
        }),
      ),
    );
  },
});
