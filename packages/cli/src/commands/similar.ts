import { defineCommand } from 'citty';
import {
  EncoderMismatchError,
  SqliteStore,
  nodeVisibleInScopes,
  parseScopesFilter,
  recordVisibleInScopes,
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
    scopes: {
      type: 'string',
      description:
        'Comma-separated scope filter. Default: every durable scope; session only when listed',
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

    const provider = resolveProvider({
      provider: args.provider as string | undefined,
      graphPath: args.graph as string,
    });
    if (!provider) {
      console.error(
        'No embedding provider configured. Set one via --provider, nacre.config.json, or NACRE_EMBEDDING_PROVIDER.',
      );
      process.exit(1);
    }
    const store = SqliteStore.open(graphPath);

    try {
      if (store.embeddingCount() === 0) {
        console.error('No embeddings found. Run `nacre embed` first.');
        process.exit(1);
      }

      const queryText = args.query as string;
      const queryVec = await provider.embed(queryText);

      const scopes = parseScopesFilter(args.scopes as string | undefined);
      const limitN = parseInt(args.limit as string, 10);
      let results: ReturnType<typeof store.searchSimilar>;
      try {
        results = store
          .searchSimilar(queryVec, {
            // Always over-fetch: the visibility filter below runs on every
            // request (session hidden even by default) and must not starve
            // the page.
            limit: limitN * 3,
            minSimilarity: parseFloat(args.threshold as string),
            type: args.type as string | undefined,
          })
          .filter((r) => {
            // Fail closed: resolve to node or episode and apply its scope;
            // unresolvable rows are dropped.
            const node = store.getNode(r.id);
            if (node) return nodeVisibleInScopes(node, scopes);
            const episode = store.getEpisode(r.id);
            if (episode) return recordVisibleInScopes(episode, scopes);
            return false;
          })
          .slice(0, limitN);
      } catch (err) {
        if (err instanceof EncoderMismatchError) {
          console.error(err.message);
          process.exit(1);
        }
        throw err;
      }

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
