import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { type ApiConfig, mcpResource } from '../../shared/config.js';
import type { Sql } from '../../shared/db/sql.js';
import type { Logger } from '../../shared/logger.js';
import { tokenAuth } from '../auth.js';
import type { AppEnv } from '../env.js';
import { originCheck } from '../origin.js';
import { type EventLimits, mountEventRoutes } from './events.js';

export interface V1Deps {
  sql: Sql;
  config: Pick<ApiConfig, 'TOKEN_PEPPER' | 'PUBLIC_API_URL' | 'allowedOrigins'>;
  log: Logger;
  now: () => Date;
  eventLimits?: Partial<EventLimits> | undefined;
}

/**
 * The REST API under `/v1` (spec §7.4): the exact Origin check (hook scripts send none and pass),
 * then static-token auth with the plain challenge, then the routes.
 */
export function v1Routes({ sql, config, log, now, eventLimits }: V1Deps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use(originCheck(config.allowedOrigins));
  app.use(
    tokenAuth({
      sql,
      pepper: config.TOKEN_PEPPER,
      mcpResource: mcpResource(config),
      route: 'v1',
      log,
    }),
  );
  mountEventRoutes(app, { sql, now, limits: eventLimits });

  // Never the message, detail, query or stack: Postgres constraint errors quote the failing row
  // ("Failing row contains …"), which would put event content in the logs. Hono's default handler
  // would print the whole error.
  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    const pg = err as { code?: unknown; constraint_name?: unknown };
    log.error(
      {
        request_id: c.get('requestId'),
        err_name: err.name,
        sqlstate: typeof pg.code === 'string' ? pg.code : undefined,
        constraint: typeof pg.constraint_name === 'string' ? pg.constraint_name : undefined,
      },
      'v1: request failed',
    );
    return c.json({ error: 'internal' }, 500);
  });

  return app;
}
