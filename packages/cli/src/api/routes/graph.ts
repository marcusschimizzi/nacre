import { Hono } from 'hono';
import type { SqliteStore, EntityType, EdgeType } from '@nacre/core';

export function graphRoutes(store: SqliteStore): Hono {
  const app = new Hono();

  app.get('/nodes', (c) => {
    const type = c.req.query('type') as EntityType | undefined;
    const label = c.req.query('label');
    const limit = parseInt(c.req.query('limit') ?? '100', 10);
    const offset = parseInt(c.req.query('offset') ?? '0', 10);

    const nodes = store.listNodes({
      type: type || undefined,
      label: label || undefined,
    });

    return c.json({ data: nodes.slice(offset, offset + limit) });
  });

  app.get('/nodes/:id', (c) => {
    const id = c.req.param('id');
    const node = store.getNode(id);
    if (!node) {
      return c.json({ error: { message: 'Node not found', code: 'NOT_FOUND' } }, 404);
    }

    const edges = store.listEdges({ source: id });
    const targetEdges = store.listEdges({ target: id });

    return c.json({ data: { node, edges: [...edges, ...targetEdges] } });
  });

  app.get('/edges', (c) => {
    const source = c.req.query('source');
    const target = c.req.query('target');
    const type = c.req.query('type') as EdgeType | undefined;
    const minWeight = c.req.query('minWeight');
    const limit = parseInt(c.req.query('limit') ?? '1000', 10);
    const offset = parseInt(c.req.query('offset') ?? '0', 10);

    const edges = store.listEdges({
      source: source || undefined,
      target: target || undefined,
      type: type || undefined,
      minWeight: minWeight ? parseFloat(minWeight) : undefined,
    });

    return c.json({ data: edges.slice(offset, offset + limit) });
  });

  app.get('/graph/stats', (c) => {
    const graph = store.getFullGraph();
    const edges = Object.values(graph.edges);
    const nodes = Object.values(graph.nodes);
    let weightSum = 0;
    for (const e of edges) weightSum += e.weight;

    const nodesByType: Record<string, number> = {};
    for (const n of nodes) {
      nodesByType[n.type] = (nodesByType[n.type] ?? 0) + 1;
    }

    return c.json({
      data: {
        nodeCount: store.nodeCount(),
        edgeCount: store.edgeCount(),
        embeddingCount: store.embeddingCount(),
        avgWeight: edges.length > 0 ? weightSum / edges.length : 0,
        lastConsolidated: store.getMeta('last_consolidated') ?? null,
        nodesByType,
      },
    });
  });

  return app;
}
