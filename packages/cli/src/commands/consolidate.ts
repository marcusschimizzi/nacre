import { defineCommand } from 'citty';
import { consolidate } from '@nacre/parser';
import { formatConsolidationSummary } from '../output.js';

export default defineCommand({
  meta: {
    name: 'consolidate',
    description: 'Run the ingestion pipeline on markdown memory files',
  },
  args: {
    source: {
      type: 'positional',
      description: 'Input directories or files',
      required: true,
    },
    out: {
      type: 'string',
      description: 'Output directory for graph.json',
      default: 'data/graphs/default',
    },
    'entity-map': {
      type: 'string',
      description: 'Path to entity-map.json',
      default: 'data/entity-map.json',
    },
  },
  async run({ args }) {
    const inputs = [args.source as string];
    const start = Date.now();

    const result = await consolidate({
      inputs,
      outDir: args.out as string,
      entityMapPath: args['entity-map'] as string,
    });

    const elapsed = Date.now() - start;
    console.log(formatConsolidationSummary(result, elapsed));
  },
});
