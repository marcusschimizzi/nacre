import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineCommand } from 'citty';
import {
  admitWorkingMemory,
  computeDeterministicEntityDegrees,
  filterGraphByScopes,
  generateBrief,
  listMemoryFiles,
  parseMemoryFile,
  parseScopesFilter,
  SqliteStore,
  type AdmissionPolicy,
  type AdmissionReceipt,
} from '@nacre/core';
import { formatJSON } from '../output.js';
import { loadGraph, closeGraph } from '../graph-loader.js';

export interface WorkingMemoryBriefOptions {
  graphPath: string;
  memoryDir: string;
  evaluatedAt: string;
  policy?: Partial<AdmissionPolicy>;
}

export function executeWorkingMemoryBrief(options: WorkingMemoryBriefOptions): AdmissionReceipt {
  if (!options.graphPath.endsWith('.db')) {
    throw new Error('working-memory brief requires a SQLite --graph');
  }
  if (!options.evaluatedAt) throw new Error('working-memory brief requires strict --at');
  const parsed = listMemoryFiles(options.memoryDir).map((path) => {
    const value = parseMemoryFile(readFileSync(join(options.memoryDir, path), 'utf8'), path);
    return { memory: value.memory, claim: value.claim };
  });
  const store = SqliteStore.open(options.graphPath);
  try {
    const receipt = admitWorkingMemory(parsed, {
      kind: 'brief',
      evaluatedAt: options.evaluatedAt,
      policy: options.policy,
      entityDegrees: computeDeterministicEntityDegrees(store.listEdges()),
    });
    store.putAdmissionReceipt(receipt);
    return receipt;
  } finally {
    store.close();
  }
}

export default defineCommand({
  meta: {
    name: 'brief',
    description: 'Generate a graph briefing or an admitted bounded working-memory brief',
  },
  args: {
    graph: {
      type: 'string',
      description: 'Path to graph (.db or .json)',
      default: 'data/graphs/default/graph.json',
    },
    'memory-dir': {
      type: 'string',
      description: 'Canonical memory root; enables working-memory admission mode',
    },
    at: {
      type: 'string',
      description: 'Strict ISO evaluation timestamp (required with --memory-dir)',
    },
    format: {
      type: 'string',
      description: 'Output format: text or json',
      default: 'text',
    },
    top: {
      type: 'string',
      description: 'Number of top entities to include',
      default: '20',
    },
    'recent-days': {
      type: 'string',
      description: 'Days to consider as "recent" activity',
      default: '7',
    },
    scopes: {
      type: 'string',
      description:
        'Comma-separated scope filter. Default: every durable scope; session only when listed',
    },
    'include-session': {
      type: 'boolean',
      description: 'Explicitly allow session scope admission',
    },
    'token-budget': {
      type: 'string',
      description: 'Maximum UTF-8 estimated tokens (default 2000)',
    },
    'min-confidence': {
      type: 'string',
      description: 'Minimum evidence confidence (default 0.5)',
    },
    'max-sensitivity': {
      type: 'string',
      description: 'Maximum sensitivity: low, personal, sensitive, secret',
    },
    'stale-days': {
      type: 'string',
      description: 'Stateful claim staleness threshold in event-time days (default 180)',
    },
  },
  async run({ args }) {
    const memoryDir = args['memory-dir'] as string | undefined;
    if (memoryDir) {
      const parsedScopes = parseScopesFilter(args.scopes as string | undefined);
      const receipt = executeWorkingMemoryBrief({
        graphPath: args.graph as string,
        memoryDir,
        evaluatedAt: args.at as string,
        policy: {
          ...(parsedScopes ? { scopes: parsedScopes } : {}),
          ...(args['include-session'] ? { includeSession: true } : {}),
          ...(args['token-budget'] ? { tokenBudget: Number(args['token-budget'] as string) } : {}),
          ...(args['min-confidence']
            ? { minEvidenceConfidence: Number(args['min-confidence'] as string) }
            : {}),
          ...(args['max-sensitivity']
            ? { maxSensitivity: args['max-sensitivity'] as AdmissionPolicy['maxSensitivity'] }
            : {}),
          ...(args['stale-days']
            ? { staleStatefulAfterDays: Number(args['stale-days'] as string) }
            : {}),
        },
      });
      console.log(args.format === 'json' ? formatJSON(receipt) : receipt.renderedBrief);
      return;
    }

    const loaded = await loadGraph(args.graph as string);
    try {
      const top = parseInt(args.top as string, 10) || 20;
      const recentDays = parseInt(args['recent-days'] as string, 10) || 7;
      const scopes = parseScopesFilter(args.scopes as string | undefined);
      const result = generateBrief(filterGraphByScopes(loaded.graph, scopes), {
        top,
        recentDays,
        now: new Date(),
      });

      if (args.format === 'json') console.log(formatJSON(result));
      else console.log(result.summary);
    } finally {
      closeGraph(loaded);
    }
  },
});
