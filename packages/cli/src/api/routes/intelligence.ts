import { isAbsolute, relative, resolve } from 'node:path';
import { Hono } from 'hono';
import {
  SqliteStore,
  generateBrief,
  generateAlerts,
  analyzeSignificance,
  generateSuggestions,
  consolidateTruthLayer,
  filterGraphByScopes,
  loadConfig,
  parseScopesFilter,
  purgeExpiredScratch,
  resolveMemoryDir,
  type PendingEdge,
} from '@nacre/core';
import { consolidate } from '@nacre/parser';
import { consolidateSchema } from '../schemas.js';

/** True if `target` resolves to a path inside `root` (no traversal / absolute escape). */
function isWithin(root: string, target: string): boolean {
  const rel = relative(root, resolve(root, target));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function intelligenceRoutes(
  store: SqliteStore,
  graphPath: string,
  consolidateRoot: string,
): Hono {
  const app = new Hono();

  app.get('/brief', (c) => {
    const top = parseInt(c.req.query('top') ?? '20', 10);
    const recentDays = parseInt(c.req.query('recentDays') ?? '7', 10);
    const scopes = parseScopesFilter(c.req.query('scopes'));
    const graph = filterGraphByScopes(store.getFullGraph(), scopes);
    const result = generateBrief(graph, { top, recentDays, now: new Date() });

    if (c.req.query('format') === 'text') {
      return c.text(result.summary);
    }
    return c.json({ data: result });
  });

  app.get('/alerts', (c) => {
    const graph = filterGraphByScopes(store.getFullGraph());
    const result = generateAlerts(graph, { now: new Date() });
    return c.json({ data: result });
  });

  app.get('/insights', (c) => {
    const recentDays = parseInt(c.req.query('recentDays') ?? '7', 10);
    const graph = filterGraphByScopes(store.getFullGraph());
    const result = analyzeSignificance(graph, { recentDays, now: new Date() });
    return c.json({ data: result });
  });

  app.get('/suggest', (c) => {
    const graph = filterGraphByScopes(store.getFullGraph());
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

    const { inputs, outDir } = parsed.data;

    // Confine filesystem access to the configured root so a remote caller can't
    // read/write arbitrary paths (e.g. /etc, ../../secrets) via this endpoint.
    const escapes =
      inputs.some((p) => !isWithin(consolidateRoot, p)) ||
      (outDir !== undefined && !isWithin(consolidateRoot, outDir));
    if (escapes) {
      return c.json(
        {
          error: {
            message: 'inputs/outDir must stay within the server’s allowed directory',
            code: 'FORBIDDEN_PATH',
          },
        },
        400,
      );
    }

    const target = outDir ?? graphPath;
    // Same overlap rule as CLI consolidate: the canonical memory dir has its
    // own compile path — never raw-ingest it.
    const memoryDir = target.endsWith('.db') ? resolveMemoryDir(target) : null;

    const result = await consolidate({
      inputs,
      outDir: target,
      ignore: memoryDir ? [memoryDir] : undefined,
    });

    // The truth-layer sequence runs on EVERY consolidation surface — without
    // it, API/MCP captures would never be promoted to canonical files.
    let truthLayer: ReturnType<typeof consolidateTruthLayer> | null = null;
    let standalonePurge: ReturnType<typeof purgeExpiredScratch> | null = null;
    if (!memoryDir && target.endsWith('.db')) {
      // Session scratch expires even on database-only setups.
      const sameStore = target === graphPath;
      const purgeStore = sameStore ? store : SqliteStore.open(target);
      try {
        standalonePurge = purgeExpiredScratch(purgeStore, loadConfig(target).scopes);
      } finally {
        if (!sameStore) purgeStore.close();
      }
    }
    if (memoryDir) {
      // Reuse the bound store when consolidating into the served graph;
      // otherwise open the target store for the duration.
      const sameStore = target === graphPath;
      const truthStore = sameStore ? store : SqliteStore.open(target);
      try {
        truthLayer = consolidateTruthLayer(truthStore, memoryDir, {
          scopeOverrides: loadConfig(target).scopes,
        });
      } finally {
        if (!sameStore) truthStore.close();
      }
    }

    const data = {
      newNodes: result.newNodes,
      newEdges: result.newEdges,
      reinforcedNodes: result.reinforcedNodes,
      decayedEdges: result.decayedEdges,
      newEmbeddings: result.newEmbeddings,
      failures: result.failures,
      truthLayer: truthLayer
        ? {
            promoted: truthLayer.promotion.promoted,
            salienceUpdated: truthLayer.salience.updated.length,
            compiledMemories: truthLayer.compiled.memories,
            removed: truthLayer.compiled.removed,
            edgesRemoved: truthLayer.compiled.edgesRemoved,
            purged: truthLayer.purged,
            warnings: truthLayer.warnings,
            errors: truthLayer.errors,
          }
        : null,
      ...(standalonePurge ? { purged: standalonePurge } : {}),
    };

    // Same contract as CLI consolidate (non-zero exit): truth-layer errors
    // mean entries/files were NOT processed — never a silent 200.
    if (truthLayer && truthLayer.errors.length > 0) {
      return c.json(
        {
          error: {
            message: `Consolidation completed with ${truthLayer.errors.length} truth-layer error(s) — these entries/files were not processed`,
            code: 'TRUTH_LAYER_ERRORS',
          },
          data,
        },
        500,
      );
    }

    return c.json({ data });
  });

  return app;
}
