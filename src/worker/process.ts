import { createHash } from 'node:crypto';
import { logActivity } from '../shared/activity.js';
import type { Sql } from '../shared/db/sql.js';
import type { Logger } from '../shared/logger.js';
import { costUsd, type TokenUsage } from '../shared/pricing.js';
import { budgetState } from './budget.js';
import { canonicalJson } from './canonical-json.js';
import { CHUNK_CHARS, chunkBody } from './chunk.js';
import {
  closeRunningRuns,
  countOkRuns,
  finishRun,
  insertModelCall,
  insertRunningRun,
  insertSkippedRun,
  logRunActivity,
  type RunIdentity,
  writeClaims,
} from './claims.js';
import { CONTEXT_CHARS, CONTEXT_EVENTS, loadContext } from './context.js';
import { type ExtractInput, type Extractor, ExtractorError } from './extractor.js';
import {
  AUTH_PAUSE_MS,
  type ClaimedJob,
  completeJob,
  deferJob,
  failJob,
  MAX_ATTEMPTS,
  refreshLock,
  retryJob,
} from './jobs.js';
import { skipReason } from './skip.js';

export type { ClaimedJob };

export interface ProcessDeps {
  sql: Sql;
  extractor: Extractor;
  log: Logger;
  now: () => Date;
  budgetUsd: number;
  signal: AbortSignal;
}

export type JobOutcome = 'done' | 'skipped' | 'retry' | 'deferred' | 'failed' | 'released';

export interface ProcessResult {
  outcome: JobOutcome;
  /** Set when the loop should stop claiming for a while (the provider rejected the key). */
  pauseMs?: number;
}

/** Bump when the stored claim shape changes; part of config_hash. */
const SCHEMA_VERSION = 1;

/**
 * `extraction_runs.config_hash`: everything besides the prompt that changes outputs. A retry
 * resumes after the chunks already extracted with the same prompt hash and config hash.
 */
export function configHash(extractor: Extractor): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        ...extractor.settings,
        context_events: CONTEXT_EVENTS,
        context_chars: CONTEXT_CHARS,
        chunk_chars: CHUNK_CHARS,
        schema_version: SCHEMA_VERSION,
      }),
    )
    .digest('hex');
}

/** One job of the pipeline (spec §3 steps 2 to 4; task 5 brief §4). Never throws for a job-level problem. */
export async function processExtractJob(deps: ProcessDeps, job: ClaimedJob): Promise<JobOutcome> {
  return (await processJob(deps, job)).outcome;
}

interface EventRow {
  event_id: string;
  kind: string;
  role: string | null;
  sensitivity: string;
  session_id: string | null;
  observed_at: Date;
  observed_tz: string | null;
  scope_id: string;
  body: string | null;
}

/** Totals over the chunks this attempt extracted, for the job's one summary log line. */
interface Totals {
  runId: string | null;
  claims: number;
  verified: number;
  held: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
}

/** `internal:` plus the SQLSTATE or the error's name: never its message. */
export function internalCode(err: unknown): string {
  const sqlstate = (err as { code?: unknown } | null)?.code;
  if (typeof sqlstate === 'string' && /^[0-9A-Z]{5}$/.test(sqlstate)) return `internal:${sqlstate}`;
  const name = err instanceof Error ? err.name : typeof err;
  return `internal:${/^[A-Za-z0-9_.-]{1,64}$/.test(name) ? name : 'error'}`;
}

