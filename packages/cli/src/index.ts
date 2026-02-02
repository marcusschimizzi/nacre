import { defineCommand, runMain } from 'citty';
import consolidateCmd from './commands/consolidate.js';
import queryCmd from './commands/query.js';

const main = defineCommand({
  meta: {
    name: 'nacre',
    version: '0.0.0',
    description:
      'Spatial memory graph — turn markdown memories into a living knowledge graph',
  },
  subCommands: {
    consolidate: consolidateCmd,
    query: queryCmd,
  },
});

runMain(main);
