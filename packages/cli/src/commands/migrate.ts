import { defineCommand } from 'citty';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { SqliteStore } from '@nacre/core';
import type { NacreGraph } from '@nacre/core';

export const migrateCommand = defineCommand({
  meta: {
    name: 'migrate',
    description: 'Migrate a JSON graph file to SQLite database',
  },
  args: {
    input: {
      type: 'positional',
      description: 'Path to the JSON graph file',
      required: true,
    },
    output: {
      type: 'string',
      alias: 'o',
      description: 'Output SQLite database path (default: same dir as input, .db extension)',
    },
  },
  async run({ args }) {
    const inputPath = resolve(args.input);

    if (!existsSync(inputPath)) {
      console.error(`❌ Input file not found: ${inputPath}`);
      process.exit(1);
    }

    // Determine output path
    const outputPath = args.output
      ? resolve(args.output)
      : inputPath.replace(/\.json$/, '.db');

    if (existsSync(outputPath)) {
      console.error(`⚠️  Output file already exists: ${outputPath}`);
      console.error('   Delete it first or use --output to specify a different path.');
      process.exit(1);
    }

    console.log(`📖 Reading JSON graph from ${inputPath}...`);
    const raw = readFileSync(inputPath, 'utf-8');
    const graph: NacreGraph = JSON.parse(raw);

    const nodeCount = Object.keys(graph.nodes).length;
    const edgeCount = Object.keys(graph.edges).length;
    const fileCount = graph.processedFiles.length;

    console.log(`   Found ${nodeCount} nodes, ${edgeCount} edges, ${fileCount} tracked files`);

    console.log(`💾 Creating SQLite database at ${outputPath}...`);
    const store = await SqliteStore.open(outputPath);

    console.log('📥 Importing graph...');
    store.importGraph(graph);

    // Verify
    const importedNodes = store.nodeCount();
    const importedEdges = store.edgeCount();

    console.log(`✅ Migration complete!`);
    console.log(`   Nodes: ${importedNodes} (expected ${nodeCount})`);
    console.log(`   Edges: ${importedEdges} (expected ${edgeCount})`);

    if (importedNodes !== nodeCount || importedEdges !== edgeCount) {
      console.warn('⚠️  Count mismatch — some data may not have imported correctly');
    }

    store.save();
    store.close();
    console.log(`\n📁 Database saved to ${outputPath}`);
  },
});
