import { defineCommand } from 'citty';
import { serve } from '@hono/node-server';
import { SqliteStore } from '@nacre/core';
import { createApp } from '../api/server.js';

export default defineCommand({
  meta: {
    name: 'api',
    description: 'Start the HTTP API server',
  },
  args: {
    graph: {
      type: 'string',
      description: 'Path to graph database (.db)',
      required: true,
    },
    port: {
      type: 'string',
      description: 'Server port',
      default: '3200',
    },
    host: {
      type: 'string',
      description: 'Server host',
      default: '0.0.0.0',
    },
    cors: {
      type: 'boolean',
      description: 'Enable CORS',
      default: true,
    },
  },
  async run({ args }) {
    const graphPath = args.graph as string;
    if (!graphPath.endsWith('.db')) {
      console.error('API server requires a SQLite graph (.db file)');
      process.exit(1);
    }

    const store = SqliteStore.open(graphPath);
    const port = parseInt(args.port as string, 10);
    const hostname = args.host as string;

    const app = createApp({
      store,
      graphPath,
      enableCors: args.cors as boolean,
    });

    const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
      console.log(`nacre API server running at http://${hostname === '0.0.0.0' ? 'localhost' : hostname}:${info.port}`);
      console.log(`Graph: ${graphPath} (${store.nodeCount()} nodes, ${store.edgeCount()} edges)`);
      console.log('');
      console.log('Endpoints:');
      console.log('  GET  /api/v1/health');
      console.log('  GET  /api/v1/nodes');
      console.log('  GET  /api/v1/nodes/:id');
      console.log('  GET  /api/v1/edges');
      console.log('  GET  /api/v1/graph/stats');
      console.log('  POST /api/v1/memories');
      console.log('  DELETE /api/v1/memories/:id');
      console.log('  POST /api/v1/feedback');
      console.log('  GET  /api/v1/brief');
      console.log('  GET  /api/v1/alerts');
      console.log('  GET  /api/v1/insights');
      console.log('  GET  /api/v1/suggest');
      console.log('  POST /api/v1/consolidate');
      console.log('  GET  /api/v1/query?q=...');
      console.log('  GET  /api/v1/similar?q=...');
    });

    const shutdown = () => {
      console.log('\nShutting down...');
      server.close();
      store.close();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  },
});
