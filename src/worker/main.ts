import { buildInfo } from '../shared/build-info.js';
import { loadWorkerConfig } from '../shared/config.js';
import { createSql } from '../shared/db/sql.js';
import { createLogger } from '../shared/logger.js';
import { runWorker } from './loop.js';
import { OpenAiExtractor } from './openai.js';
import { newestMigration, readSchemaVersion, waitForSchema } from './schema-wait.js';

const config = loadWorkerConfig();
const log = createLogger('nacre-worker', config.LOG_LEVEL);
const stop = new AbortController();

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    log.info({ signal }, 'shutdown requested');
    stop.abort();
  });
}

// Never the key or the config object: names and settings only.
log.info(
  {
    ...buildInfo,
    pollMs: config.WORKER_POLL_MS,
    model: config.LLM_MODEL,
    budget_usd: config.DAILY_LLM_BUDGET_USD,
    openai: config.OPENAI_API_KEY ? 'configured' : 'missing',
  },
  'worker started',
);

const sql = createSql(config.DATABASE_URL, { max: 4 });
const ready = await waitForSchema({
  readVersion: () => readSchemaVersion(sql),
  newest: newestMigration(),
  signal: stop.signal,
  log,
});

if (ready) {
  log.info('schema is current');
  await runWorker({
    sql,
    extractor: config.OPENAI_API_KEY
      ? new OpenAiExtractor({ apiKey: config.OPENAI_API_KEY, model: config.LLM_MODEL })
      : null,
    log,
    now: () => new Date(),
    budgetUsd: config.DAILY_LLM_BUDGET_USD,
    pollMs: config.WORKER_POLL_MS,
    signal: stop.signal,
  });
}

await sql.end({ timeout: 5 });
log.info('worker stopped');
