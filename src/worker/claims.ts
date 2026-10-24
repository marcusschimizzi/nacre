import { type Json, logActivity } from '../shared/activity.js';
import type { Sql, TransactionSql } from '../shared/db/sql.js';
import { newId } from '../shared/ids.js';
import type { TokenUsage } from '../shared/pricing.js';
import type { Chunk } from './chunk.js';
import type { Extractor, RawClaim } from './extractor.js';
import { valueInQuote, verifyQuote } from './quote.js';

/**
 * The rows one extraction writes (spec §4, §6.5, task 5 brief §10): `extraction_runs`,
 * `model_calls`, `claims`, `evidence_spans` and their activity entries. Row timestamps are the
 * database's `now()`; nothing here logs or returns content.
 */

type Db = Sql | TransactionSql;

const json = (sql: Db, value: Json) => sql.json(value as Parameters<typeof sql.json>[0]);

/** What every run of one extractor configuration shares. */
export interface RunIdentity {
  extractor: Extractor;
  configHash: string;
}

export interface NewRun {
  eventId: string;
  inputEventIds: string[];
}

/** A run that is about to call the model, committed before the call so a crash leaves a trace. */
export async function insertRunningRun(sql: Db, id: RunIdentity, run: NewRun): Promise<string> {
  const runId = newId('run');
  await sql`
    INSERT INTO extraction_runs (run_id, event_id, extractor, model, prompt_id, prompt_hash,
                                 config_hash, input_event_ids, status)
    VALUES (${runId}, ${run.eventId}, ${id.extractor.id}, ${id.extractor.model},
            ${id.extractor.promptId}, ${id.extractor.promptHash}, ${id.configHash},
            ${run.inputEventIds}, 'running')`;
  return runId;
}

/** A run that never calls the model (spec §6.1 skips, and the budget stop). */
export async function insertSkippedRun(
  sql: Db,
  id: RunIdentity,
  run: NewRun,
  skipReason: string,
): Promise<string> {
  const runId = newId('run');
  await sql`
    INSERT INTO extraction_runs (run_id, event_id, extractor, model, prompt_id, prompt_hash,
                                 config_hash, input_event_ids, status, skip_reason, finished_at)
    VALUES (${runId}, ${run.eventId}, ${id.extractor.id}, ${id.extractor.model},
            ${id.extractor.promptId}, ${id.extractor.promptHash}, ${id.configHash},
            ${run.inputEventIds}, 'skipped', ${skipReason}, now())`;
  return runId;
}

export interface RunFinish {
  status: 'ok' | 'error';
  /** A code, never message text. */
  error?: string | null;
  rawOutput: unknown;
  usage: TokenUsage | null;
  costUsd: number | null;
  modelVersion: string | null;
}

export async function finishRun(sql: Db, runId: string, f: RunFinish): Promise<void> {
  const raw = f.rawOutput === undefined ? null : json(sql, f.rawOutput as Json);
  await sql`
    UPDATE extraction_runs
    SET status = ${f.status}, error = ${f.error ?? null}, raw_output = ${raw},
        input_tokens = ${f.usage?.inputTokens ?? null}, output_tokens = ${f.usage?.outputTokens ?? null},
        cost_usd = ${f.costUsd}, model_version = ${f.modelVersion}, finished_at = now()
    WHERE run_id = ${runId}`;
}

/**
 * Marks this event's runs still `running` as `error`: a previous attempt crashed mid-call
 * (`abandoned`), or this one failed outside the model call (an internal code).
 */
export async function closeRunningRuns(sql: Db, eventId: string, code: string): Promise<void> {
  await sql`
    UPDATE extraction_runs SET status = 'error', error = ${code}, finished_at = now()
    WHERE event_id = ${eventId} AND status = 'running'`;
}

