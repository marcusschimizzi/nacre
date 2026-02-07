import { defineCommand } from 'citty';
import {
  SqliteStore,
  resolveProvider,
} from '@nacre/core';

export default defineCommand({
  meta: {
    name: 'embed',
    description: 'Generate embeddings for all nodes in a graph',
  },
  args: {
    graph: {
      type: 'string',
      description: 'Path to graph database (.db)',
      required: true,
    },
    provider: {
      type: 'string',
      description: 'Embedding provider: onnx, ollama, openai, mock',
    },
    force: {
      type: 'boolean',
      description: 'Regenerate all embeddings even if they already exist',
    },
    status: {
      type: 'boolean',
      description: 'Show embedding status for the graph',
    },
  },
  async run({ args }) {
    const graphPath = args.graph as string;
    if (!graphPath.endsWith('.db')) {
      console.error('Embedding storage requires a SQLite graph (.db file)');
      process.exit(1);
    }

    if (args.status) {
      const store = SqliteStore.open(graphPath);
      try {
        const providerName = store.getMeta('embedding_provider') ?? 'none';
        const dims = store.getMeta('embedding_dimensions') ?? '—';
        const totalEmbeddings = store.embeddingCount();
        const nodeCount = store.nodeCount();
        const episodeCount = store.episodeCount();

        const nodeEmbeddings = store.embeddingCountByType('node');
        const episodeEmbeddings = store.embeddingCountByType('episode');

        console.log('Embedding Status:');
        console.log(`  Provider:  ${providerName} (${dims} dims)`);
        console.log(`  Nodes:     ${nodeEmbeddings}/${nodeCount} embedded (${nodeCount > 0 ? Math.round(nodeEmbeddings / nodeCount * 100) : 0}%)`);
        console.log(`  Episodes:  ${episodeEmbeddings}/${episodeCount} embedded (${episodeCount > 0 ? Math.round(episodeEmbeddings / episodeCount * 100) : 0}%)`);
        console.log(`  Total:     ${totalEmbeddings}`);

        if (totalEmbeddings === 0) {
          console.log('\nNo embeddings yet. Run `nacre embed --graph <path>` to generate.');
          return;
        }

        if (nodeEmbeddings < nodeCount) {
          const allNodes = store.listNodes();
          const missing = allNodes.filter((n) => !store.getEmbedding(n.id));
          if (missing.length > 0) {
            console.log(`\n  Missing embeddings (${missing.length}):`);
            for (const node of missing.slice(0, 10)) {
              console.log(`    - ${node.id} "${node.label}"`);
            }
            if (missing.length > 10) {
              console.log(`    ... and ${missing.length - 10} more`);
            }
          }
        }

        console.log(`\nRun 'nacre embed --graph ${graphPath}' to update.`);
      } finally {
        store.close();
      }
      return;
    }

    const provider = resolveProvider({ provider: args.provider as string | undefined, graphPath: args.graph as string });
    const store = SqliteStore.open(graphPath);

    try {
      const graph = store.getFullGraph();
      const nodes = Object.values(graph.nodes);

      if (nodes.length === 0) {
        console.log('No nodes in graph. Run consolidate first.');
        return;
      }

      const storedProvider = store.getMeta('embedding_provider');
      const storedDims = store.getMeta('embedding_dimensions');
      if (storedProvider && storedDims && store.embeddingCount() > 0) {
        const existingDims = parseInt(storedDims, 10);
        if (existingDims !== provider.dimensions) {
          console.warn(`Provider changed (${storedProvider} → ${provider.name})`);
          console.warn(`Dimensions: ${existingDims} → ${provider.dimensions}`);
          if (!args.force) {
            console.warn('Run with --force to clear existing embeddings and re-embed.');
            process.exit(1);
          }
          const cleared = store.clearAllEmbeddings();
          console.log(`Cleared ${cleared} existing embeddings for re-embedding.`);
        } else if (storedProvider !== provider.name) {
          console.log(`Provider name changed (${storedProvider} → ${provider.name}), dimensions match.`);
        }
      }

      console.log(`Provider: ${provider.name} (${provider.dimensions} dims)`);
      console.log(`Nodes: ${nodes.length}`);
      console.log('');

      let embedded = 0;
      let skipped = 0;

      for (const node of nodes) {
        if (!args.force && store.getEmbedding(node.id)) {
          skipped++;
          continue;
        }

        const text = node.label + ' — ' + node.excerpts.map(e => e.text).join('. ');

        try {
          const vector = await provider.embed(text);
          store.putEmbedding(node.id, 'node', text, vector, provider.name);
          embedded++;

          if (embedded % 10 === 0) {
            process.stdout.write(`\r  Embedded: ${embedded}/${nodes.length - skipped}`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`\n  Failed: ${node.label} — ${msg}`);
        }
      }

      if (embedded > 0) {
        process.stdout.write('\n');
      }

      console.log('');
      console.log(`Done. Embedded: ${embedded}, Skipped: ${skipped}, Total stored: ${store.embeddingCount()}`);

      if (embedded > 0) {
        store.setMeta('embedding_provider', provider.name);
        store.setMeta('embedding_dimensions', String(provider.dimensions));
      }
    } finally {
      store.close();
    }
  },
});
