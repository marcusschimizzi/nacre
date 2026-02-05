import { defineCommand } from 'citty';
import { generateAlerts } from '@nacre/core';
import { formatJSON } from '../output.js';
import { loadGraph, closeGraph } from '../graph-loader.js';

export default defineCommand({
  meta: {
    name: 'alerts',
    description: 'Show graph health alerts — fading connections, orphan nodes',
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
  },
  async run({ args }) {
    const loaded = await loadGraph(args.graph as string);
    try {
      const result = generateAlerts(loaded.graph, { now: new Date() });
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
