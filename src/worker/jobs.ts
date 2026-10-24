import { logActivity } from '../shared/activity.js';
import type { Sql, TransactionSql } from '../shared/db/sql.js';

/**
 * The `extract` job queue (spec §12.2): the `jobs` table, `FOR UPDATE SKIP LOCKED`, one job at a
 * time. Every disposition is one statement guarded by `status = 'running'`, and `last_error` is a
 * short code, never message text.
 */

export const MAX_ATTEMPTS = 5;
export const STALE_LOCK_MS = 10 * 60_000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_CAP_MS = 60 * 60_000;
/** How long a job waits after the provider rejected the key; the loop pauses as long. */
export const AUTH_PAUSE_MS = 5 * 60_000;

/** The wait after failed attempt `n` (1-based): 30 s × 4^(n−1), capped at 1 hour. */
export function backoffMs(attempt: number): number {
  return Math.min(BACKOFF_BASE_MS * 4 ** Math.max(0, attempt - 1), BACKOFF_CAP_MS);
}

export interface ClaimedJob {
  jobId: number;
  eventId: string;
  /** Including this one. */
  attempts: number;
}

type Db = Sql | TransactionSql;

/**
 * Claims the next ready `extract` job: queued and due, or running with a lock older than
 * STALE_LOCK_MS (its worker died). Other kinds (`embed`, task 9) are never touched.
 */
export async function claimJob(sql: Sql, now: Date): Promise<ClaimedJob | null> {
  const staleBefore = new Date(now.getTime() - STALE_LOCK_MS);
  const [row] = await sql<{ job_id: string; event_id: string; attempts: number }[]>`
    WITH next AS (
      SELECT job_id FROM jobs
      WHERE kind = 'extract'
        AND ((status = 'queued' AND run_after <= ${now})
          OR (status = 'running' AND locked_at < ${staleBefore}))
      ORDER BY run_after, job_id
      LIMIT 1
      FOR UPDATE SKIP LOCKED)
    UPDATE jobs SET status = 'running', locked_at = ${now}, attempts = attempts + 1
    FROM next WHERE jobs.job_id = next.job_id
    RETURNING jobs.job_id, jobs.ref_id AS event_id, jobs.attempts`;
  return row ? { jobId: Number(row.job_id), eventId: row.event_id, attempts: row.attempts } : null;
}

/**
 * Heartbeat, at the start of each chunk: moves `locked_at` forward so a long body doesn't outlast
 * STALE_LOCK_MS while its worker is alive. Guarded by this claim (`attempts` grows with every
 * claim, so a reclaimed job no longer matches); false when this worker no longer holds the job.
 */
export async function refreshLock(tx: Db, job: ClaimedJob, now: Date): Promise<boolean> {
  const rows = await tx`
    UPDATE jobs SET locked_at = ${now}
    WHERE job_id = ${job.jobId} AND status = 'running' AND attempts = ${job.attempts}
    RETURNING job_id`;
  return rows.length > 0;
}

/** Success or skip. Runs inside the last transaction of the job, so the record and `done` commit together. */
export async function completeJob(tx: Db, jobId: number): Promise<void> {
  await tx`
    UPDATE jobs SET status = 'done', locked_at = NULL, last_error = NULL
    WHERE job_id = ${jobId} AND status = 'running'`;
}

/** A retryable failure with attempts left: back in the queue after the backoff. */
export async function retryJob(tx: Db, job: ClaimedJob, code: string, now: Date): Promise<void> {
  const runAfter = new Date(now.getTime() + backoffMs(job.attempts));
  await tx`
    UPDATE jobs SET status = 'queued', run_after = ${runAfter}, locked_at = NULL, last_error = ${code}
    WHERE job_id = ${job.jobId} AND status = 'running'`;
}

/**
 * Gives up: `failed` stays in the table (visible; a later task can requeue it), with one
 * `extraction_error` entry. Nothing deletes jobs.
 */
export async function failJob(sql: Sql, job: ClaimedJob, code: string): Promise<void> {
  await sql.begin(async (tx) => {
    const updated = await tx`
      UPDATE jobs SET status = 'failed', locked_at = NULL, last_error = ${code}
      WHERE job_id = ${job.jobId} AND status = 'running'
      RETURNING job_id`;
    if (updated.length === 0) return;
    await logActivity(tx, {
      kind: 'extraction_error',
      actor: 'worker',
      targetKind: 'job',
      targetId: String(job.jobId),
      eventIds: [job.eventId],
      reason: code,
      details: { attempts: job.attempts },
    });
  });
}

/**
 * Puts a job back without counting the attempt: the budget is spent (`budget`), the provider
 * rejected the key (`auth`), or a shutdown aborted the call (`null`). The wait is not a failure.
 */
export async function deferJob(
  tx: Db,
  jobId: number,
  runAfter: Date,
  code: 'budget' | 'auth' | null,
): Promise<void> {
  await tx`
    UPDATE jobs SET status = 'queued', run_after = ${runAfter}, locked_at = NULL,
                    attempts = attempts - 1, last_error = ${code}
    WHERE job_id = ${jobId} AND status = 'running'`;
}
