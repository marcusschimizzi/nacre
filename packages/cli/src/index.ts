import { defineCommand, runMain } from 'citty';
import consolidateCmd from './commands/consolidate.js';
import queryCmd from './commands/query.js';
import briefCmd from './commands/brief.js';
import alertsCmd from './commands/alerts.js';
import suggestCmd from './commands/suggest.js';
import insightsCmd from './commands/insights.js';

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
    brief: briefCmd,
    alerts: alertsCmd,
    suggest: suggestCmd,
    insights: insightsCmd,
  },
});

runMain(main);
