import { setTimeout as sleep } from 'node:timers/promises';
import type { Sql } from '../shared/db/sql.js';
import type { Logger } from '../shared/logger.js';
import type { Extractor } from './extractor.js';
import { claimJob, failJob, MAX_ATTEMPTS } from './jobs.js';
import { type ProcessResult, processJob } from './process.js';
import { errorCode, retryDelayMs } from './schema-wait.js';

export interface WorkerDeps {
  sql: Sql;
  /** Null without OPENAI_API_KEY: the worker idles and claims nothing. */
  extractor: Extractor | null;
  log: Logger;
  now: () => Date;
  budgetUsd: number;
  pollMs: number;
  signal: AbortSignal;
}

export type RunDeps = WorkerDeps & { extractor: Extractor };

/** How often idle mode repeats its warning. */
const IDLE_WARN_MS = 60_000;

/** Claims and processes one job; null when none is ready. Throws only when the database does. */
export async function runOnce(deps: RunDeps): Promise<ProcessResult | null> {
  const job = await claimJob(deps.sql, deps.now());
  if (!job) return null;
  if (job.attempts > MAX_ATTEMPTS) {
    // Reclaimed after a stale lock once too often: a job that keeps killing its worker.
    await failJob(deps.sql, job, 'stale_lock');
    deps.log.error(
      { job_id: job.jobId, event_id: job.eventId, code: 'stale_lock', attempts: job.attempts },
      'extract job failed',
    );
    return { outcome: 'failed' };
  }
  return processJob(deps, job);
}

/** Runs jobs until none is ready (tests use it). */
export async function drain(deps: RunDeps): Promise<ProcessResult[]> {
  const results: ProcessResult[] = [];
  for (;;) {
    const result = await runOnce(deps);
    if (!result) return results;
    results.push(result);
  }
}

const pause = (ms: number, signal: AbortSignal) => sleep(ms, undefined, { signal }).catch(() => {});

/**
 * The worker loop: one job at a time until `signal` aborts. Polls every `pollMs` when the queue is
 * empty; pauses after the provider rejects the key; backs off (1 s doubling to 30 s) while the
 * database is unreachable, logging only a code.
 */
export async function runWorker(deps: WorkerDeps): Promise<void> {
  const { extractor, log, signal } = deps;
  if (!extractor) {
    // Idle mode: a deploy before the key is set must not crash-loop, and no job may be lost.
    while (!signal.aborted) {
      log.warn('extraction disabled: OPENAI_API_KEY is not set');
      await pause(IDLE_WARN_MS, signal);
    }
    return;
  }
  const run: RunDeps = { ...deps, extractor };
  let failures = 0;
  while (!signal.aborted) {
    let result: ProcessResult | null;
    try {
      result = await runOnce(run);
      failures = 0;
    } catch (err) {
      failures++;
      log.error({ code: errorCode(err), failures }, 'worker loop error');
      await pause(retryDelayMs(failures), signal);
      continue;
    }
    if (result?.pauseMs) await pause(result.pauseMs, signal);
    else if (!result) await pause(deps.pollMs, signal);
  }
}
