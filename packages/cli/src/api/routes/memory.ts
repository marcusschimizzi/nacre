import { Hono } from 'hono';
import {
  appendCapture,
  mintMemoryId,
  resolveMemoryDir,
  resolveProvider,
  type MemoryNode,
  type MemoryObjectType,
  type SqliteStore,
} from '@nacre/core';
import { memoryCreateSchema, feedbackSchema } from '../schemas.js';
import { embedNodeBestEffort } from '../../embed-node.js';

const ENTITY_TO_MEMORY_TYPE: Record<string, MemoryObjectType> = {
  decision: 'decision',
  lesson: 'lesson',
};

export function memoryRoutes(store: SqliteStore, graphPath: string): Hono {
  const app = new Hono();
  // Resolved once so the embedding model (e.g. onnx) is loaded lazily and reused.
  const provider = resolveProvider({ graphPath, allowNull: true });

  app.post('/memories', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body) {
      return c.json({ error: { message: 'Invalid JSON body', code: 'BAD_REQUEST' } }, 400);
    }

    const parsed = memoryCreateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: {
            message: parsed.error.issues.map((i) => i.message).join('; '),
            code: 'VALIDATION_ERROR',
          },
        },
        400,
      );
    }

    const { content, type, label } = parsed.data;
    const id = mintMemoryId();
    const now = new Date().toISOString();

    // Two-phase write (V2-1): spool first (the durable act), then compile an
    // immediately-recallable candidate row. Canonical file at consolidation.
    const memoryDir = resolveMemoryDir(graphPath);
    if (memoryDir) {
      appendCapture(memoryDir, {
        id,
        ts: now,
        origin: 'api',
        payload: { content, type: ENTITY_TO_MEMORY_TYPE[type] ?? 'fact' },
      });
    }

    const node: MemoryNode = {
      id,
      label: label ?? content.slice(0, 60).replace(/\n/g, ' ').trim(),
      type,
      aliases: [],
      firstSeen: now,
      lastReinforced: now,
      mentionCount: 1,
      reinforcementCount: 0,
      sourceFiles: ['api'],
      excerpts: [{ file: 'api', text: content, date: now.slice(0, 10) }],
      status: 'candidate',
    };

    store.putNode(node);
    // Embed best-effort so the memory is immediately recallable by semantic search.
    const embedded = await embedNodeBestEffort(store, provider, node);
    // Clients must be able to tell a truth-layer-captured memory from a
    // database-only one — a missing memory dir is not silently durable.
    return c.json(
      {
        data: { ...node, embedded, captured: Boolean(memoryDir) },
        ...(memoryDir
          ? {}
          : {
              warning:
                'No memory directory configured — this memory is database-only and will not survive a rebuild. Configure memory.dir in nacre.config.json.',
            }),
      },
      201,
    );
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
      return c.json(
        {
          error: {
            message: parsed.error.issues.map((i) => i.message).join('; '),
            code: 'VALIDATION_ERROR',
          },
        },
        400,
      );
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
