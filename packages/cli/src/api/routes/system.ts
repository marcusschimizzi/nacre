import { Hono } from 'hono';
import type { SqliteStore } from '@nacre/core';

const startTime = Date.now();

export function systemRoutes(store: SqliteStore): Hono {
  const app = new Hono();

  app.get('/health', (c) => {
    return c.json({
      data: {
        status: 'ok',
        version: '0.1.0',
        nodeCount: store.nodeCount(),
        edgeCount: store.edgeCount(),
        uptime: Math.floor((Date.now() - startTime) / 1000),
      },
    });
  });

  return app;
}
