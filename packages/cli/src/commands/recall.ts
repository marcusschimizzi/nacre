import { defineCommand } from 'citty';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import {
  admitWorkingMemory,
  assertConfinedCanonicalPath,
  computeDeterministicEntityDegrees,
  EncoderMismatchError,
  parseMemoryFile,
  parseScopesFilter,
  SqliteStore,
  readMemorySource,
  recall,
  recallWithHive,
  resolveMemoryDir,
  resolveProvider,
  type EntityType,
  type AdmissionPolicy,
  type AdmissionReceipt,
} from '@nacre/core';
import { formatJSON } from '../output.js';

const NO_PROVIDER_DEGRADATION =
  'semantic_recall_unavailable:embeddings_exist_without_provider;graph_only_results_non_authoritative';

function strictIso(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function parseCanonicalRecallCandidate(
  memoryDir: string,
  canonicalPath: string,
  expectedId: string,
) {
  assertConfinedCanonicalPath(canonicalPath);
  const root = realpathSync(memoryDir);
  const file = realpathSync(resolve(root, canonicalPath));
  if (!file.startsWith(`${root}${sep}`))
    throw new Error(`canonical path is not confined to memory root: ${canonicalPath}`);
  const parsed = parseMemoryFile(readFileSync(file, 'utf8'), canonicalPath);
  if (parsed.memory.id !== expectedId) {
    throw new Error(`canonical memory id disagrees with recall result: ${expectedId}`);
  }
  return { memory: parsed.memory, claim: parsed.claim };
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
    admit: {
      type: 'boolean',
      description: 'Explicitly admit canonical recall results into bounded working context',
    },
    'memory-dir': {
      type: 'string',
      description: 'Canonical memory root (required with --admit)',
    },
    at: {
      type: 'string',
      description: 'Strict ISO admission evaluation timestamp (required with --admit)',
    },
    'include-session': { type: 'boolean', description: 'Explicitly allow session scope admission' },
    'token-budget': { type: 'string', description: 'Maximum UTF-8 estimated tokens' },
    'min-confidence': { type: 'string', description: 'Minimum evidence confidence' },
    'max-sensitivity': { type: 'string', description: 'Maximum sensitivity enum value' },
    'stale-days': { type: 'string', description: 'Stateful claim staleness threshold in days' },
  },
  async run({ args }) {
    const graphPath = args.graph as string;
    if (!graphPath.endsWith('.db')) {
      console.error('Recall requires a SQLite graph (.db file)');
      process.exit(1);
    }
    const admissionRequested = args.admit === true;
    const admissionMemoryDir = args['memory-dir'] as string | undefined;
    const admissionOnlyOptionPresent =
      admissionMemoryDir !== undefined ||
      args.at !== undefined ||
      args['include-session'] === true ||
      args['token-budget'] !== undefined ||
      args['min-confidence'] !== undefined ||
      args['max-sensitivity'] !== undefined ||
      args['stale-days'] !== undefined;
    if (!admissionRequested && admissionOnlyOptionPresent) {
      throw new Error('working-memory admission options require explicit --admit');
    }
    if (admissionRequested && !admissionMemoryDir) throw new Error('--admit requires --memory-dir');
    if (admissionRequested && !strictIso(args.at))
      throw new Error('--admit requires strict --at ISO timestamp');
    const recallAsOf = args['as-of'] as string | undefined;
    if (admissionRequested && recallAsOf !== undefined && recallAsOf !== args.at) {
      throw new Error('admitted recall requires --as-of and --at to match exactly');
    }

    const effectiveRecallAsOf = admissionRequested
      ? (args.at as string)
      : (args['as-of'] as string | undefined);

    const store = SqliteStore.open(graphPath);

    try {
      const provider = resolveProvider({
        provider: args.provider as string | undefined,
        graphPath: args.graph as string,
        allowNull: true,
      });

      const degradations: string[] = [];
      if (!provider && store.embeddingCount() > 0) {
        console.warn(
          'Embeddings exist but no provider available for query embedding. Falling back to graph-only recall.',
        );
        if (admissionRequested) degradations.push(NO_PROVIDER_DEGRADATION);
      }

      const types = args.types
        ? ((args.types as string).split(',').map((t) => t.trim()) as EntityType[])
        : undefined;
      const scopes = parseScopesFilter(args.scopes as string | undefined);

      const hivePath = args.hive as string | undefined;
      const hiveOnly = args['hive-only'] as boolean | undefined;

      if (admissionRequested && hivePath) {
        throw new Error(
          'admitted recall does not yet support --hive; use private canonical recall',
        );
      }

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
            asOf: effectiveRecallAsOf,
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
            asOf: effectiveRecallAsOf,
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

      let admissionReceipt: AdmissionReceipt | undefined;
      let visibleResults = response.results;
      if (admissionRequested) {
        if (!admissionMemoryDir) throw new Error('--admit requires --memory-dir');
        const candidates = response.results.flatMap((result) => {
          const canonicalPath = store.getNode(result.id)?.canonicalPath;
          if (!canonicalPath) return [];
          return [
            {
              ...parseCanonicalRecallCandidate(admissionMemoryDir, canonicalPath, result.id),
              retrievalRelevance: result.score,
            },
          ];
        });
        const policyScopes = parseScopesFilter(args.scopes as string | undefined);
        admissionReceipt = admitWorkingMemory(candidates, {
          kind: 'recall',
          query: args.query as string,
          evaluatedAt: args.at as string,
          entityDegrees: computeDeterministicEntityDegrees(store.listEdges()),
          degradations,
          policy: {
            ...(policyScopes ? { scopes: policyScopes } : {}),
            ...(args['include-session'] ? { includeSession: true } : {}),
            ...(args['token-budget'] ? { tokenBudget: Number(args['token-budget']) } : {}),
            ...(args['min-confidence']
              ? { minEvidenceConfidence: Number(args['min-confidence']) }
              : {}),
            ...(args['max-sensitivity']
              ? { maxSensitivity: args['max-sensitivity'] as AdmissionPolicy['maxSensitivity'] }
              : {}),
            ...(args['stale-days'] ? { staleStatefulAfterDays: Number(args['stale-days']) } : {}),
          },
        });
        store.putAdmissionReceipt(admissionReceipt);
        const included = new Set(admissionReceipt.included);
        visibleResults = response.results.filter((result) => included.has(result.id));
      }

      // --source applies to every output format: enrich results with the
      // verbatim claim + Source evidence from canonical files up front.
      const memoryDir = args.source
        ? admissionRequested
          ? admissionMemoryDir
          : resolveMemoryDir(graphPath)
        : null;
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
              results: visibleResults.map((r) => {
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
          : { ...response, results: visibleResults };
        if (admissionReceipt) Object.assign(output, { receipt: admissionReceipt });
        console.log(formatJSON(output));
        return;
      }

      if (admissionReceipt) {
        if (admissionReceipt.degradations.length > 0 && visibleResults.length === 0) {
          console.log(
            'Recall degraded; graph-only search returned no admissible canonical memories. This is not authoritative evidence of no match.',
          );
        } else {
          console.log(admissionReceipt.renderedBrief);
        }
        console.log(`Admission receipt: ${admissionReceipt.id}`);
        for (const degradation of admissionReceipt.degradations)
          console.log(`Degradation: ${degradation}`);
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
