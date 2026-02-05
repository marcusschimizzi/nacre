import { Hono } from 'hono';
import { randomBytes } from 'node:crypto';
import type { SqliteStore, MemoryNode } from '@nacre/core';
import { memoryCreateSchema, feedbackSchema } from '../schemas.js';

export function memoryRoutes(store: SqliteStore): Hono {
  const app = new Hono();

  app.post('/memories', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body) {
      return c.json({ error: { message: 'Invalid JSON body', code: 'BAD_REQUEST' } }, 400);
    }

    const parsed = memoryCreateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({
        error: { message: parsed.error.issues.map(i => i.message).join('; '), code: 'VALIDATION_ERROR' },
      }, 400);
    }

    const { content, type, label } = parsed.data;
    const id = randomBytes(8).toString('hex');
    const now = new Date().toISOString();

    const node: MemoryNode = {
      id,
      label: label ?? content.slice(0, 60).replace(/\n/g, ' ').trim(),
      type,
      aliases: [],
      firstSeen: now,
      lastReinforced: now,
      mentionCount: 1,
      reinforcementCount: 0,
      sourceFiles: [],
      excerpts: [{ file: 'api', text: content, date: now.slice(0, 10) }],
    };

    store.putNode(node);
    return c.json({ data: node }, 201);
  });

  app.delete('/memories/:id', (c) => {
    const id = c.req.param('id');
    const node = store.getNode(id);
    if (!node) {
      return c.json({ error: { message: 'Memory not found', code: 'NOT_FOUND' } }, 404);
    }

    store.deleteNode(id);
    store.deleteEmbedding(id);
    return c.json({ data: { deleted: id } });
  });

  app.post('/feedback', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body) {
      return c.json({ error: { message: 'Invalid JSON body', code: 'BAD_REQUEST' } }, 400);
    }

    const parsed = feedbackSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({
        error: { message: parsed.error.issues.map(i => i.message).join('; '), code: 'VALIDATION_ERROR' },
      }, 400);
    }

    const { memoryId, rating } = parsed.data;
    const node = store.getNode(memoryId);
    if (!node) {
      return c.json({ error: { message: 'Memory not found', code: 'NOT_FOUND' } }, 404);
    }

    const edges = [
      ...store.listEdges({ source: memoryId }),
      ...store.listEdges({ target: memoryId }),
    ];

    let updated = 0;
    const now = new Date().toISOString();

    if (rating > 0) {
      node.reinforcementCount += 1;
      node.lastReinforced = now;
      store.putNode(node);

      for (const edge of edges) {
        edge.reinforcementCount += 1;
        edge.lastReinforced = now;
        edge.stability = Math.min(edge.stability * (1 + rating), 10);
        store.putEdge(edge);
        updated++;
      }
    } else if (rating < 0) {
      for (const edge of edges) {
        edge.weight = Math.max(0, edge.weight + rating * 0.2);
        edge.stability = Math.max(0.1, edge.stability * (1 + rating * 0.5));
        store.putEdge(edge);
        updated++;
      }
    }

    return c.json({ data: { memoryId, rating, edgesUpdated: updated } });
  });

  return app;
}
