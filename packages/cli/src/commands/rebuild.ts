import { existsSync, rmSync } from 'node:fs';
import { defineCommand } from 'citty';
import {
  SqliteStore,
  compileMemoryDir,
  replayCaptureCandidates,
  resolveProvider,
} from '@nacre/core';

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
      // The rebuild contract covers BOTH durable tiers: canonical files and
      // the unpromoted capture spool. Replay after compile so promoted
      // entries (same id as their file) are recognized and skipped.
      const replay = replayCaptureCandidates(store, memoryDir);

      console.log(`Compiled ${result.files} memory files from ${memoryDir}:`);
      console.log(`  Memories:        ${result.memories}`);
      console.log(`  Entities created: ${result.entitiesCreated}`);
      console.log(`  Edges:           ${result.edges}`);
      console.log(
        `  Capture replay:  ${replay.candidates} unpromoted candidates (${replay.skipped} already promoted)`,
      );

      if (result.warnings.length > 0) {
        console.log(`\nWarnings (${result.warnings.length}):`);
        for (const warning of result.warnings) console.log(`  ⚠ ${warning}`);
      }

      // Fail BEFORE embedding: a partial graph must never be stamped with an
      // encoder fingerprint and left on disk looking complete. Remove the
      // partial database entirely — this command created it this run.
      const allErrors = [...result.errors, ...replay.errors];
      if (allErrors.length > 0) {
        console.error(`\nErrors (${allErrors.length}) — these files/entries were NOT compiled:`);
        for (const error of allErrors) console.error(`  ✖ ${error}`);
        console.error(
          `\nRebuild is incomplete — removing the partial database (${graphPath}). Fix the files above and re-run.`,
        );
        store.close();
        for (const suffix of ['', '-wal', '-shm']) {
          rmSync(`${graphPath}${suffix}`, { force: true });
        }
        process.exit(1);
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
        const failures: string[] = [];
        for (const node of store.listNodes()) {
          const text = `${node.label} — ${node.excerpts.map((e) => e.text).join('. ')}`;
          try {
            const vector = await provider.embed(text);
            store.putEmbedding(node.id, 'node', text, vector, provider.name);
            embedded++;
          } catch (err) {
            failures.push(`${node.id}: ${err instanceof Error ? err.message : String(err)}`);
            if (failures.length >= 5) {
              failures.push('(giving up — provider appears to be down)');
              break;
            }
          }
        }

        if (failures.length > 0) {
          // A partial index silently loses memories from semantic recall and
          // pins the store to a fingerprint it can't fully honor. All or
          // nothing: clear the partial index (and its fingerprint stamp) so
          // the rebuilt graph is valid, unpinned, and honestly graph-only.
          store.clearAllEmbeddings();
          console.error(`\nEmbedding failed (${embedded} embedded before the first failure):`);
          for (const failure of failures.slice(0, 6)) console.error(`  ✖ ${failure}`);
          console.error(
            '\nCleared the partial embedding index. The rebuilt graph is valid but has NO embeddings — run ' +
              `'nacre embed --graph ${graphPath}' once the provider is available.`,
          );
          process.exit(1);
        }

        store.setMeta('embedding_provider', provider.name);
        store.setMeta('embedding_dimensions', String(provider.dimensions));
        console.log(`Embedded ${embedded} nodes (encoder: ${store.getEncoderFingerprint()}).`);
      }

      console.log('\nRebuild complete.');
    } finally {
      store.close();
    }
  },
});
