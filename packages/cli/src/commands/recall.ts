import { defineCommand } from 'citty';
import {
  SqliteStore,
  recall,
  resolveProvider,
  type EntityType,
} from '@nacre/core';
import { formatJSON } from '../output.js';

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
      description: 'Embedding provider: onnx, ollama, openai, mock',
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
      const provider = resolveProvider({ provider: args.provider as string | undefined, graphPath: args.graph as string, allowNull: true });

      const types = args.types
        ? (args.types as string).split(',').map((t) => t.trim()) as EntityType[]
        : undefined;

      const response = await recall(store, provider, {
        query: args.query as string,
        limit: parseInt(args.limit as string, 10),
        types,
        since: args.since as string | undefined,
        until: args.until as string | undefined,
        hops: parseInt(args.hops as string, 10),
      });

      if ((args.format as string) === 'json') {
        console.log(formatJSON(response));
        return;
      }

      if (response.results.length === 0) {
        console.log('No results found.');
        return;
      }

      console.log(`Query: "${args.query}"`);
      console.log(`Found ${response.results.length} result${response.results.length === 1 ? '' : 's'}:\n`);

      for (let i = 0; i < response.results.length; i++) {
        const r = response.results[i];
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

      if (response.procedures.length > 0) {
        console.log(`\nRelevant Procedures (${response.procedures.length}):`);
        for (const p of response.procedures) {
          console.log(`  • ${p.statement} (${p.type}, confidence: ${p.confidence.toFixed(2)})`);
        }
      }
    } finally {
      store.close();
    }
  },
});
