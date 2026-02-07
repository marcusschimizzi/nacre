import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { SqliteStore } from '@nacre/core';
import { graphRoutes } from './routes/graph.js';
import { memoryRoutes } from './routes/memory.js';
import { intelligenceRoutes } from './routes/intelligence.js';
import { searchRoutes } from './routes/search.js';
import { systemRoutes } from './routes/system.js';
import { episodeRoutes } from './routes/episodes.js';
import { procedureRoutes } from './routes/procedures.js';
import { temporalRoutes } from './routes/temporal.js';
import { ingestRoutes } from './routes/ingest.js';

export interface CreateAppOptions {
  store: SqliteStore;
  graphPath: string;
  enableCors?: boolean;
}

export function createApp(opts: CreateAppOptions): Hono {
  const { store, graphPath, enableCors = true } = opts;
  const app = new Hono();

  if (enableCors) {
    app.use('/*', cors());
  }

  app.onError((err, c) => {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: { message, code: 'INTERNAL_ERROR' } }, 500);
  });

  app.notFound((c) => {
    return c.json({ error: { message: 'Not found', code: 'NOT_FOUND' } }, 404);
  });

  app.route('/api/v1', systemRoutes(store));
  app.route('/api/v1', graphRoutes(store));
  app.route('/api/v1', memoryRoutes(store));
  app.route('/api/v1', intelligenceRoutes(store, graphPath));
  app.route('/api/v1', searchRoutes(store));
  app.route('/api/v1', episodeRoutes(store));
  app.route('/api/v1', procedureRoutes(store));
  app.route('/api/v1', temporalRoutes(store));
  app.route('/api/v1', ingestRoutes(store, graphPath));

  return app;
}
