import { readFileSync } from 'node:fs';
import { defineCommand } from 'citty';
import { analyzeSignificance, type NacreGraph } from '@nacre/core';
import { formatJSON } from '../output.js';

export default defineCommand({
  meta: {
    name: 'insights',
    description: 'Analyze graph significance — emerging topics, anchors, fading-but-important nodes',
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
    'recent-days': {
      type: 'string',
      description: 'Days to consider as "recent" activity',
      default: '7',
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

    const recentDays = parseInt(args['recent-days'] as string, 10) || 7;
    const result = analyzeSignificance(graph, {
      recentDays,
      now: new Date(),
    });

    if (args.format === 'json') {
      console.log(formatJSON(result));
    } else {
      console.log(result.summary);
    }
  },
});
