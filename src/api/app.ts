import { Hono } from 'hono';
import { requestId } from 'hono/request-id';
import { buildInfo } from '../shared/build-info.js';
import { type ApiConfig, mcpResource, resourceMetadataUrl } from '../shared/config.js';
import type { Sql } from '../shared/db/sql.js';
import type { Logger } from '../shared/logger.js';
import { authShape, tokenAuth } from './auth.js';
import type { AppEnv } from './env.js';
import { createMcpEndpoint } from './mcp.js';
import { type OAuthLimits, oauthRoutes } from './oauth/routes.js';
import { originCheck } from './origin.js';

export interface AppDeps {
  sql: Sql;
  config: Pick<
    ApiConfig,
    'TOKEN_PEPPER' | 'PUBLIC_API_URL' | 'allowedOrigins' | 'OWNER_PASSWORD_HASH'
  >;
  log: Logger;
  /** Overrides the OAuth rate limits (spec §9.3 values by default); tests use it. */
  oauthLimits?: Partial<OAuthLimits>;
}

const HEALTH_DB_TIMEOUT_MS = 3000;

export function createApp({ sql, config, log, oauthLimits }: AppDeps) {
  const app = new Hono<AppEnv>();

  app.use(requestId());
  app.use(async (c, next) => {
    const started = performance.now();
    await next();
    // Never Authorization, query strings or bodies (spec §13.1). The MCP headers show which protocol
    // revision each client speaks (2026-07-28 requests carry it on every call).
    const auth = c.get('auth');
    log.info(
      {
        request_id: c.get('requestId'),
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        ms: Math.round(performance.now() - started),
        agent_id: auth?.agentId,
        token_id: auth?.tokenId,
        auth_denied: c.get('authDenied'),
        // Never codes, verifiers, tokens or the password: the step and outcome only.
        oauth: c.get('oauth'),
        client_id_is_url: c.get('oauthClientIdIsUrl'),
        mcp_protocol: c.req.header('mcp-protocol-version'),
        mcp_method: c.req.header('mcp-method') ?? c.get('mcpMethod'),
        user_agent: c.req.header('user-agent'),
        auth: authShape(c.req.header('authorization')),
      },
      'request',
    );
  });

  // 503 when the database is unreachable, so a wrong nacre_app password fails the deploy's health check.
  app.get('/healthz', async (c) => {
    const db = await pingDatabase(sql, log);
    return c.json(
      {
        status: db === 'ok' ? 'ok' : 'degraded',
        service: 'nacre-api',
        version: buildInfo.version,
        commit: buildInfo.commit,
        db,
      },
      db === 'ok' ? 200 : 503,
    );
  });

  app.use('/mcp', originCheck(config.allowedOrigins));
  app.use(
    '/mcp',
    tokenAuth({
      sql,
      pepper: config.TOKEN_PEPPER,
      mcpResource: mcpResource(config),
      route: 'mcp',
      log,
      resourceMetadataUrl: resourceMetadataUrl(config),
    }),
  );
  const mcp = createMcpEndpoint(log);
  app.all('/mcp', async (c) => {
    // 2025-11-25 clients (Grok, Cursor) send no Mcp-Method header; read the method from a copy of
    // the body so the log can tell tools/call from tools/list. Only after auth, never params.
    if (c.req.method === 'POST' && !c.req.header('mcp-method')) {
      const method = jsonRpcMethod(await c.req.raw.clone().text());
      if (method) c.set('mcpMethod', method);
    }
    return mcp(c.req.raw, c.get('auth'));
  });

  app.route('/', oauthRoutes({ sql, config, log, limits: oauthLimits }));

  return app;
}

const MCP_METHOD = /^[a-z][a-zA-Z0-9_/]{0,63}$/;
const MCP_METHOD_BODY_MAX = 64 * 1024;

/** A single JSON-RPC object's `method`, if it looks like one; never a batch or anything else. */
export function jsonRpcMethod(body: string): string | undefined {
  if (body.length > MCP_METHOD_BODY_MAX) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const { method } = parsed as { method?: unknown };
  return typeof method === 'string' && MCP_METHOD.test(method) ? method : undefined;
}

async function pingDatabase(sql: Sql, log: Logger): Promise<'ok' | 'error'> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      sql`SELECT 1`,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timed out')), HEALTH_DB_TIMEOUT_MS);
      }),
    ]);
    return 'ok';
  } catch (err) {
    // The message only: postgres.js errors carry no connection URL or password.
    log.warn(
      { err: { name: (err as Error).name, message: (err as Error).message } },
      'healthz: database check failed',
    );
    return 'error';
  } finally {
    clearTimeout(timer);
  }
}
