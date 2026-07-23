import { defineCommand } from 'citty';
import {
  SqliteStore,
  promoteMemoryCandidate,
  rejectMemoryCandidate,
  resolveMemoryCandidate,
  type MemoryResolutionReceipt,
  type MemoryCandidate,
  type MemoryCandidateLifecycle,
} from '@nacre/core';
import { formatJSON } from '../output.js';

interface BaseCandidateAction {
  graph: string;
}

export type CandidateActionOptions =
  | (BaseCandidateAction & { action: 'list'; lifecycle?: MemoryCandidateLifecycle; scope?: string })
  | (BaseCandidateAction & { action: 'show'; id: string })
  | (BaseCandidateAction & { action: 'promote'; id: string; memoryDir: string })
  | (BaseCandidateAction & { action: 'resolve'; id: string; memoryDir: string })
  | (BaseCandidateAction & { action: 'reject'; id: string; reason: string; memoryDir: string });

export function executeCandidateAction(
  options: Extract<CandidateActionOptions, { action: 'list' }>,
): MemoryCandidate[];
export function executeCandidateAction(
  options: Extract<CandidateActionOptions, { action: 'show' | 'promote' | 'reject' }>,
): MemoryCandidate;
export function executeCandidateAction(
  options: Extract<CandidateActionOptions, { action: 'resolve' }>,
): MemoryResolutionReceipt;
export function executeCandidateAction(
  options: CandidateActionOptions,
): MemoryCandidate | MemoryCandidate[] | MemoryResolutionReceipt {
  const store = SqliteStore.open(options.graph);
  try {
    if (options.action === 'list') {
      return store.listMemoryCandidates({
        ...(options.lifecycle ? { lifecycle: options.lifecycle } : {}),
        ...(options.scope ? { scope: options.scope } : {}),
      });
    }
    const candidate = store.getMemoryCandidate(options.id);
    if (!candidate) throw new Error(`Memory candidate not found: ${options.id}`);
    if (options.action === 'show') return candidate;
    if (options.action === 'promote') {
      return promoteMemoryCandidate(store, options.memoryDir, options.id).candidate;
    }
    if (options.action === 'resolve') {
      return resolveMemoryCandidate(store, options.memoryDir, options.id);
    }
    return rejectMemoryCandidate(store, options.memoryDir, options.id, options.reason);
  } finally {
    store.close();
  }
}

export default defineCommand({
  meta: {
    name: 'candidates',
    description: 'List, inspect, explicitly promote, or reject evidence-backed memory candidates',
  },
  subCommands: {
    list: defineCommand({
      meta: { name: 'list', description: 'List memory candidates' },
      args: {
        graph: { type: 'string', description: 'Path to graph database (.db)', required: true },
        lifecycle: { type: 'string', description: 'candidate, promoted, rejected' },
        scope: { type: 'string', description: 'List filter by exact scope' },
      },
      run({ args }) {
        const lifecycle = args.lifecycle as MemoryCandidateLifecycle | undefined;
        if (lifecycle && !['candidate', 'promoted', 'rejected'].includes(lifecycle)) {
          throw new Error(`Invalid lifecycle: ${lifecycle}`);
        }
        console.log(
          formatJSON(
            executeCandidateAction({
              action: 'list',
              graph: args.graph as string,
              lifecycle,
              scope: args.scope as string | undefined,
            }),
          ),
        );
      },
    }),
    show: defineCommand({
      meta: { name: 'show', description: 'Show a memory candidate' },
      args: {
        id: { type: 'positional', description: 'Candidate id', required: true },
        graph: { type: 'string', description: 'Path to graph database (.db)', required: true },
      },
      run({ args }) {
        console.log(
          formatJSON(
            executeCandidateAction({
              action: 'show',
              graph: args.graph as string,
              id: args.id as string,
            }),
          ),
        );
      },
    }),
    promote: defineCommand({
      meta: { name: 'promote', description: 'Promote a memory candidate' },
      args: {
        id: { type: 'positional', description: 'Candidate id', required: true },
        graph: { type: 'string', description: 'Path to graph database (.db)', required: true },
        'memory-dir': {
          type: 'string',
          description: 'Canonical memory root',
          required: true,
        },
      },
      run({ args }) {
        console.log(
          formatJSON(
            executeCandidateAction({
              action: 'promote',
              graph: args.graph as string,
              id: args.id as string,
              memoryDir: args['memory-dir'] as string,
            }),
          ),
        );
      },
    }),
    resolve: defineCommand({
      meta: {
        name: 'resolve',
        description: 'Explicitly resolve a candidate into the belief lifecycle',
      },
      args: {
        id: { type: 'positional', description: 'Candidate id', required: true },
        graph: { type: 'string', description: 'Path to graph database (.db)', required: true },
        'memory-dir': {
          type: 'string',
          description: 'Canonical memory root',
          required: true,
        },
      },
      run({ args }) {
        console.log(
          formatJSON(
            executeCandidateAction({
              action: 'resolve',
              graph: args.graph as string,
              id: args.id as string,
              memoryDir: args['memory-dir'] as string,
            }),
          ),
        );
      },
    }),
    reject: defineCommand({
      meta: { name: 'reject', description: 'Reject a memory candidate' },
      args: {
        id: { type: 'positional', description: 'Candidate id', required: true },
        graph: { type: 'string', description: 'Path to graph database (.db)', required: true },
        reason: {
          type: 'string',
          description: 'Review reason',
          required: true,
        },
        'memory-dir': {
          type: 'string',
          description: 'Candidate durable state root',
          required: true,
        },
      },
      run({ args }) {
        console.log(
          formatJSON(
            executeCandidateAction({
              action: 'reject',
              graph: args.graph as string,
              id: args.id as string,
              reason: args.reason as string,
              memoryDir: args['memory-dir'] as string,
            }),
          ),
        );
      },
    }),
    extract: defineCommand({
      meta: {
        name: 'extract',
        description: 'Extract candidates from verified historical evidence',
      },
      args: {
        graph: { type: 'string', description: 'Path to graph database (.db)', required: true },
        'memory-dir': {
          type: 'string',
          description: 'Configured memory root containing Nacre evidence',
          required: true,
        },
      },
      async run({ args }) {
        const { extractCandidatesFromHistoricalEvidence } = await import('@nacre/core');
        const store = SqliteStore.open(args.graph as string);
        try {
          console.log(
            formatJSON(
              extractCandidatesFromHistoricalEvidence(store, args['memory-dir'] as string),
            ),
          );
        } finally {
          store.close();
        }
      },
    }),
  },
});
