import { defineCommand } from 'citty';
import {
  SqliteStore,
  consolidateTruthLayer,
  loadConfig,
  purgeExpiredScratch,
  resolveMemoryDir,
} from '@nacre/core';
import { consolidate } from '@nacre/parser';
import { formatConsolidationSummary } from '../output.js';

export default defineCommand({
  meta: {
    name: 'consolidate',
    description: 'Run the ingestion pipeline on markdown memory files',
  },
  args: {
    source: {
      type: 'positional',
      description: 'Input directories or files',
      required: true,
    },
    out: {
      type: 'string',
      description: 'Output path — directory for JSON (graph.json), or .db file for SQLite',
      default: 'data/graphs/default',
    },
    'entity-map': {
      type: 'string',
      description: 'Path to entity-map.json',
      default: 'data/entity-map.json',
    },
  },
  async run({ args }) {
    const inputs = [args.source as string];
    const outDir = args.out as string;
    const start = Date.now();

    console.log(`📖 Source: ${inputs[0]}`);
    console.log(`💾 Output: ${outDir} (${outDir.endsWith('.db') ? 'SQLite' : 'JSON'})`);
    console.log('');

    // The canonical memory dir is compiled by its own deterministic path
    // below — exclude it from raw ingestion so overlapping sources don't
    // create duplicate/conflicting nodes for the same files.
    const truthDir = outDir.endsWith('.db') ? resolveMemoryDir(outDir) : null;

    const result = await consolidate({
      inputs,
      outDir,
      entityMapPath: args['entity-map'] as string,
      ignore: truthDir ? [truthDir] : undefined,
    });

    // V2-1 truth layer: promote spooled capture entries to canonical memory
    // files, then compile the canonical directory into the store. This is the
    // only path from capture (Tier 1) into durable memory (Tier 2).
    if (outDir.endsWith('.db')) {
      const memoryDir = truthDir;
      if (!memoryDir) {
        // No truth layer, but session scratch still expires: the write
        // surfaces promise "expires after N days" even on database-only
        // setups, so the purge cannot be gated on a memory dir.
        const store = SqliteStore.open(outDir);
        try {
          const purged = purgeExpiredScratch(store, loadConfig(outDir).scopes);
          const total = purged.nodes + purged.episodes + purged.procedures;
          if (total > 0) {
            console.log(
              `\n🗂  Scratch: purged ${total} expired session row${total === 1 ? '' : 's'}`,
            );
          }
        } finally {
          store.close();
        }
      }
      if (memoryDir) {
        const store = SqliteStore.open(outDir);
        try {
          const truth = consolidateTruthLayer(store, memoryDir, {
            scopeOverrides: loadConfig(outDir).scopes,
          });
          const { promotion, salience, compiled } = truth;

          console.log('');
          console.log(`🗂  Truth layer (${memoryDir}):`);
          console.log(
            `   Promoted: ${promotion.promoted.length} captured → canonical (${promotion.skipped} already promoted)`,
          );
          console.log(
            `   Salience: ${salience.updated.length} files updated (${salience.unchanged} unchanged)`,
          );
          console.log(
            `   Compiled: ${compiled.memories} memories, ${compiled.entitiesCreated} new entities, ${compiled.edges} edges${
              compiled.removed > 0 ? `, ${compiled.removed} removed (files deleted)` : ''
            }${compiled.edgesRemoved > 0 ? `, ${compiled.edgesRemoved} stale edges removed` : ''}`,
          );
          const purgedTotal = truth.purged.nodes + truth.purged.episodes + truth.purged.procedures;
          if (purgedTotal > 0) {
            console.log(
              `   Scratch:  purged ${purgedTotal} expired session row${purgedTotal === 1 ? '' : 's'}`,
            );
          }
          for (const warning of truth.warnings) {
            console.log(`   ⚠ ${warning}`);
          }
          if (truth.errors.length > 0) {
            for (const error of truth.errors) console.error(`   ✖ ${error}`);
            console.error('   Truth-layer errors above — these entries/files were not processed.');
            process.exitCode = 1;
          }
        } finally {
          store.close();
        }
      }
    }

    const elapsed = Date.now() - start;
    console.log(formatConsolidationSummary(result, elapsed));
  },
});
