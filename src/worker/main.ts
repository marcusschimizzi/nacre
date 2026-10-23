import { setTimeout as sleep } from 'node:timers/promises';
import { buildInfo } from '../shared/build-info.js';
import { loadWorkerConfig } from '../shared/config.js';
import { createLogger } from '../shared/logger.js';

const config = loadWorkerConfig();
const log = createLogger('nacre-worker', config.LOG_LEVEL);
const stop = new AbortController();

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    log.info({ signal }, 'shutdown requested');
    stop.abort();
  });
}

log.info({ ...buildInfo, pollMs: config.WORKER_POLL_MS }, 'worker started');

// Placeholder loop. Task 5 claims jobs here with `FOR UPDATE SKIP LOCKED` (spec §12.2).
let ticks = 0;
while (!stop.signal.aborted) {
  ticks += 1;
  log.debug({ ticks }, 'tick (no jobs yet)');
  await sleep(config.WORKER_POLL_MS, undefined, { signal: stop.signal }).catch(() => {});
}

log.info({ ticks }, 'worker stopped');
