import { Hono } from 'hono';
import { filterGraphByScopes, parseScopesFilter, type SqliteStore } from '@nacre/core';

const startTime = Date.now();

export function systemRoutes(store: SqliteStore): Hono {
  const app = new Hono();

  app.get('/health', (c) => {
    const graph = filterGraphByScopes(
      store.getFullGraph(),
      parseScopesFilter(c.req.query('scopes')),
    );
    return c.json({
      data: {
        status: 'ok',
        version: '0.1.0',
        nodeCount: Object.keys(graph.nodes).length,
        edgeCount: Object.keys(graph.edges).length,
        uptime: Math.floor((Date.now() - startTime) / 1000),
      },
    });
  });

  return app;
}
