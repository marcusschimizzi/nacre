import { defineCommand } from 'citty';
import {
  SqliteStore,
  OllamaEmbedder,
  MockEmbedder,
  type EmbeddingProvider,
} from '@nacre/core';

function createProvider(name: string): EmbeddingProvider {
  switch (name) {
    case 'ollama':
      return new OllamaEmbedder();
    case 'mock':
      return new MockEmbedder();
    default:
      throw new Error(`Unknown provider: ${name}. Available: ollama, mock`);
  }
}

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
      description: 'Embedding provider: ollama, mock',
      default: 'ollama',
    },
    force: {
      type: 'boolean',
      description: 'Regenerate all embeddings even if they already exist',
    },
  },
  async run({ args }) {
    const graphPath = args.graph as string;
    if (!graphPath.endsWith('.db')) {
      console.error('Embedding storage requires a SQLite graph (.db file)');
      process.exit(1);
    }

    const provider = createProvider(args.provider as string);
    const store = SqliteStore.open(graphPath);

    try {
      const graph = store.getFullGraph();
      const nodes = Object.values(graph.nodes);

      if (nodes.length === 0) {
        console.log('No nodes in graph. Run consolidate first.');
        return;
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
    } finally {
      store.close();
    }
  },
});
