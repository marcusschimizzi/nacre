import { defineCommand } from 'citty';
import {
  SqliteStore,
  resolveProvider,
} from '@nacre/core';
import { formatJSON } from '../output.js';

export default defineCommand({
  meta: {
    name: 'similar',
    description: 'Find semantically similar nodes via embedding search',
  },
  args: {
    query: {
      type: 'positional',
      description: 'Search query text',
      required: true,
    },
    graph: {
      type: 'string',
      description: 'Path to graph database (.db)',
      required: true,
    },
    provider: {
      type: 'string',
      description: 'Embedding provider: onnx, ollama, openai, mock',
    },
    limit: {
      type: 'string',
      description: 'Max results to return',
      default: '10',
    },
    threshold: {
      type: 'string',
      description: 'Minimum similarity score (0-1)',
      default: '0',
    },
    type: {
      type: 'string',
      description: 'Filter by embedding type (node, episode, procedure)',
    },
    format: {
      type: 'string',
      description: 'Output format: text or json',
      default: 'text',
    },
  },
  async run({ args }) {
    const graphPath = args.graph as string;
    if (!graphPath.endsWith('.db')) {
      console.error('Embedding search requires a SQLite graph (.db file)');
      process.exit(1);
    }

    const provider = resolveProvider({ provider: args.provider as string | undefined, graphPath: args.graph as string });
    const store = SqliteStore.open(graphPath);

    try {
      if (store.embeddingCount() === 0) {
        console.error('No embeddings found. Run `nacre embed` first.');
        process.exit(1);
      }

      const queryText = args.query as string;
      const queryVec = await provider.embed(queryText);

      const results = store.searchSimilar(queryVec, {
        limit: parseInt(args.limit as string, 10),
        minSimilarity: parseFloat(args.threshold as string),
        type: args.type as string | undefined,
      });

      if ((args.format as string) === 'json') {
        console.log(formatJSON(results));
        return;
      }

      if (results.length === 0) {
        console.log('No similar nodes found.');
        return;
      }

      console.log(`Query: "${queryText}"`);
      console.log(`Found ${results.length} similar node${results.length === 1 ? '' : 's'}:\n`);

      for (const r of results) {
        const preview = r.content.length > 80 ? r.content.slice(0, 80) + '...' : r.content;
        console.log(`  ${r.similarity.toFixed(4)}  ${r.id}`);
        console.log(`           ${preview}`);
      }
    } finally {
      store.close();
    }
  },
});
