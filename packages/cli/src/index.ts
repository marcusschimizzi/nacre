import { defineCommand, runMain } from 'citty';
import consolidateCmd from './commands/consolidate.js';
import queryCmd from './commands/query.js';
import briefCmd from './commands/brief.js';
import alertsCmd from './commands/alerts.js';
import suggestCmd from './commands/suggest.js';
import insightsCmd from './commands/insights.js';
import vizCmd from './commands/viz.js';
import embedCmd from './commands/embed.js';
import similarCmd from './commands/similar.js';
import episodesCmd from './commands/episodes.js';
import recallCmd from './commands/recall.js';
import proceduresCmd from './commands/procedures.js';
import apiCmd from './commands/api.js';
import mcpCmd from './commands/mcp.js';
import snapshotsCmd from './commands/snapshots.js';
import historyCmd from './commands/history.js';
import ingestCmd from './commands/ingest.js';
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
    viz: vizCmd,
    migrate: migrateCommand,
    embed: embedCmd,
    similar: similarCmd,
    episodes: episodesCmd,
    recall: recallCmd,
    procedures: proceduresCmd,
    api: apiCmd,
    mcp: mcpCmd,
    snapshots: snapshotsCmd,
    history: historyCmd,
    ingest: ingestCmd,
  },
});

runMain(main);
