import { existsSync, rmSync } from 'node:fs';
import { defineCommand } from 'citty';
import { SqliteStore, compileMemoryDir, resolveProvider } from '@nacre/core';

export default defineCommand({
  meta: {
    name: 'rebuild',
    description:
      'Rebuild a graph database from a canonical memory directory (the truth layer). The store is a derived view: deleting it loses nothing this command cannot recreate.',
  },
  args: {
    'memory-dir': {
      type: 'string',
      description: 'Path to the canonical memory directory',
      required: true,
    },
    graph: {
      type: 'string',
      description: 'Path to the graph database to (re)create (.db)',
      required: true,
    },
    force: {
      type: 'boolean',
      description: 'Overwrite the graph database if it already exists',
    },
    embed: {
      type: 'boolean',
      description: 'Embed compiled memories after rebuilding (uses the configured provider)',
    },
    provider: {
      type: 'string',
      description: 'Embedding provider override for --embed: onnx, ollama, openai, mock',
    },
  },
  async run({ args }) {
    const memoryDir = args['memory-dir'] as string;
    const graphPath = args.graph as string;

    if (!graphPath.endsWith('.db')) {
      console.error('Rebuild requires a SQLite graph target (.db file)');
      process.exit(1);
    }
    if (!existsSync(memoryDir)) {
      console.error(`Memory directory not found: ${memoryDir}`);
      process.exit(1);
    }
    if (existsSync(graphPath)) {
      if (!args.force) {
        console.error(`${graphPath} already exists. Re-run with --force to overwrite it.`);
        process.exit(1);
      }
      for (const suffix of ['', '-wal', '-shm']) {
        rmSync(`${graphPath}${suffix}`, { force: true });
      }
    }

    const store = SqliteStore.open(graphPath);
    try {
      const result = compileMemoryDir(store, memoryDir);

      console.log(`Compiled ${result.files} memory files from ${memoryDir}:`);
      console.log(`  Memories:        ${result.memories}`);
      console.log(`  Entities created: ${result.entitiesCreated}`);
      console.log(`  Edges:           ${result.edges}`);

      if (result.warnings.length > 0) {
        console.log(`\nWarnings (${result.warnings.length}):`);
        for (const warning of result.warnings) console.log(`  ⚠ ${warning}`);
      }

      if (args.embed) {
        const provider = resolveProvider({
          provider: args.provider as string | undefined,
          graphPath,
        });
        if (!provider) {
          console.error(
            '\n--embed requires a provider. Set one via --provider, nacre.config.json, or NACRE_EMBEDDING_PROVIDER.',
          );
          process.exit(1);
        }
        console.log(`\nEmbedding with ${provider.name} (${provider.dimensions} dims)…`);
        let embedded = 0;
        for (const node of store.listNodes()) {
          const text = `${node.label} — ${node.excerpts.map((e) => e.text).join('. ')}`;
          const vector = await provider.embed(text);
          store.putEmbedding(node.id, 'node', text, vector, provider.name);
          embedded++;
        }
        store.setMeta('embedding_provider', provider.name);
        store.setMeta('embedding_dimensions', String(provider.dimensions));
        console.log(`Embedded ${embedded} nodes (encoder: ${store.getEncoderFingerprint()}).`);
      }

      if (result.errors.length > 0) {
        console.error(`\nErrors (${result.errors.length}) — these files were NOT compiled:`);
        for (const error of result.errors) console.error(`  ✖ ${error}`);
        console.error('\nRebuild is incomplete until these files parse. Fix them and re-run.');
        process.exit(1);
      }

      console.log('\nRebuild complete.');
    } finally {
      store.close();
    }
  },
});
