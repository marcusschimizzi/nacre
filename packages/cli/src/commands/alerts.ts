import { readFileSync } from 'node:fs';
import { defineCommand } from 'citty';
import { generateAlerts, type NacreGraph } from '@nacre/core';
import { formatJSON } from '../output.js';

export default defineCommand({
  meta: {
    name: 'alerts',
    description: 'Show graph health alerts — fading connections, orphan nodes',
  },
  args: {
    graph: {
      type: 'string',
      description: 'Path to graph.json',
      default: 'data/graphs/default/graph.json',
    },
    format: {
      type: 'string',
      description: 'Output format: text or json',
      default: 'text',
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

    const result = generateAlerts(graph, { now: new Date() });

    if (args.format === 'json') {
      console.log(formatJSON(result));
    } else {
      console.log(result.summary);
    }
  },
});
