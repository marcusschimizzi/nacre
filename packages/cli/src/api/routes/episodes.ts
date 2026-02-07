import { Hono } from 'hono';
import type { SqliteStore } from '@nacre/core';
import type { EpisodeFilter } from '@nacre/core';

export function episodeRoutes(store: SqliteStore): Hono {
  const app = new Hono();

  app.get('/episodes', (c) => {
    const type = c.req.query('type');
    const since = c.req.query('since');
    const until = c.req.query('until');
    const entity = c.req.query('entity');
    const limit = parseInt(c.req.query('limit') ?? '50', 10);
    const offset = parseInt(c.req.query('offset') ?? '0', 10);

    let hasEntity: string | undefined;
    if (entity) {
      const node = store.findNode(entity);
      if (node) hasEntity = node.id;
    }

    const filter: EpisodeFilter = {};
    if (type) filter.type = type as EpisodeFilter['type'];
    if (since) filter.since = since;
    if (until) filter.until = until;
    if (hasEntity) filter.hasEntity = hasEntity;

    const episodes = store.listEpisodes(filter);
    const paged = episodes.slice(offset, offset + limit);

    return c.json({ data: paged });
  });

  app.get('/episodes/:id', (c) => {
    const id = c.req.param('id');
    const episode = store.getEpisode(id);
    if (!episode) {
      return c.json({ error: { message: 'Episode not found', code: 'NOT_FOUND' } }, 404);
    }

    const entities = store.getEpisodeEntities(id);
    return c.json({ data: { episode, entities } });
  });

  app.post('/episodes/:id/touch', (c) => {
    const id = c.req.param('id');
    const episode = store.getEpisode(id);
    if (!episode) {
      return c.json({ error: { message: 'Episode not found', code: 'NOT_FOUND' } }, 404);
    }

    store.touchEpisode(id);
    const updated = store.getEpisode(id)!;
    return c.json({ data: { id, accessCount: updated.accessCount, lastAccessed: updated.lastAccessed } });
  });

  return app;
}
