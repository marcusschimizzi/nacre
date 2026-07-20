import { defineCommand } from 'citty';
import {
  EncoderMismatchError,
  SqliteStore,
  readMemorySource,
  recall,
  recallWithHive,
  resolveMemoryDir,
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
    'as-of': {
      type: 'string',
      description: 'Recall as of this ISO date (uses nearest snapshot)',
    },
    format: {
      type: 'string',
      description: 'Output format: text or json',
      default: 'text',
    },
    hive: {
      type: 'string',
      description: 'Path to hive .db for federated recall',
    },
    'hive-only': {
      type: 'boolean',
      description: 'Search hive only, skip private graph',
    },
    source: {
      type: 'boolean',
      description: 'Include verbatim claim + Source evidence from canonical memory files',
    },
    scopes: {
      type: 'string',
      description:
        'Comma-separated scope filter (user, agent, project/<name>, session). Default: every durable scope; session only when listed',
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
      const provider = resolveProvider({
        provider: args.provider as string | undefined,
        graphPath: args.graph as string,
        allowNull: true,
      });

      if (!provider && store.embeddingCount() > 0) {
        console.warn(
          'Embeddings exist but no provider available for query embedding. Falling back to graph-only recall.',
        );
      }

      const types = args.types
        ? ((args.types as string).split(',').map((t) => t.trim()) as EntityType[])
        : undefined;
      const scopes = args.scopes
        ? (args.scopes as string).split(',').map((x) => x.trim())
        : undefined;

      const hivePath = args.hive as string | undefined;
      const hiveOnly = args['hive-only'] as boolean | undefined;

      if (hiveOnly && !hivePath) {
        console.error('--hive-only requires --hive <path>');
        process.exit(1);
      }

      let hiveStore: SqliteStore | null = null;
      if (hivePath) {
        if (!hivePath.endsWith('.db')) {
          console.error('Hive path must be a .db file');
          process.exit(1);
        }
        hiveStore = SqliteStore.open(hivePath);
      }

      let response: Awaited<ReturnType<typeof recall>>;
      try {
        if (hiveStore) {
          response = await recallWithHive(store, hiveStore, provider, {
            query: args.query as string,
            limit: parseInt(args.limit as string, 10),
            types,
            since: args.since as string | undefined,
            until: args.until as string | undefined,
            hops: parseInt(args.hops as string, 10),
            asOf: args['as-of'] as string | undefined,
            scopes,
            hiveOnly: hiveOnly ?? false,
            // --hive without --hive-only = explicit tap: full weight, no discount
            // --hive-only = hive only, also full weight
            hiveExplicit: !hiveOnly,
          });
        } else {
          response = await recall(store, provider, {
            query: args.query as string,
            limit: parseInt(args.limit as string, 10),
            types,
            since: args.since as string | undefined,
            until: args.until as string | undefined,
            hops: parseInt(args.hops as string, 10),
            asOf: args['as-of'] as string | undefined,
            scopes,
          });
        }
      } catch (err) {
        // An encoder switch is a configuration error with a known remedy —
        // print it, don't crash with a stack trace.
        if (err instanceof EncoderMismatchError) {
          console.error(err.message);
          process.exit(1);
        }
        throw err;
      } finally {
        hiveStore?.close();
      }

      // --source applies to every output format: enrich results with the
      // verbatim claim + Source evidence from canonical files up front.
      const memoryDir = args.source ? resolveMemoryDir(graphPath) : null;
      const verbatimById = new Map<string, { claim: string; source?: string }>();
      if (memoryDir) {
        for (const r of response.results) {
          const canonicalPath = store.getNode(r.id)?.canonicalPath;
          const verbatim = canonicalPath ? readMemorySource(memoryDir, canonicalPath) : undefined;
          if (verbatim) verbatimById.set(r.id, verbatim);
        }
      }

      if ((args.format as string) === 'json') {
        const output = memoryDir
          ? {
              ...response,
              results: response.results.map((r) => {
                const verbatim = verbatimById.get(r.id);
                return verbatim
                  ? {
                      ...r,
                      claim: verbatim.claim,
                      ...(verbatim.source ? { source: verbatim.source } : {}),
                    }
                  : r;
              }),
            }
          : response;
        console.log(formatJSON(output));
        return;
      }

      if (response.results.length === 0) {
        console.log('No results found.');
        return;
      }

      console.log(`Query: "${args.query}"`);
      console.log(
        `Found ${response.results.length} result${response.results.length === 1 ? '' : 's'}:\n`,
      );

      for (let i = 0; i < response.results.length; i++) {
        const r = response.results[i];
        console.log(`  ${i + 1}. ${r.label} (${r.type}) — score: ${r.score.toFixed(3)}`);
        console.log(
          `     semantic: ${r.scores.semantic.toFixed(2)}  graph: ${r.scores.graph.toFixed(2)}  recency: ${r.scores.recency.toFixed(2)}  importance: ${r.scores.importance.toFixed(2)}`,
        );

        {
          const verbatim = verbatimById.get(r.id);
          if (verbatim) {
            console.log(`     Claim: ${verbatim.claim}`);
            if (verbatim.source) {
              for (const line of verbatim.source.split('\n')) {
                console.log(`     Source: ${line}`);
              }
            }
          }
        }

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
