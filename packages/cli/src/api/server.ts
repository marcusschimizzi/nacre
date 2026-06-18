import { timingSafeEqual } from 'node:crypto';
import { getConnInfo } from '@hono/node-server/conninfo';
import { Hono, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import type { SqliteStore } from '@nacre/core';
import { graphRoutes } from './routes/graph.js';
import { memoryRoutes } from './routes/memory.js';
import { intelligenceRoutes } from './routes/intelligence.js';
import { searchRoutes } from './routes/search.js';
import { systemRoutes } from './routes/system.js';
import { episodeRoutes } from './routes/episodes.js';
import { procedureRoutes } from './routes/procedures.js';
import { temporalRoutes } from './routes/temporal.js';
import { ingestRoutes } from './routes/ingest.js';

/** Browser origins allowed by default: the dashboard/viz dev + preview servers. */
const DEFAULT_CORS_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:4173',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
  'http://127.0.0.1:4173',
];

const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB

export interface CreateAppOptions {
  store: SqliteStore;
  graphPath: string;
  /** Enable CORS (default true). */
  enableCors?: boolean;
  /** Allowed browser origins (default: dashboard/viz localhost dev+preview). */
  corsOrigins?: string[];
  /** Bearer token required on every /api/v1 route when set. */
  token?: string;
  /** Base directory that POST /consolidate inputs/outDir must stay within (default: cwd). */
  consolidateRoot?: string;
  /** Max request body size in bytes (default 5 MB). */
  maxBodyBytes?: number;
  /** Fixed-window per-IP rate limit, or false to disable (default 1000/min). */
  rateLimit?: { windowMs: number; max: number } | false;
}

/** Constant-time bearer-token comparison (avoids leaking the token via timing). */
function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function bearerAuth(token: string): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header('Authorization') ?? '';
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match || !tokensMatch(match[1], token)) {
      return c.json({ error: { message: 'Unauthorized', code: 'UNAUTHORIZED' } }, 401);
    }
    await next();
  };
}

/** Tiny in-memory fixed-window limiter, keyed by client IP. Bounds runaway loops. */
function rateLimiter(windowMs: number, max: number): MiddlewareHandler {
  const hits = new Map<string, { count: number; reset: number }>();
  return async (c, next) => {
    let key = 'unknown';
    try {
      key = getConnInfo(c).remote.address ?? 'unknown';
    } catch {
      // No connection info (e.g. in-memory app.request in tests) — share one bucket.
    }
    const now = Date.now();
    let rec = hits.get(key);
    if (!rec || now > rec.reset) {
      rec = { count: 0, reset: now + windowMs };
      hits.set(key, rec);
    }
    rec.count += 1;
    if (rec.count > max) {
      return c.json({ error: { message: 'Too many requests', code: 'RATE_LIMITED' } }, 429);
    }
    await next();
  };
}

export function createApp(opts: CreateAppOptions): Hono {
  const {
    store,
    graphPath,
    enableCors = true,
    corsOrigins = DEFAULT_CORS_ORIGINS,
    token,
    consolidateRoot = process.cwd(),
    maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
    rateLimit = { windowMs: 60_000, max: 1000 },
  } = opts;
  const app = new Hono();

  // CORS first, so preflight (OPTIONS) is answered before auth/body checks run.
  if (enableCors) {
    app.use(
      '/*',
      cors({
        origin: corsOrigins,
        allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'Authorization'],
      }),
    );
  }

  if (rateLimit) {
    app.use('/api/v1/*', rateLimiter(rateLimit.windowMs, rateLimit.max));
  }

  app.use(
    '/api/v1/*',
    bodyLimit({
      maxSize: maxBodyBytes,
      onError: (c) =>
        c.json({ error: { message: 'Request body too large', code: 'PAYLOAD_TOO_LARGE' } }, 413),
    }),
  );

  if (token) {
    app.use('/api/v1/*', bearerAuth(token));
  }

  app.onError((err, c) => {
    // Log details server-side; return a generic message so internal paths,
    // SQLite/driver errors, etc. are not leaked to clients.
    console.error('[nacre api] unhandled error:', err);
    return c.json({ error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } }, 500);
  });

  app.notFound((c) => {
    return c.json({ error: { message: 'Not found', code: 'NOT_FOUND' } }, 404);
  });

  app.route('/api/v1', systemRoutes(store));
  app.route('/api/v1', graphRoutes(store));
  app.route('/api/v1', memoryRoutes(store, graphPath));
  app.route('/api/v1', intelligenceRoutes(store, graphPath, consolidateRoot));
  app.route('/api/v1', searchRoutes(store));
  app.route('/api/v1', episodeRoutes(store));
  app.route('/api/v1', procedureRoutes(store));
  app.route('/api/v1', temporalRoutes(store));
  app.route('/api/v1', ingestRoutes(store, graphPath));

  return app;
}
