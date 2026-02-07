import { Hono } from 'hono';
import {
  searchNodes,
  recall,
  MockEmbedder,
  OllamaEmbedder,
  type SqliteStore,
  type EntityType,
  type EmbeddingProvider,
} from '@nacre/core';

function getProvider(name: string): EmbeddingProvider {
  switch (name) {
    case 'ollama': return new OllamaEmbedder();
    case 'mock': return new MockEmbedder();
    default: return new OllamaEmbedder();
  }
}

export function searchRoutes(store: SqliteStore): Hono {
  const app = new Hono();

  app.get('/query', (c) => {
    const q = c.req.query('q');
    if (!q) {
      return c.json({ error: { message: 'Missing query parameter q', code: 'BAD_REQUEST' } }, 400);
    }

    const type = c.req.query('type') as EntityType | undefined;
    const limit = parseInt(c.req.query('limit') ?? '20', 10);
    const graph = store.getFullGraph();
    const terms = q.split(/\s+/).filter(t => t.length > 0);
    const results = searchNodes(graph, terms, { type: type || undefined, now: new Date() });

    if (c.req.query('format') === 'text') {
      const text = results.slice(0, limit).map(r =>
        `${r.node.label} (${r.node.type}) — score: ${r.matchScore.toFixed(2)}`
      ).join('\n');
      return c.text(text || 'No results');
    }

    return c.json({ data: results.slice(0, limit) });
  });

  app.get('/similar', async (c) => {
    const q = c.req.query('q');
    if (!q) {
      return c.json({ error: { message: 'Missing query parameter q', code: 'BAD_REQUEST' } }, 400);
    }

    if (store.embeddingCount() === 0) {
      return c.json({ error: { message: 'No embeddings found. Run nacre embed first.', code: 'NO_EMBEDDINGS' } }, 400);
    }

    const providerName = c.req.query('provider') ?? 'ollama';
    const limit = parseInt(c.req.query('limit') ?? '10', 10);
    const threshold = parseFloat(c.req.query('threshold') ?? '0');
    const type = c.req.query('type');

    const provider = getProvider(providerName);
    const queryVec = await provider.embed(q);
    const results = store.searchSimilar(queryVec, {
      limit,
      minSimilarity: threshold,
      type: type || undefined,
    });

    return c.json({ data: results });
  });

  app.get('/recall', async (c) => {
    const q = c.req.query('q');
    if (!q) {
      return c.json({ error: { message: 'Missing query parameter q', code: 'BAD_REQUEST' } }, 400);
    }

    const providerName = c.req.query('provider') ?? 'mock';
    const limit = parseInt(c.req.query('limit') ?? '10', 10);
    const hops = parseInt(c.req.query('hops') ?? '2', 10);
    const since = c.req.query('since') || undefined;
    const until = c.req.query('until') || undefined;
    const typesRaw = c.req.query('types');
    const types = typesRaw
      ? typesRaw.split(',').map((t) => t.trim()) as EntityType[]
      : undefined;

    const provider: EmbeddingProvider | null =
      store.embeddingCount() > 0
        ? getProvider(providerName)
        : null;

    const response = await recall(store, provider, {
      query: q,
      limit,
      types,
      since,
      until,
      hops,
    });

    return c.json({ data: response.results, procedures: response.procedures });
  });

  return app;
}