export async function processJob(deps: ProcessDeps, job: ClaimedJob): Promise<ProcessResult> {
  const totals: Totals = {
    runId: null,
    claims: 0,
    verified: 0,
    held: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    latencyMs: 0,
  };
  let chunkCount = 0;
  let result: ProcessResult;
  try {
    result = await pipeline(deps, job, totals, (n) => {
      chunkCount = n;
    });
  } catch (err) {
    // Anything but an ExtractorError (handled inside): a database error, a span mismatch, a bug.
    // Retryable, with a code only.
    const code = internalCode(err);
    deps.log.warn(
      { job_id: job.jobId, event_id: job.eventId, code, attempts: job.attempts },
      'extract attempt failed',
    );
    await closeRunningRuns(deps.sql, job.eventId, code);
    result = { outcome: await retryOrFail(deps, job, code) };
  }
  if (result.outcome === 'done' || result.outcome === 'retry' || result.outcome === 'failed') {
    deps.log.info(
      {
        job_id: job.jobId,
        event_id: job.eventId,
        run_id: totals.runId,
        outcome: result.outcome,
        chunks: chunkCount,
        claims: totals.claims,
        verified: totals.verified,
        held: totals.held,
        input_tokens: totals.inputTokens,
        output_tokens: totals.outputTokens,
        cost_usd: totals.costUsd,
        latency_ms: totals.latencyMs,
        attempts: job.attempts,
      },
      'extract job finished',
    );
  }
  return result;
}

async function retryOrFail(deps: ProcessDeps, job: ClaimedJob, code: string): Promise<JobOutcome> {
  if (job.attempts < MAX_ATTEMPTS) {
    await retryJob(deps.sql, job, code, deps.now());
    return 'retry';
  }
  await fail(deps, job, code);
  return 'failed';
}

async function fail(deps: ProcessDeps, job: ClaimedJob, code: string): Promise<void> {
  await failJob(deps.sql, job, code);
  deps.log.error(
    { job_id: job.jobId, event_id: job.eventId, code, attempts: job.attempts },
    'extract job failed',
  );
}

