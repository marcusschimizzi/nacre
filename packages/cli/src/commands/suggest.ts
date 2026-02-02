import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { defineCommand } from 'citty';
import { generateSuggestions, type NacreGraph, type PendingEdge } from '@nacre/core';
import { formatJSON } from '../output.js';

export default defineCommand({
  meta: {
    name: 'suggest',
    description: 'Show connection suggestions — co-occurrence patterns, structural holes, type bridges',
  },
  args: {
    graph: {
      type: 'string',
      description: 'Path to graph.json',
      default: 'data/graphs/default/graph.json',
    },
    pending: {
      type: 'string',
      description: 'Path to pending-edges.json (default: same directory as graph)',
    },
    format: {
      type: 'string',
      description: 'Output format: text or json',
      default: 'text',
    },
    max: {
      type: 'string',
      description: 'Maximum number of suggestions',
      default: '10',
    },
  },
  async run({ args }) {
    const graphPath = args.graph as string;
    let graph: NacreGraph;
    try {
      graph = JSON.parse(readFileSync(graphPath, 'utf8')) as NacreGraph;
    } catch {
      console.error(`Could not read graph at: ${graphPath}`);
      process.exit(1);
    }

    const pendingPath = (args.pending as string) ??
      resolve(dirname(graphPath), 'pending-edges.json');
    let pendingEdges: PendingEdge[] = [];
    try {
      pendingEdges = JSON.parse(readFileSync(pendingPath, 'utf8')) as PendingEdge[];
    } catch {
      // pending-edges.json is optional — suggestions still work without it
    }

    const maxSuggestions = parseInt(args.max as string, 10) || 10;
    const result = generateSuggestions(graph, pendingEdges, {
      maxSuggestions,
      now: new Date(),
    });

    if (args.format === 'json') {
      console.log(formatJSON(result));
    } else {
      console.log(result.summary);
    }
  },
});
