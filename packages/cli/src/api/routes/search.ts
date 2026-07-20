import { Hono } from 'hono';
import {
  searchNodes,
  recall,
  resolveProvider,
  filterGraphByScopes,
  nodeVisibleInScopes,
  parseScopesFilter,
  recordVisibleInScopes,
  EncoderMismatchError,
  type SqliteStore,
  type EntityType,
} from '@nacre/core';

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
    const terms = q.split(/\s+/).filter((t) => t.length > 0);
    const results = searchNodes(graph, terms, { type: type || undefined, now: new Date() });

    if (c.req.query('format') === 'text') {
      const text = results
        .slice(0, limit)
        .map((r) => `${r.node.label} (${r.node.type}) — score: ${r.matchScore.toFixed(2)}`)
        .join('\n');
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
      return c.json(
        {
          error: { message: 'No embeddings found. Run nacre embed first.', code: 'NO_EMBEDDINGS' },
        },
        400,
      );
    }

    const providerName = c.req.query('provider') ?? 'ollama';
    const limit = parseInt(c.req.query('limit') ?? '10', 10);
    const threshold = parseFloat(c.req.query('threshold') ?? '0');
    const type = c.req.query('type');
    const scopes = parseScopesFilter(c.req.query('scopes'));

    const provider = resolveProvider({ provider: providerName, allowNull: false });
    const queryVec = await provider!.embed(q);
    try {
      const results = store
        .searchSimilar(queryVec, {
          // Always over-fetch: the visibility filter below runs on every
          // request (session is hidden even by default) and must not starve
          // the page.
          limit: limit * 3,
          minSimilarity: threshold,
          type: type || undefined,
        })
        .filter((r) => {
          // Fail closed: resolve the row to its node or episode and apply
          // that record's scope. Unresolvable rows are dropped — admitting
          // them let episode content bypass an explicit scopes filter.
          const node = store.getNode(r.id);
          if (node) return nodeVisibleInScopes(node, scopes);
          const episode = store.getEpisode(r.id);
          if (episode) return recordVisibleInScopes(episode, scopes);
          return false;
        })
        .slice(0, limit);
      return c.json({ data: results });
    } catch (err) {
      // Configuration error with a known remedy — a 409, not a crash/500.
      if (err instanceof EncoderMismatchError) {
        return c.json({ error: { message: err.message, code: 'ENCODER_MISMATCH' } }, 409);
      }
      throw err;
    }
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
    const types = typesRaw ? (typesRaw.split(',').map((t) => t.trim()) as EntityType[]) : undefined;
    const recallScopes = parseScopesFilter(c.req.query('scopes'));

    const provider = resolveProvider({ provider: providerName, allowNull: true });

    try {
      const response = await recall(store, provider, {
        query: q,
        limit,
        types,
        since,
        until,
        hops,
        scopes: recallScopes,
      });
      return c.json({ data: response.results, procedures: response.procedures });
    } catch (err) {
      // Same contract as /similar: an encoder/fingerprint mismatch is a
      // configuration error with a known remedy — a 409, not a 500.
      if (err instanceof EncoderMismatchError) {
        return c.json({ error: { message: err.message, code: 'ENCODER_MISMATCH' } }, 409);
      }
      throw err;
    }
  });

  return app;
}
