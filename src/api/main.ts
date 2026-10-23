import { buildInfo } from '../shared/build-info.js';
import { loadApiConfig } from '../shared/config.js';
import { createLogger } from '../shared/logger.js';
import { createApp } from './app.js';
import { startServer } from './server.js';

const config = loadApiConfig();
const log = createLogger('nacre-api', config.LOG_LEVEL);
const app = createApp({ token: config.NACRE_DEV_TOKEN, log });
const server = await startServer(app, config.PORT, config.HOST);

log.info({ ...buildInfo, port: server.port, host: config.HOST }, 'api listening');

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, async () => {
    log.info({ signal }, 'shutdown requested');
    await server.close();
    log.info('api stopped');
  });
}
