import { buildInfo } from '../shared/build-info.js';
import { loadApiConfig } from '../shared/config.js';
import { createSql } from '../shared/db/sql.js';
import { createLogger } from '../shared/logger.js';
import { createApp } from './app.js';
import { startServer } from './server.js';

const config = loadApiConfig();
const log = createLogger('nacre-api', config.LOG_LEVEL);
// As nacre_app (spec §4 roles). Connections open lazily, so a bad password shows up in /healthz.
const sql = createSql(config.DATABASE_URL, {
  max: 10,
  connection: { application_name: 'nacre-api' },
});
const app = createApp({ sql, config, log });
const server = await startServer(app, config.PORT, config.HOST);

log.info(
  { ...buildInfo, port: server.port, host: config.HOST, public_api_url: config.PUBLIC_API_URL },
  'api listening',
);

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, async () => {
    log.info({ signal }, 'shutdown requested');
    await server.close();
    await sql.end({ timeout: 5 });
    log.info('api stopped');
  });
}
