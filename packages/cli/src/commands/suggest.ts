import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { defineCommand } from 'citty';
import { generateSuggestions, type PendingEdge } from '@nacre/core';
import { formatJSON } from '../output.js';
import { loadGraph, closeGraph } from '../graph-loader.js';

export default defineCommand({
  meta: {
    name: 'suggest',
    description: 'Show connection suggestions — co-occurrence patterns, structural holes, type bridges',
  },
  args: {
    graph: {
      type: 'string',
      description: 'Path to graph (.db or .json)',
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
    const loaded = await loadGraph(args.graph as string);
    try {
      let pendingEdges: PendingEdge[] = [];

      // Load pending edges from SQLite meta if using .db, otherwise from JSON file
      if (loaded.store) {
        const pendingStr = loaded.store.getMeta('pending_edges');
        if (pendingStr) {
          pendingEdges = JSON.parse(pendingStr) as PendingEdge[];
        }
      } else {
        const graphPath = args.graph as string;
        const pendingPath = (args.pending as string) ??
          resolve(dirname(graphPath), 'pending-edges.json');
        try {
          if (existsSync(pendingPath)) {
            pendingEdges = JSON.parse(readFileSync(pendingPath, 'utf8')) as PendingEdge[];
          }
        } catch {
          // pending-edges.json is optional
        }
      }

      const maxSuggestions = parseInt(args.max as string, 10) || 10;
      const result = generateSuggestions(loaded.graph, pendingEdges, {
        maxSuggestions,
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
