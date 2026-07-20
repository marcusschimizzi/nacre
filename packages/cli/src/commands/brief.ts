import { defineCommand } from 'citty';
import { filterGraphByScopes, generateBrief } from '@nacre/core';
import { formatJSON } from '../output.js';
import { loadGraph, closeGraph } from '../graph-loader.js';

export default defineCommand({
  meta: {
    name: 'brief',
    description: 'Generate a context briefing from the memory graph',
  },
  args: {
    graph: {
      type: 'string',
      description: 'Path to graph (.db or .json)',
      default: 'data/graphs/default/graph.json',
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
  },
  async run({ args }) {
    const loaded = await loadGraph(args.graph as string);
    try {
      const top = parseInt(args.top as string, 10) || 20;
      const recentDays = parseInt(args['recent-days'] as string, 10) || 7;
      const scopes = args.scopes
        ? (args.scopes as string).split(',').map((x) => x.trim())
        : undefined;
      const result = generateBrief(filterGraphByScopes(loaded.graph, scopes), {
        top,
        recentDays,
        now: new Date(),
      });

      if (args.format === 'json') {
        console.log(formatJSON(result));
      } else {
        console.log(result.summary);
      }
    } finally {
      closeGraph(loaded);
    }
  },
});
