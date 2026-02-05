import { defineCommand, runMain } from 'citty';
import consolidateCmd from './commands/consolidate.js';
import queryCmd from './commands/query.js';
import briefCmd from './commands/brief.js';
import alertsCmd from './commands/alerts.js';
import suggestCmd from './commands/suggest.js';
import insightsCmd from './commands/insights.js';
import serveCmd from './commands/serve.js';
import embedCmd from './commands/embed.js';
import similarCmd from './commands/similar.js';
import { migrateCommand } from './commands/migrate.js';

const main = defineCommand({
  meta: {
    name: 'nacre',
    version: '0.1.0',
    description:
      'Biological memory for long-living AI agents — turn experience into a living knowledge graph',
  },
  subCommands: {
    consolidate: consolidateCmd,
    query: queryCmd,
    brief: briefCmd,
    alerts: alertsCmd,
    suggest: suggestCmd,
    insights: insightsCmd,
    serve: serveCmd,
    migrate: migrateCommand,
    embed: embedCmd,
    similar: similarCmd,
  },
});

runMain(main);
