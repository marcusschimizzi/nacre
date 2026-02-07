import { Hono } from 'hono';
import type { SqliteStore, Procedure, ProcedureType } from '@nacre/core';

export function procedureRoutes(store: SqliteStore): Hono {
  const app = new Hono();

  app.get('/procedures', (c) => {
    const type = c.req.query('type');
    const flagged = c.req.query('flagged');

    const procs = store.listProcedures({
      type: type as ProcedureType | undefined,
      flaggedOnly: flagged === 'true' ? true : undefined,
    });

    return c.json({ data: procs });
  });

  app.post('/procedures', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || !body.statement) {
      return c.json({ error: { message: 'Missing required field: statement', code: 'BAD_REQUEST' } }, 400);
    }

    const timestamp = new Date().toISOString();
    const statement: string = body.statement;
    const type: ProcedureType = body.type ?? 'insight';

    const keywords: string[] = body.keywords ??
      statement.toLowerCase().split(/[^a-z0-9]+/).filter((t: string) => t.length >= 3);

    let hash = 0;
    const key = `proc:${statement}`;
    for (let i = 0; i < key.length; i++) {
      const ch = key.charCodeAt(i);
      hash = ((hash << 5) - hash + ch) | 0;
    }
    const id = `proc-${Math.abs(hash).toString(36)}`;

    const proc: Procedure = {
      id,
      statement,
      type,
      triggerKeywords: [...new Set(keywords)],
      triggerContexts: body.contexts ?? [],
      sourceEpisodes: [],
      sourceNodes: [],
      confidence: 0.5,
      applications: 0,
      contradictions: 0,
      stability: 1.0,
      lastApplied: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      flaggedForReview: false,
    };

    store.putProcedure(proc);
    return c.json({ data: proc }, 201);
  });

  app.post('/procedures/:id/apply', async (c) => {
    const id = c.req.param('id');
    const proc = store.getProcedure(id);
    if (!proc) {
      return c.json({ error: { message: 'Procedure not found', code: 'NOT_FOUND' } }, 404);
    }

    const body = await c.req.json().catch(() => null);
    const feedback: string = body?.feedback ?? 'neutral';
    const now = new Date().toISOString();

    const updated: Procedure = { ...proc, lastApplied: now, updatedAt: now };

    if (feedback === 'positive') {
      updated.applications += 1;
      updated.confidence = Math.min(0.99, proc.confidence + 0.1 * (1 - proc.confidence));
      updated.stability = Math.min(2, proc.stability + 0.1);
    } else if (feedback === 'negative') {
      updated.contradictions += 1;
      updated.confidence = Math.max(0.01, proc.confidence * 0.8);
      if (updated.contradictions >= 3 && updated.confidence < 0.3) {
        updated.flaggedForReview = true;
      }
    }

    store.putProcedure(updated);
    return c.json({ data: updated });
  });

  return app;
}
