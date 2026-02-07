import { defineCommand } from 'citty';
import {
  SqliteStore,
  OllamaEmbedder,
  MockEmbedder,
  recall,
  type EmbeddingProvider,
  type EntityType,
} from '@nacre/core';
import { formatJSON } from '../output.js';

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
    name: 'recall',
    description: 'Hybrid recall — combines semantic search with graph traversal',
  },
  args: {
    query: {
      type: 'positional',
      description: 'Natural language query',
      required: true,
    },
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
    limit: {
      type: 'string',
      description: 'Max results to return',
      default: '10',
    },
    types: {
      type: 'string',
      description: 'Comma-separated entity types to filter (person,tool,concept,...)',
    },
    since: {
      type: 'string',
      description: 'Only include nodes reinforced after this ISO date',
    },
    until: {
      type: 'string',
      description: 'Only include nodes reinforced before this ISO date',
    },
    hops: {
      type: 'string',
      description: 'Graph walk depth',
      default: '2',
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
      console.error('Recall requires a SQLite graph (.db file)');
      process.exit(1);
    }

    const store = SqliteStore.open(graphPath);

    try {
      const provider: EmbeddingProvider | null =
        store.embeddingCount() > 0
          ? createProvider(args.provider as string)
          : null;

      const types = args.types
        ? (args.types as string).split(',').map((t) => t.trim()) as EntityType[]
        : undefined;

      const results = await recall(store, provider, {
        query: args.query as string,
        limit: parseInt(args.limit as string, 10),
        types,
        since: args.since as string | undefined,
        until: args.until as string | undefined,
        hops: parseInt(args.hops as string, 10),
      });

      if ((args.format as string) === 'json') {
        console.log(formatJSON(results));
        return;
      }

      if (results.length === 0) {
        console.log('No results found.');
        return;
      }

      console.log(`Query: "${args.query}"`);
      console.log(`Found ${results.length} result${results.length === 1 ? '' : 's'}:\n`);

      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        console.log(`  ${i + 1}. ${r.label} (${r.type}) — score: ${r.score.toFixed(3)}`);
        console.log(`     semantic: ${r.scores.semantic.toFixed(2)}  graph: ${r.scores.graph.toFixed(2)}  recency: ${r.scores.recency.toFixed(2)}  importance: ${r.scores.importance.toFixed(2)}`);

        if (r.connections.length > 0) {
          const conns = r.connections
            .map((c) => `${c.label} (${c.relationship}, ${c.weight.toFixed(2)})`)
            .join(', ');
          console.log(`     Connections: ${conns}`);
        }

        if (r.episodes && r.episodes.length > 0) {
          console.log(`     Episodes: ${r.episodes.length} linked`);
        }
      }
    } finally {
      store.close();
    }
  },
});