async function pipeline(
  deps: ProcessDeps,
  job: ClaimedJob,
  totals: Totals,
  setChunks: (n: number) => void,
): Promise<ProcessResult> {
  const { sql, extractor, log } = deps;
  const id: RunIdentity = { extractor, configHash: configHash(extractor) };

  // 1. Load.
  const [event] = await sql<EventRow[]>`
    SELECT e.event_id, e.kind, e.role, e.sensitivity, e.session_id, e.observed_at, e.observed_tz,
           e.scope_id, c.body
    FROM events e LEFT JOIN event_content c USING (event_id)
    WHERE e.event_id = ${job.eventId}`;
  if (!event) {
    await fail(deps, job, 'event_not_found');
    return { outcome: 'failed' };
  }
  if (event.body === null) {
    // Ciphertext only (slice 8): nothing a hosted model may read.
    await fail(deps, job, 'missing_body');
    return { outcome: 'failed' };
  }
  const body = event.body;

  // 2. Skip rules: no model call.
  const skip = skipReason(event, body);
  if (skip) {
    await sql.begin(async (tx) => {
      const runId = await insertSkippedRun(
        tx,
        id,
        { eventId: event.event_id, inputEventIds: [event.event_id] },
        skip,
      );
      await logRunActivity(tx, event.event_id, runId, skippedSummary(skip));
      await completeJob(tx, job.jobId);
    });
    log.info({ job_id: job.jobId, event_id: event.event_id, skip }, 'extract job skipped');
    return { outcome: 'skipped' };
  }

  // 3. Resume: a crashed attempt left a run `running`; earlier chunks may already be done.
  await closeRunningRuns(sql, event.event_id, 'abandoned');
  const chunks = chunkBody(body);
  setChunks(chunks.length);
  const done = await countOkRuns(sql, id, event.event_id);
  if (done >= chunks.length) {
    await completeJob(sql, job.jobId);
    return { outcome: 'done' };
  }

  // 4. Context, shared by every chunk.
  const context = await loadContext(sql, { eventId: event.event_id, sessionId: event.session_id });
  const inputEventIds = [...context.map((c) => c.eventId), event.event_id];
  const target = {
    kind: event.kind === 'remember' ? ('remember' as const) : ('message' as const),
    role: event.role === 'assistant' ? ('assistant' as const) : ('user' as const),
  };

  // 6. One run and one model call per chunk, from the first one not done yet.
  for (let i = done; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk) break;
    const isLast = i === chunks.length - 1;

    const budget = await budgetState(sql, deps.now(), deps.budgetUsd);
    if (budget.exhausted) {
      await sql.begin(async (tx) => {
        const runId = await insertSkippedRun(
          tx,
          id,
          { eventId: event.event_id, inputEventIds: [event.event_id] },
          'budget',
        );
        await logRunActivity(tx, event.event_id, runId, {
          ...skippedSummary('budget'),
          chunk: i + 1,
          chunks: chunks.length,
        });
        // One budget_stop entry per Chicago day, however many jobs it defers. The advisory lock
        // makes the check-then-insert safe if two workers ever run.
        await tx`SELECT pg_advisory_xact_lock(hashtext(${`budget_stop:${budget.day}`}))`;
        const [seen] = await tx`
          SELECT 1 FROM activity_log
          WHERE kind = 'system' AND details->>'step' = 'budget_stop' AND details->>'day' = ${budget.day}
          LIMIT 1`;
        if (!seen) {
          await logActivity(tx, {
            kind: 'system',
            actor: 'worker',
            details: {
              step: 'budget_stop',
              day: budget.day,
              spent_usd: budget.spentUsd,
              budget_usd: deps.budgetUsd,
            },
          });
        }
        await deferJob(tx, job.jobId, budget.nextStart, 'budget');
      });
      log.warn(
        {
          job_id: job.jobId,
          event_id: event.event_id,
          day: budget.day,
          spent_usd: budget.spentUsd,
          budget_usd: deps.budgetUsd,
        },
        'daily LLM budget reached; job deferred to the next day',
      );
      return { outcome: 'deferred' };
    }

    if (deps.signal.aborted) {
      await deferJob(sql, job.jobId, deps.now(), null);
      return { outcome: 'released' };
    }

    // Keep the lock fresh: a body of many slow chunks can outlast the stale-lock window.
    await refreshLock(sql, job, deps.now());

    const runId = await insertRunningRun(sql, id, { eventId: event.event_id, inputEventIds });
    totals.runId = runId;
    const input: ExtractInput = {
      observedAt: event.observed_at,
      observedTz: event.observed_tz,
      context: context.map((c) => ({ role: c.role, text: c.text })),
      target: { ...target, text: chunk.text },
    };
    const started = performance.now();
    let extracted: Awaited<ReturnType<Extractor['extract']>>;
    try {
      extracted = await extractor.extract(input, { signal: deps.signal });
    } catch (err) {
      if (!(err instanceof ExtractorError)) throw err;
      const latencyMs = Math.round(performance.now() - started);
      return handleExtractorError(deps, job, {
        err,
        runId,
        eventId: event.event_id,
        chunk: i + 1,
        chunks: chunks.length,
        latencyMs,
        totals,
      });
    }
    const latencyMs = Math.round(performance.now() - started);
    const cost = costUsd(extractor.model, extracted.usage);
    await insertModelCall(sql, {
      provider: extractor.provider,
      model: extracted.modelVersion ?? extractor.model,
      runId,
      usage: extracted.usage,
      costUsd: cost,
      latencyMs,
    });
    addUsage(totals, extracted.usage, cost, latencyMs);

    await sql.begin(async (tx) => {
      await finishRun(tx, runId, {
        status: 'ok',
        rawOutput: extracted.rawOutput,
        usage: extracted.usage,
        costUsd: cost,
        modelVersion: extracted.modelVersion,
      });
      const counts = await writeClaims(
        tx,
        { eventId: event.event_id, scopeId: event.scope_id, sensitivity: event.sensitivity },
        runId,
        chunk,
        extracted.claims,
      );
      await logRunActivity(tx, event.event_id, runId, {
        status: 'ok',
        chunk: i + 1,
        chunks: chunks.length,
        claims: extracted.claims.length,
        verified: counts.verified,
        held: counts.held,
        inputTokens: extracted.usage.inputTokens,
        outputTokens: extracted.usage.outputTokens,
        costUsd: cost,
        latencyMs,
      });
      if (isLast) await completeJob(tx, job.jobId);
      totals.claims += extracted.claims.length;
      totals.verified += counts.verified;
      totals.held += counts.held;
    });
  }
  return { outcome: 'done' };
}

