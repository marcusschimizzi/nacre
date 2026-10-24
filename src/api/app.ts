import { Hono } from 'hono';
import { requestId } from 'hono/request-id';
import { buildInfo } from '../shared/build-info.js';
import { type ApiConfig, mcpResource } from '../shared/config.js';
import type { Sql } from '../shared/db/sql.js';
import type { Logger } from '../shared/logger.js';
import { authShape, tokenAuth } from './auth.js';
import type { AppEnv } from './env.js';
import { createMcpEndpoint } from './mcp.js';
import { originCheck } from './origin.js';

export interface AppDeps {
  sql: Sql;
  config: Pick<ApiConfig, 'TOKEN_PEPPER' | 'PUBLIC_API_URL' | 'allowedOrigins'>;
  log: Logger;
}

const HEALTH_DB_TIMEOUT_MS = 3000;

export function createApp({ sql, config, log }: AppDeps) {
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
        mcp_protocol: c.req.header('mcp-protocol-version'),
        mcp_method: c.req.header('mcp-method'),
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
    }),
  );
  const mcp = createMcpEndpoint(log);
  app.all('/mcp', (c) => mcp(c.req.raw, c.get('auth')));

  return app;
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
