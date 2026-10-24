import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/api/app.js';
import { type RunningServer, startServer } from '../src/api/server.js';
import { createSql, type Sql } from '../src/shared/db/sql.js';
import { createLogger } from '../src/shared/logger.js';

// No database needed: the point is what happens when there isn't one.
describe('GET /healthz with the database unreachable', () => {
  let server: RunningServer;
  let sql: Sql;
  const logLines: string[] = [];

  beforeAll(async () => {
    // Port 1 on loopback refuses connections immediately; the password must never be logged.
    sql = createSql('postgres://nacre_app:not-the-real-password@127.0.0.1:1/nacre', {
      max: 1,
      connect_timeout: 2,
    });
    const log = createLogger('nacre-api-test', 'debug', { write: (line) => logLines.push(line) });
    const app = createApp({
      sql,
      config: {
        TOKEN_PEPPER: 'p'.repeat(32),
        PUBLIC_API_URL: 'https://api.nacre.test',
        allowedOrigins: ['https://api.nacre.test'],
      },
      log,
    });
    server = await startServer(app, 0, '127.0.0.1');
  });
  afterAll(async () => {
    await server?.close();
    await sql?.end({ timeout: 1 });
  });

  it('returns 503 with db: "error", so a wrong nacre_app password fails the deploy health check', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      status: 'degraded',
      service: 'nacre-api',
      db: 'error',
    });
    expect(logLines.join('\n')).toContain('healthz: database check failed');
    expect(logLines.join('\n')).not.toContain('not-the-real-password');
  });
});