function skippedSummary(skip: string) {
  return {
    status: 'skipped' as const,
    skipReason: skip,
    chunk: 1,
    chunks: 1,
    claims: 0,
    verified: 0,
    held: 0,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    latencyMs: null,
  };
}

function addUsage(totals: Totals, usage: TokenUsage, cost: number, latencyMs: number): void {
  totals.inputTokens += usage.inputTokens;
  totals.outputTokens += usage.outputTokens;
  totals.costUsd = Math.round((totals.costUsd + cost) * 1e6) / 1e6;
  totals.latencyMs += latencyMs;
}

interface ExtractorFailure {
  err: ExtractorError;
  runId: string;
  eventId: string;
  chunk: number;
  chunks: number;
  latencyMs: number;
  totals: Totals;
}

/**
 * The call failed: record what was billed, close the run as `error`, and apply the job disposition
 * (task 5 brief §3). Later chunks aren't tried; earlier ones stay committed and are skipped on retry.
 */
async function handleExtractorError(
  deps: ProcessDeps,
  job: ClaimedJob,
  f: ExtractorFailure,
): Promise<ProcessResult> {
  const { sql, extractor, log } = deps;
  const { err } = f;
  const usage = err.extra.usage ?? null;
  const cost = usage ? costUsd(extractor.model, usage) : null;
  if (usage && cost !== null) {
    // A billed failure (schema violation, refusal, incomplete) still cost money.
    await insertModelCall(sql, {
      provider: extractor.provider,
      model: extractor.model,
      runId: f.runId,
      usage,
      costUsd: cost,
      latencyMs: f.latencyMs,
    });
    addUsage(f.totals, usage, cost, f.latencyMs);
  }
  await sql.begin(async (tx) => {
    await finishRun(tx, f.runId, {
      status: 'error',
      error: err.code,
      rawOutput: err.extra.rawOutput,
      usage,
      costUsd: cost,
      modelVersion: null,
    });
    await logRunActivity(tx, f.eventId, f.runId, {
      status: 'error',
      error: err.code,
      chunk: f.chunk,
      chunks: f.chunks,
      claims: 0,
      verified: 0,
      held: 0,
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      costUsd: cost,
      latencyMs: f.latencyMs,
    });
  });

  const fields = {
    job_id: job.jobId,
    event_id: f.eventId,
    run_id: f.runId,
    code: err.code,
    status: err.extra.status,
    provider_code: err.extra.providerCode,
    attempts: job.attempts,
  };
  if (err.code === 'aborted') {
    await deferJob(sql, job.jobId, deps.now(), null);
    log.info(fields, 'extract call aborted by shutdown; job released');
    return { outcome: 'released' };
  }
  if (err.code === 'auth') {
    // Like the budget: the wait is not the job's fault, so it keeps its attempts, and the loop
    // stops claiming so a bad key doesn't burn every job's retries.
    await deferJob(sql, job.jobId, new Date(deps.now().getTime() + AUTH_PAUSE_MS), 'auth');
    log.error(fields, 'extractor_auth_failed');
    return { outcome: 'deferred', pauseMs: AUTH_PAUSE_MS };
  }
  log.warn(fields, 'extract call failed');
  if (!err.retryable) {
    await fail(deps, job, err.code);
    return { outcome: 'failed' };
  }
  return { outcome: await retryOrFail(deps, job, err.code) };
}
