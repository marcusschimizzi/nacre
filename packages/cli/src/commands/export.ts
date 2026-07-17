import { existsSync, mkdirSync } from 'node:fs';
import { defineCommand } from 'citty';
import { SqliteStore, exportCanonical, resolveMemoryDir } from '@nacre/core';

export default defineCommand({
  meta: {
    name: 'export',
    description:
      'Export database-only memories to canonical files (one-shot migration into the truth layer)',
  },
  args: {
    graph: {
      type: 'string',
      description: 'Path to graph database (.db)',
      required: true,
    },
    canonical: {
      type: 'boolean',
      description: 'Emit canonical memory files for every SQLite-only memory',
    },
    'memory-dir': {
      type: 'string',
      description:
        'Canonical memory directory (defaults to memory.dir from nacre.config.json, NACRE_MEMORY_DIR, or ./memory next to the graph)',
    },
  },
  run({ args }) {
    if (!args.canonical) {
      console.error('Nothing to do: pass --canonical to export memories to the truth layer.');
      process.exit(1);
    }
    const graphPath = args.graph as string;
    if (!graphPath.endsWith('.db') || !existsSync(graphPath)) {
      console.error(`Graph database not found: ${graphPath}`);
      process.exit(1);
    }

    const memoryDir = (args['memory-dir'] as string | undefined) ?? resolveMemoryDir(graphPath);
    if (!memoryDir) {
      console.error(
        'No memory directory configured. Pass --memory-dir, set memory.dir in nacre.config.json, or create ./memory next to the graph.',
      );
      process.exit(1);
    }
    mkdirSync(memoryDir, { recursive: true });

    const store = SqliteStore.open(graphPath);
    try {
      const result = exportCanonical(store, memoryDir);

      console.log(`Exported ${result.exported.length} memories to ${memoryDir}:`);
      for (const relPath of result.exported) console.log(`  + ${relPath}`);
      if (result.renamed.length > 0) {
        console.log(`\nMigrated ${result.renamed.length} legacy ids:`);
        for (const [oldId, newId] of result.renamed) console.log(`  ${oldId} → ${newId}`);
      }
      if (result.skipped > 0) {
        console.log(`\nSkipped ${result.skipped} already file-backed memories.`);
      }
      for (const warning of result.warnings) console.log(`  ⚠ ${warning}`);
      if (result.errors.length > 0) {
        for (const error of result.errors) console.error(`  ✖ ${error}`);
        process.exit(1);
      }

      console.log('\nDone. The canonical files are now the truth for these memories.');
    } finally {
      store.close();
    }
  },
});
