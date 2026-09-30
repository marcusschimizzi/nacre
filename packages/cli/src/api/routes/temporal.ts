import { Hono } from 'hono';
import {
  diffSnapshots,
  filterGraphByScopes,
  nodeVisibleInScopes,
  parseScopesFilter,
  type MemoryNode,
  type NacreGraph,
  type Snapshot,
  type SqliteStore,
} from '@nacre/core';

function visibleSnapshot(snapshot: Snapshot, graph: NacreGraph) {
  // Snapshots retain graph states, but not historical episode scopes or the
  // provenance of arbitrary metadata. Do not expose those unfilterable fields.
  return {
    id: snapshot.id,
    createdAt: snapshot.createdAt,
    trigger: snapshot.trigger,
    nodeCount: Object.keys(graph.nodes).length,
    edgeCount: Object.keys(graph.edges).length,
  };
}

export function temporalRoutes(store: SqliteStore): Hono {
  const app = new Hono();

  app.get('/snapshots', (c) => {
    const since = c.req.query('since');
    const until = c.req.query('until');
    const limit = parseInt(c.req.query('limit') ?? '50', 10);
    const scopes = parseScopesFilter(c.req.query('scopes'));

    const snapshots = store.listSnapshots({
      since: since ?? undefined,
      until: until ?? undefined,
      limit,
    });

    return c.json({
      data: snapshots.map((snapshot) =>
        visibleSnapshot(snapshot, filterGraphByScopes(store.getSnapshotGraph(snapshot.id), scopes)),
      ),
    });
  });

  app.post('/snapshots', (c) => {
    const snapshot = store.createSnapshot('manual');
    const graph = filterGraphByScopes(
      store.getSnapshotGraph(snapshot.id),
      parseScopesFilter(c.req.query('scopes')),
    );
    return c.json({ data: visibleSnapshot(snapshot, graph) }, 201);
  });

  app.get('/snapshots/:id', (c) => {
    const id = c.req.param('id');
    const snapshot = store.getSnapshot(id);
    if (!snapshot) {
      return c.json({ error: { message: 'Snapshot not found', code: 'NOT_FOUND' } }, 404);
    }
    const graph = filterGraphByScopes(
      store.getSnapshotGraph(id),
      parseScopesFilter(c.req.query('scopes')),
    );
    return c.json({ data: visibleSnapshot(snapshot, graph) });
  });

  app.get('/snapshots/:id/graph', (c) => {
    const id = c.req.param('id');
    const snapshot = store.getSnapshot(id);
    if (!snapshot) {
      return c.json({ error: { message: 'Snapshot not found', code: 'NOT_FOUND' } }, 404);
    }

    const graph = filterGraphByScopes(
      store.getSnapshotGraph(id),
      parseScopesFilter(c.req.query('scopes')),
    );
    return c.json({ data: { snapshot: visibleSnapshot(snapshot, graph), graph } });
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
      return c.json(
        { error: { message: `Snapshot not found: ${fromId}`, code: 'NOT_FOUND' } },
        404,
      );
    }

    const toSnap = store.getSnapshot(toId);
    if (!toSnap) {
      return c.json({ error: { message: `Snapshot not found: ${toId}`, code: 'NOT_FOUND' } }, 404);
    }

    const diff = diffSnapshots(store, fromId, toId, parseScopesFilter(c.req.query('scopes')));
    return c.json({ data: diff });
  });

  app.get('/history/node/:id', (c) => {
    const id = c.req.param('id');
    const history = store.getNodeHistory(id);
    const scopes = parseScopesFilter(c.req.query('scopes'));
    return c.json({
      data: {
        ...history,
        snapshots: history.snapshots.filter(({ state }) =>
          nodeVisibleInScopes(state as MemoryNode, scopes),
        ),
      },
    });
  });

  app.get('/history/edge/:id', (c) => {
    const id = c.req.param('id');
    const history = store.getEdgeHistory(id);
    const scopes = parseScopesFilter(c.req.query('scopes'));
    return c.json({
      data: {
        ...history,
        // Endpoint visibility must come from this snapshot, even if the live
        // nodes have since moved scopes or been deleted.
        snapshots: history.snapshots.filter(({ snapshotId }) =>
          Boolean(filterGraphByScopes(store.getSnapshotGraph(snapshotId), scopes).edges[id]),
        ),
      },
    });
  });

  return app;
}
