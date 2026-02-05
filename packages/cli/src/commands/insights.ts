import { defineCommand } from 'citty';
import { analyzeSignificance } from '@nacre/core';
import { formatJSON } from '../output.js';
import { loadGraph, closeGraph } from '../graph-loader.js';

export default defineCommand({
  meta: {
    name: 'insights',
    description: 'Analyze graph significance — emerging topics, anchors, fading-but-important nodes',
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
    'recent-days': {
      type: 'string',
      description: 'Days to consider as "recent" activity',
      default: '7',
    },
  },
  async run({ args }) {
    const loaded = await loadGraph(args.graph as string);
    try {
      const recentDays = parseInt(args['recent-days'] as string, 10) || 7;
      const result = analyzeSignificance(loaded.graph, {
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
