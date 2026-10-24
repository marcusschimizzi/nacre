import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Sql } from '../../shared/db/sql.js';
import { EVENT_LIMITS, ingestEvent, parseEvent } from '../../shared/events.js';
import type { AppEnv } from '../env.js';
import { SlidingWindowLimiter } from '../rate-limit.js';

export interface EventLimits {
  /** Requests per minute per agent (every authenticated attempt counts). */
  perMinute: number;
}

export const DEFAULT_EVENT_LIMITS: EventLimits = { perMinute: 120 };

export interface EventRouteDeps {
  sql: Sql;
  now: () => Date;
  limits?: Partial<EventLimits> | undefined;
}

type Ctx = Context<AppEnv>;

const reject = <S extends 400 | 403 | 413 | 422 | 429>(
  c: Ctx,
  outcome: string,
  status: S,
  body: Record<string, unknown>,
) => {
  c.set('ingest', `rejected:${outcome}`);
  return c.json(body, status);
};

/**
 * `POST /v1/events` (spec §5.1, §7.4). Runs after the `/v1` Origin check and token auth; then the
 * `write` right, the per-agent rate limit, the body cap, JSON, validation, the content and
 * metadata caps, and ingest. The request log gets `ingest` and `event_id`; never the body.
 */
export function mountEventRoutes(app: Hono<AppEnv>, { sql, now, limits }: EventRouteDeps): void {
  const { perMinute } = { ...DEFAULT_EVENT_LIMITS, ...limits };
  // One limiter per agent. Only authenticated callers reach it, so it can't outgrow the agents.
  const limiters = new Map<string, SlidingWindowLimiter>();
  const limiterFor = (agentId: string) => {
    let limiter = limiters.get(agentId);
    if (!limiter) {
      limiter = new SlidingWindowLimiter(perMinute, 60_000);
      limiters.set(agentId, limiter);
    }
    return limiter;
  };

  app.post(
    '/events',
    async (c, next) => {
      const auth = c.get('auth');
      if (!auth) throw new Error('/v1/events reached without auth');
      // Scopes and the label ceiling are later slices; slice 1 checks the right only.
      if (!auth.rights.includes('write')) {
        return reject(c, 'no_write_right', 403, { error: 'forbidden' });
      }
      // Claimed before the body is read: a runaway hook loop would otherwise fill a log that can
      // never be deleted from. Every authenticated attempt counts, good or bad.
      const wait = limiterFor(auth.agentId).tryHit();
      if (wait > 0) {
        c.header('Retry-After', String(Math.max(1, Math.ceil(wait / 1000))));
        return reject(c, 'rate_limited', 429, { error: 'too_many_requests' });
      }
      await next();
    },
    // Covers a missing Content-Length too: the read below fails once the stream passes the cap.
    bodyLimit({
      maxSize: EVENT_LIMITS.bodyBytes,
      onError: (c) => {
        // The rest of the body is never read, so the server drops the connection after this
        // answer; saying so stops a keep-alive client from sending its next request down it.
        c.header('Connection', 'close');
        return reject(c, 'body_too_large', 413, { error: 'payload_too_large', field: 'body' });
      },
    }),
    async (c) => {
      if (!/^application\/json\b/i.test(c.req.header('content-type') ?? '')) {
        return reject(c, 'invalid_json', 400, { error: 'invalid_json' });
      }
      // Outside the try: bodyLimit's error must reach bodyLimit, not become invalid_json.
      const text = await c.req.text();
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return reject(c, 'invalid_json', 400, { error: 'invalid_json' });
      }
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return reject(c, 'invalid_json', 400, { error: 'invalid_json' });
      }

      const parsed = parseEvent(body);
      if (!parsed.ok && parsed.status === 422) {
        return reject(c, 'invalid_request', 422, {
          error: 'invalid_request',
          issues: parsed.issues,
        });
      }
      if (!parsed.ok) {
        return reject(c, `${parsed.field}_too_large`, 413, {
          error: 'payload_too_large',
          field: parsed.field,
        });
      }

      const auth = c.get('auth');
      if (!auth) throw new Error('/v1/events reached without auth');
      const result = await ingestEvent(
        sql,
        { agentId: auth.agentId, tokenId: auth.tokenId, requestId: c.get('requestId') },
        parsed.event,
        { now },
      );
      c.set('eventId', result.eventId);
      const accepted = { event_id: result.eventId, status: 'accepted', job: 'extract' };
      if (result.created) {
        c.set('ingest', 'created');
        return c.json(accepted, 201);
      }
      // Same key, same answer, even if the content differs (Decided, spec §5.1); the mismatch is
      // only logged, and the new content isn't stored.
      c.set('ingest', result.hashMatches ? 'duplicate' : 'duplicate_mismatch');
      return c.json({ ...accepted, duplicate: true }, 200);
    },
  );
}
