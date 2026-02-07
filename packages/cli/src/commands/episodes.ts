import { defineCommand } from 'citty';
import { SqliteStore } from '@nacre/core';
import { formatJSON } from '../output.js';

function parseLastArg(last: string): string {
  const match = last.match(/^(\d+)([dhm])$/);
  if (!match) return last;
  const [, num, unit] = match;
  const ms = unit === 'd' ? 86400000 : unit === 'h' ? 3600000 : 60000;
  return new Date(Date.now() - parseInt(num, 10) * ms).toISOString();
}

export default defineCommand({
  meta: {
    name: 'episodes',
    description: 'List and view episodic memories',
  },
  args: {
    id: {
      type: 'positional',
      description: 'Episode ID to view in detail',
      required: false,
    },
    graph: {
      type: 'string',
      description: 'Path to graph database (.db)',
      required: true,
    },
    last: {
      type: 'string',
      description: 'Time window (e.g. 7d, 24h, 30d)',
    },
    type: {
      type: 'string',
      description: 'Filter by episode type (conversation, event, decision, observation)',
    },
    entity: {
      type: 'string',
      description: 'Filter by entity involvement',
    },
    topic: {
      type: 'string',
      description: 'Filter by topic (alias for --entity)',
    },
    limit: {
      type: 'string',
      description: 'Max results to return',
      default: '20',
    },
    format: {
      type: 'string',
      description: 'Output format: text or json',
      default: 'text',
    },
  },
  async run({ args }) {
    const graphPath = args.graph as string;
    if (!graphPath.endsWith('.db')) {
      console.error('Episodes require a SQLite graph (.db file)');
      process.exit(1);
    }

    const store = SqliteStore.open(graphPath);

    try {
      const episodeId = args.id as string | undefined;

      if (episodeId) {
        const episode = store.getEpisode(episodeId);
        if (!episode) {
          console.error(`Episode not found: ${episodeId}`);
          process.exit(1);
        }

        if ((args.format as string) === 'json') {
          const entities = store.getEpisodeEntities(episodeId);
          console.log(formatJSON({ episode, entities }));
          return;
        }

        const entities = store.getEpisodeEntities(episodeId);
        console.log(`${episode.title}`);
        console.log(`  Type: ${episode.type}`);
        console.log(`  Date: ${episode.timestamp}`);
        console.log(`  Source: ${episode.source}`);
        console.log(`  Importance: ${episode.importance}`);
        console.log(`  Accessed: ${episode.accessCount} times`);
        if (entities.length > 0) {
          console.log(`  Entities: ${entities.map(e => `${e.nodeId} (${e.role})`).join(', ')}`);
        }
        console.log(`\n${episode.content}`);
        return;
      }

      const entityName = (args.entity as string) || (args.topic as string);
      let hasEntity: string | undefined;

      if (entityName) {
        const node = store.findNode(entityName);
        if (!node) {
          console.error(`Entity not found: ${entityName}`);
          process.exit(1);
        }
        hasEntity = node.id;
      }

      const episodes = store.listEpisodes({
        type: args.type as any,
        since: args.last ? parseLastArg(args.last as string) : undefined,
        hasEntity,
      });

      const limit = parseInt(args.limit as string, 10);
      const limited = episodes.slice(0, limit);

      if ((args.format as string) === 'json') {
        console.log(formatJSON(limited));
        return;
      }

      if (limited.length === 0) {
        console.log('No episodes found.');
        return;
      }

      console.log(`Found ${episodes.length} episode${episodes.length === 1 ? '' : 's'}${episodes.length > limit ? ` (showing ${limit})` : ''}:\n`);

      for (const ep of limited) {
        const entityCount = ep.participants.length + ep.topics.length;
        console.log(`  [${ep.type}] ${ep.title} (${ep.timestamp})${entityCount > 0 ? ` — ${entityCount} entities` : ''}`);
      }
    } finally {
      store.close();
    }
  },
});