/** Chunks of this event already extracted with this exact prompt and configuration. */
export async function countOkRuns(sql: Db, id: RunIdentity, eventId: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM extraction_runs
    WHERE event_id = ${eventId} AND status = 'ok'
      AND prompt_hash = ${id.extractor.promptHash} AND config_hash = ${id.configHash}`;
  return row?.n ?? 0;
}

export interface ModelCall {
  provider: string;
  /** The model string the provider returned, else the configured one. */
  model: string;
  runId: string;
  usage: TokenUsage;
  costUsd: number;
  latencyMs: number;
}

/** One paid call, written as soon as it returns: the money is spent whatever happens next. */
export async function insertModelCall(sql: Db, call: ModelCall): Promise<void> {
  await sql`
    INSERT INTO model_calls (call_id, purpose, provider, model, ref_id, input_tokens, cached_tokens,
                             output_tokens, cost_usd, latency_ms)
    VALUES (${newId('mcl')}, 'extract', ${call.provider}, ${call.model}, ${call.runId},
            ${call.usage.inputTokens}, ${call.usage.cachedTokens}, ${call.usage.outputTokens},
            ${call.costUsd}, ${call.latencyMs})`;
}

/** The event fields a claim copies. */
export interface ClaimSource {
  eventId: string;
  scopeId: string;
  sensitivity: string;
}

/** Thrown when a span's quote isn't the body's text at its offsets; rolls the chunk back. */
export class SpanMismatchError extends Error {
  constructor() {
    super('span_mismatch');
    this.name = 'span_mismatch';
  }
}

/**
 * Verifies each claim's quote against the chunk's own text (never the full body or the context)
 * and writes it: `candidate` with one evidence span when the quote is found, else `held` with the
 * verifier's reason, no span and an `extraction_error` entry. Returns the counts.
 */
export async function writeClaims(
  tx: TransactionSql,
  source: ClaimSource,
  runId: string,
  chunk: Chunk,
  claims: readonly RawClaim[],
): Promise<{ verified: number; held: number }> {
  let verified = 0;
  let held = 0;
  for (const claim of claims) {
    const claimId = newId('clm');
    const result = verifyQuote(chunk.text, claim.quote);
    const checks: Json = result.ok
      ? { quote: result.matchKind, value_in_quote: valueInQuote(result.quote, claim.value) }
      : { quote: 'failed' };
    // Task 7 grounds time_phrase into valid_from/valid_to here; until then they stay null.
    // `tainted` events aren't special here: promotion (task 8, rule 4) holds their claims.
    await tx`
      INSERT INTO claims (claim_id, event_id, extraction_run_id, text, subject_text, attribute, value,
                          value_kind, assertion_type, time_phrase, confidence, confidence_reason,
                          checks, scope_id, sensitivity, status, status_reason)
      VALUES (${claimId}, ${source.eventId}, ${runId}, ${claim.text}, ${claim.subject},
              ${claim.attribute}, ${claim.value}, ${claim.value_kind}, ${claim.assertion_type},
              ${claim.time_phrase}, ${claim.confidence}, ${claim.confidence_reason},
              ${json(tx, checks)}, ${source.scopeId}, ${source.sensitivity},
              ${result.ok ? 'candidate' : 'held'}, ${result.ok ? null : result.reason})`;

    if (!result.ok) {
      held++;
      // Ids and the reason only: no quote, no claim text.
      await logActivity(tx, {
        kind: 'extraction_error',
        actor: 'worker',
        targetKind: 'claim',
        targetId: claimId,
        eventIds: [source.eventId],
        claimIds: [claimId],
        reason: result.reason,
        details: { run_id: runId },
      });
      continue;
    }

    verified++;
    const spanStart = chunk.start + result.start;
    const spanEnd = chunk.start + result.end;
    await tx`
      INSERT INTO evidence_spans (span_id, claim_id, event_id, span_start, span_end, quote,
                                  match_kind, occurrences)
      VALUES (${newId('spn')}, ${claimId}, ${source.eventId}, ${spanStart}, ${spanEnd},
              ${result.quote}, ${result.matchKind}, ${result.occurrences})`;
    // The invariant A5 and the §13.1 fidelity audit rely on; it should never fire.
    const [fidelity] = await tx<{ ok: boolean }[]>`
      SELECT substring(body FROM ${spanStart + 1}::int FOR ${spanEnd - spanStart}::int) = ${result.quote} AS ok
      FROM event_content WHERE event_id = ${source.eventId}`;
    if (!fidelity?.ok) throw new SpanMismatchError();
  }
  // Claims stay `candidate`: promotion (task 8) runs over them, including ones written before it
  // existed. Nothing here writes beliefs or claim_promoted / claim_held entries.
  return { verified, held };
}

export interface RunSummary {
  status: 'ok' | 'error' | 'skipped';
  skipReason?: string;
  error?: string;
  /** 1-based. */
  chunk: number;
  chunks: number;
  claims: number;
  verified: number;
  held: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  latencyMs: number | null;
}

/** One `extraction_run` entry per run, ok, error or skipped (spec §13.2). */
export async function logRunActivity(
  sql: Db,
  eventId: string,
  runId: string,
  s: RunSummary,
): Promise<void> {
  await logActivity(sql, {
    kind: 'extraction_run',
    actor: 'worker',
    targetKind: 'run',
    targetId: runId,
    eventIds: [eventId],
    details: {
      status: s.status,
      ...(s.skipReason ? { skip_reason: s.skipReason } : {}),
      ...(s.error ? { error: s.error } : {}),
      chunk: s.chunk,
      chunks: s.chunks,
      claims: s.claims,
      verified: s.verified,
      held: s.held,
      input_tokens: s.inputTokens,
      output_tokens: s.outputTokens,
      cost_usd: s.costUsd,
      latency_ms: s.latencyMs,
    },
  });
}
