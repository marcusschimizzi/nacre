import { Hono } from 'hono';
import { type RequestIdVariables, requestId } from 'hono/request-id';
import { buildInfo } from '../shared/build-info.js';
import type { Logger } from '../shared/logger.js';
import { bearerAuth } from './auth.js';
import { createMcpEndpoint } from './mcp.js';

export interface AppDeps {
  token: string;
  log: Logger;
}

export function createApp({ token, log }: AppDeps) {
  const app = new Hono<{ Variables: RequestIdVariables }>();

  app.use(requestId());
  app.use(async (c, next) => {
    const started = performance.now();
    await next();
    // Method, path and status only: never headers, query strings or bodies.
    log.info(
      {
        request_id: c.get('requestId'),
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        ms: Math.round(performance.now() - started),
      },
      'request',
    );
  });

  app.get('/healthz', (c) =>
    c.json({
      status: 'ok',
      service: 'nacre-api',
      version: buildInfo.version,
      commit: buildInfo.commit,
    }),
  );

  app.use('/mcp', bearerAuth(token));
  const mcp = createMcpEndpoint(log);
  app.all('/mcp', (c) => mcp(c.req.raw));

  return app;
}
