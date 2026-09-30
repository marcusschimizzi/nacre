import { Hono } from 'hono';
import {
  nodeVisibleInScopes,
  parseScopesFilter,
  recordVisibleInScopes,
  type SqliteStore,
  type Episode,
  type EpisodeFilter,
} from '@nacre/core';

/** Linked memories obey the same read filter as the episode containing them. */
export function visibleEpisode(episode: Episode, store: SqliteStore, scopes?: string[]): Episode {
  const visibleNode = (id: string): boolean => {
    const node = store.getNode(id);
    return !!node && nodeVisibleInScopes(node, scopes);
  };
  const parent = episode.parentId ? store.getEpisode(episode.parentId) : undefined;
  return {
    ...episode,
    parentId: parent && recordVisibleInScopes(parent, scopes) ? parent.id : undefined,
    participants: episode.participants.filter(visibleNode),
    topics: episode.topics.filter(visibleNode),
    ...(episode.outcomes ? { outcomes: episode.outcomes.filter(visibleNode) } : {}),
  };
}

export function episodeRoutes(store: SqliteStore): Hono {
  const app = new Hono();

  app.get('/episodes', (c) => {
    const type = c.req.query('type');
    const since = c.req.query('since');
    const until = c.req.query('until');
    const entity = c.req.query('entity');
    const scopes = parseScopesFilter(c.req.query('scopes'));
    const limit = parseInt(c.req.query('limit') ?? '50', 10);
    const offset = parseInt(c.req.query('offset') ?? '0', 10);

    let hasEntity: string | undefined;
    if (entity) {
      // Resolve inside the visible slice so a hidden same-label node cannot
      // shadow a visible entity. A missing/hidden entity is never an unfiltered read.
      const nodes = store.listNodes().filter((node) => nodeVisibleInScopes(node, scopes));
      const normalized = entity.trim().toLowerCase();
      const node =
        nodes.find((node) => node.id === entity) ??
        nodes.find((node) => node.label.toLowerCase() === normalized) ??
        nodes.find((node) =>
          node.aliases.some((alias) => alias.trim().toLowerCase() === normalized),
        );
      if (!node) return c.json({ data: [] });
      hasEntity = node.id;
    }

    const filter: EpisodeFilter = {};
    if (type) filter.type = type as EpisodeFilter['type'];
    if (since) filter.since = since;
    if (until) filter.until = until;
    if (hasEntity) filter.hasEntity = hasEntity;

    const episodes = store
      .listEpisodes(filter)
      .filter((episode) => recordVisibleInScopes(episode, scopes));
    const paged = episodes
      .slice(offset, offset + limit)
      .map((episode) => visibleEpisode(episode, store, scopes));

    return c.json({ data: paged });
  });

  app.get('/episodes/:id', (c) => {
    const id = c.req.param('id');
    const scopes = parseScopesFilter(c.req.query('scopes'));
    const episode = store.getEpisode(id);
    if (!episode || !recordVisibleInScopes(episode, scopes)) {
      return c.json({ error: { message: 'Episode not found', code: 'NOT_FOUND' } }, 404);
    }

    const entities = store.getEpisodeEntities(id).filter((link) => {
      const node = store.getNode(link.nodeId);
      return !!node && nodeVisibleInScopes(node, scopes);
    });
    return c.json({ data: { episode: visibleEpisode(episode, store, scopes), entities } });
  });

  app.post('/episodes/:id/touch', (c) => {
    const id = c.req.param('id');
    const scopes = parseScopesFilter(c.req.query('scopes'));
    const episode = store.getEpisode(id);
    if (!episode || !recordVisibleInScopes(episode, scopes)) {
      return c.json({ error: { message: 'Episode not found', code: 'NOT_FOUND' } }, 404);
    }

    store.touchEpisode(id);
    const updated = store.getEpisode(id)!;
    return c.json({
      data: { id, accessCount: updated.accessCount, lastAccessed: updated.lastAccessed },
    });
  });

  return app;
}
