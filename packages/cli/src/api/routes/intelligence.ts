import { Hono } from 'hono';
import {
  generateBrief,
  generateAlerts,
  analyzeSignificance,
  generateSuggestions,
  type SqliteStore,
  type PendingEdge,
} from '@nacre/core';
import { consolidate } from '@nacre/parser';
import { consolidateSchema } from '../schemas.js';

export function intelligenceRoutes(store: SqliteStore, graphPath: string): Hono {
  const app = new Hono();

  app.get('/brief', (c) => {
    const top = parseInt(c.req.query('top') ?? '20', 10);
    const recentDays = parseInt(c.req.query('recentDays') ?? '7', 10);
    const graph = store.getFullGraph();
    const result = generateBrief(graph, { top, recentDays, now: new Date() });

    if (c.req.query('format') === 'text') {
      return c.text(result.summary);
    }
    return c.json({ data: result });
  });

  app.get('/alerts', (c) => {
    const graph = store.getFullGraph();
    const result = generateAlerts(graph, { now: new Date() });
    return c.json({ data: result });
  });

  app.get('/insights', (c) => {
    const recentDays = parseInt(c.req.query('recentDays') ?? '7', 10);
    const graph = store.getFullGraph();
    const result = analyzeSignificance(graph, { recentDays, now: new Date() });
    return c.json({ data: result });
  });

  app.get('/suggest', (c) => {
    const graph = store.getFullGraph();
    const pendingStr = store.getMeta('pending_edges');
    const pendingEdges: PendingEdge[] = pendingStr ? JSON.parse(pendingStr) : [];
    const maxSuggestions = parseInt(c.req.query('max') ?? '10', 10);
    const result = generateSuggestions(graph, pendingEdges, { maxSuggestions, now: new Date() });
    return c.json({ data: result });
  });

  app.post('/consolidate', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body) {
      return c.json({ error: { message: 'Invalid JSON body', code: 'BAD_REQUEST' } }, 400);
    }

    const parsed = consolidateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({
        error: { message: parsed.error.issues.map(i => i.message).join('; '), code: 'VALIDATION_ERROR' },
      }, 400);
    }

    const { inputs, outDir } = parsed.data;
    const result = await consolidate({
      inputs,
      outDir: outDir ?? graphPath,
    });

    return c.json({
      data: {
        newNodes: result.newNodes,
        newEdges: result.newEdges,
        reinforcedNodes: result.reinforcedNodes,
        decayedEdges: result.decayedEdges,
        newEmbeddings: result.newEmbeddings,
        failures: result.failures,
      },
    });
  });

  return app;
}
