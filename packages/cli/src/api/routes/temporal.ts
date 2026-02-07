import { Hono } from 'hono';
import type { SqliteStore } from '@nacre/core';
import { diffSnapshots } from '@nacre/core';

export function temporalRoutes(store: SqliteStore): Hono {
  const app = new Hono();

  app.get('/snapshots', (c) => {
    const since = c.req.query('since');
    const until = c.req.query('until');
    const limit = parseInt(c.req.query('limit') ?? '50', 10);

    const snapshots = store.listSnapshots({
      since: since ?? undefined,
      until: until ?? undefined,
      limit,
    });

    return c.json({ data: snapshots });
  });

  app.post('/snapshots', (c) => {
    const snapshot = store.createSnapshot('manual');
    return c.json({ data: snapshot }, 201);
  });

  app.get('/snapshots/:id', (c) => {
    const id = c.req.param('id');
    const snapshot = store.getSnapshot(id);
    if (!snapshot) {
      return c.json({ error: { message: 'Snapshot not found', code: 'NOT_FOUND' } }, 404);
    }
    return c.json({ data: snapshot });
  });

  app.get('/snapshots/:id/graph', (c) => {
    const id = c.req.param('id');
    const snapshot = store.getSnapshot(id);
    if (!snapshot) {
      return c.json({ error: { message: 'Snapshot not found', code: 'NOT_FOUND' } }, 404);
    }

    const graph = store.getSnapshotGraph(id);
    return c.json({ data: { snapshot, graph } });
  });

  app.delete('/snapshots/:id', (c) => {
    const id = c.req.param('id');
    const snapshot = store.getSnapshot(id);
    if (!snapshot) {
      return c.json({ error: { message: 'Snapshot not found', code: 'NOT_FOUND' } }, 404);
    }

    store.deleteSnapshot(id);
    return c.json({ data: { deleted: id } });
  });

  app.get('/diff/:from/:to', (c) => {
    const fromId = c.req.param('from');
    const toId = c.req.param('to');

    const fromSnap = store.getSnapshot(fromId);
    if (!fromSnap) {
      return c.json({ error: { message: `Snapshot not found: ${fromId}`, code: 'NOT_FOUND' } }, 404);
    }

    const toSnap = store.getSnapshot(toId);
    if (!toSnap) {
      return c.json({ error: { message: `Snapshot not found: ${toId}`, code: 'NOT_FOUND' } }, 404);
    }

    const diff = diffSnapshots(store, fromId, toId);
    return c.json({ data: diff });
  });

  app.get('/history/node/:id', (c) => {
    const id = c.req.param('id');
    const history = store.getNodeHistory(id);
    return c.json({ data: history });
  });

  app.get('/history/edge/:id', (c) => {
    const id = c.req.param('id');
    const history = store.getEdgeHistory(id);
    return c.json({ data: history });
  });

  return app;
}
