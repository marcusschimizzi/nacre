import { Hono } from 'hono';
import {
  filterGraphByScopes,
  nodeVisibleInScopes,
  parseScopesFilter,
  recordVisibleInScopes,
} from '@nacre/core';
import type { SqliteStore, EntityType, EdgeType } from '@nacre/core';

function visibleNodeIds(store: SqliteStore, scopes?: string[]): Set<string> {
  return new Set(
    store
      .listNodes()
      .filter((node) => nodeVisibleInScopes(node, scopes))
      .map((node) => node.id),
  );
}

export function graphRoutes(store: SqliteStore): Hono {
  const app = new Hono();

  app.get('/nodes', (c) => {
    const type = c.req.query('type') as EntityType | undefined;
    const label = c.req.query('label');
    const limit = parseInt(c.req.query('limit') ?? '100', 10);
    const offset = parseInt(c.req.query('offset') ?? '0', 10);
    const scopes = parseScopesFilter(c.req.query('scopes'));

    const nodes = store
      .listNodes({
        type: type || undefined,
        label: label || undefined,
      })
      .filter((node) => nodeVisibleInScopes(node, scopes));

    return c.json({ data: nodes.slice(offset, offset + limit) });
  });

  app.get('/nodes/:id', (c) => {
    const id = c.req.param('id');
    const scopes = parseScopesFilter(c.req.query('scopes'));
    const node = store.getNode(id);
    if (!node || !nodeVisibleInScopes(node, scopes)) {
      return c.json({ error: { message: 'Node not found', code: 'NOT_FOUND' } }, 404);
    }

    const edges = store.listEdges({ source: id });
    const targetEdges = store.listEdges({ target: id });
    const visibleIds = visibleNodeIds(store, scopes);
    const visibleEdges = [...edges, ...targetEdges].filter(
      (edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target),
    );

    return c.json({ data: { node, edges: visibleEdges } });
  });

  app.get('/edges', (c) => {
    const source = c.req.query('source');
    const target = c.req.query('target');
    const type = c.req.query('type') as EdgeType | undefined;
    const minWeight = c.req.query('minWeight');
    const limit = parseInt(c.req.query('limit') ?? '1000', 10);
    const offset = parseInt(c.req.query('offset') ?? '0', 10);
    const visibleIds = visibleNodeIds(store, parseScopesFilter(c.req.query('scopes')));

    const edges = store
      .listEdges({
        source: source || undefined,
        target: target || undefined,
        type: type || undefined,
        minWeight: minWeight ? parseFloat(minWeight) : undefined,
      })
      .filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target));

    return c.json({ data: edges.slice(offset, offset + limit) });
  });

  app.get('/graph', (c) => {
    // Full graph (nodes + edges + config) for the dashboard's live view.
    // Shape matches NacreGraph, which is what the dashboard loader expects.
    return c.json({
      data: filterGraphByScopes(store.getFullGraph(), parseScopesFilter(c.req.query('scopes'))),
    });
  });

  app.get('/graph/stats', (c) => {
    const scopes = parseScopesFilter(c.req.query('scopes'));
    const graph = filterGraphByScopes(store.getFullGraph(), scopes);
    const edges = Object.values(graph.edges);
    const nodes = Object.values(graph.nodes);
    let weightSum = 0;
    for (const e of edges) weightSum += e.weight;

    const nodesByType: Record<string, number> = {};
    for (const n of nodes) {
      nodesByType[n.type] = (nodesByType[n.type] ?? 0) + 1;
    }

    // Count embeddings using the same owner visibility as /similar. Orphaned
    // rows are hidden, and node ownership wins over a same-ID episode.
    const embeddingIds = new Set(nodes.map((node) => node.id));
    for (const episode of store.listEpisodes()) {
      if (!store.getNode(episode.id) && recordVisibleInScopes(episode, scopes)) {
        embeddingIds.add(episode.id);
      }
    }
    let embeddingCount = 0;
    for (const id of embeddingIds) {
      if (store.getEmbedding(id)) embeddingCount += 1;
    }

    return c.json({
      data: {
        nodeCount: nodes.length,
        edgeCount: edges.length,
        embeddingCount,
        avgWeight: edges.length > 0 ? weightSum / edges.length : 0,
        lastConsolidated: store.getMeta('last_consolidated') ?? null,
        nodesByType,
      },
    });
  });

  return app;
}
