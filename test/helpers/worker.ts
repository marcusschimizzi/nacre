import { randomBytes } from 'node:crypto';
import type { Sql } from '../../src/shared/db/sql.js';
import { ingestEvent, parseEvent } from '../../src/shared/events.js';
import { createLogger, type Logger } from '../../src/shared/logger.js';
import { createStaticToken } from '../../src/shared/tokens.js';
import {
  type ExtractInput,
  type Extractor,
  ExtractorError,
  type ExtractResult,
  type RawClaim,
  type TokenUsage,
} from '../../src/worker/extractor.js';
import type { RunDeps } from '../../src/worker/loop.js';
import { PROMPT_HASH, PROMPT_ID } from '../../src/worker/prompts/extract-claims.v1.js';
import { dbmate, dropDatabase, scratchDatabaseName, withDatabase } from './db.js';
import { validEvent } from './events.js';

export const FAKE_USAGE: TokenUsage = { inputTokens: 2500, cachedTokens: 0, outputTokens: 300 };
export const FAKE_MODEL_VERSION = 'fake-model-2026-10-01';
/** 2,500 input and 300 output tokens on gpt-6-luna (spec §12.3). */
export const FAKE_CALL_COST = 0.0004;

export type FakeBehavior = (
  input: ExtractInput,
  call: number,
) => RawClaim[] | Promise<RawClaim[]> | ExtractorError;

/** No network: returns what `behavior` gives, with fixed usage, and records every call. */
export class FakeExtractor implements Extractor {
  readonly id = 'fastpass-v1';
  readonly provider = 'openai';
  readonly model = 'gpt-6-luna';
  readonly promptId = PROMPT_ID;
  readonly promptHash = PROMPT_HASH;
  readonly settings = { model: 'gpt-6-luna', reasoning_effort: 'low', fake: true };
  readonly calls: ExtractInput[] = [];

  constructor(private readonly behavior: FakeBehavior = () => []) {}

  async extract(input: ExtractInput, opts: { signal: AbortSignal }): Promise<ExtractResult> {
    this.calls.push(input);
    if (opts.signal.aborted) throw new ExtractorError('aborted', false);
    const out = await this.behavior(input, this.calls.length);
    if (out instanceof Error) throw out;
    return {
      claims: out,
      rawOutput: { claims: out },
      usage: FAKE_USAGE,
      modelVersion: FAKE_MODEL_VERSION,
    };
  }
}

/** A claim as the model would return it, quoting `quote`. */
export function rawClaim(quote: string, overrides: Partial<RawClaim> = {}): RawClaim {
  return {
    text: 'The user prefers pnpm as their package manager.',
    subject: 'user',
    attribute: 'preferred_package_manager',
    value: 'pnpm',
    value_kind: 'literal',
    assertion_type: 'preference',
    quote,
    time_phrase: null,
    confidence: 0.9,
    confidence_reason: 'Direct first-person statement.',
    ...overrides,
  };
}

/**
 * A freshly migrated database of its own. The worker claims ANY ready job and the budget sums ALL
 * model calls, so worker tests can't share the run's database with files that ingest events.
 */
export async function isolatedDatabase(
  adminUrl: string,
  label: string,
): Promise<{ appUrl: string; ownerUrl: string; drop: () => Promise<void> }> {
  const name = scratchDatabaseName(label);
  const ownerUrl = withDatabase(adminUrl, name);
  await dbmate(ownerUrl, 'up');
  const app = new URL(ownerUrl);
  // nacre_app is cluster-wide and already has LOGIN (test/global-setup.ts).
  app.username = 'nacre_app';
  return { appUrl: app.href, ownerUrl, drop: () => dropDatabase(adminUrl, name) };
}

export interface Seeder {
  sql: Sql;
  agentId: string;
  tokenId: string;
}

/** An agent with a static token, for seeding events as ingest would. */
export async function seeder(sql: Sql, label: string): Promise<Seeder> {
  const agentId = `test-${label}-${randomBytes(3).toString('hex')}`;
  const { tokenId } = await createStaticToken(sql, randomBytes(32).toString('base64url'), {
    agentId,
  });
  return { sql, agentId, tokenId };
}

/**
 * Stores events exactly as `POST /v1/events` does (`parseEvent`, then `ingestEvent`), jobs
 * included. Each entry overrides `validEvent()`'s fields, with no session by default so events
 * aren't each other's context. Returns the event ids in order.
 */
export async function seedEvents(
  s: Seeder,
  events: Record<string, unknown>[],
  now: () => Date = () => new Date(),
): Promise<string[]> {
  const ids: string[] = [];
  for (const overrides of events) {
    const parsed = parseEvent(validEvent({ session_id: null, ...overrides }));
    if (!parsed.ok) throw new Error(`seed event is invalid: ${JSON.stringify(parsed)}`);
    const result = await ingestEvent(
      s.sql,
      { agentId: s.agentId, tokenId: s.tokenId, requestId: null },
      parsed.event,
      { now },
    );
    ids.push(result.eventId);
  }
  // `jobs.run_after` defaults to the database's now(), with microseconds, while tests claim with a
  // JavaScript Date, which has milliseconds: a claim in the same millisecond as the seed would
  // miss the job. Make the jobs due a second ago (one shift for all, so their order is unchanged).
  if (ids.length > 0) {
    await s.sql`
      UPDATE jobs SET run_after = run_after - interval '1 second'
      WHERE kind = 'extract' AND ref_id IN ${s.sql(ids)} AND status = 'queued'`;
  }
  return ids;
}

export interface CapturedLog {
  log: Logger;
  lines: string[];
  records: () => Record<string, unknown>[];
}

export function captureLog(): CapturedLog {
  const lines: string[] = [];
  const log = createLogger('nacre-worker-test', 'debug', { write: (line) => lines.push(line) });
  return {
    log,
    lines,
    records: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

export interface DepsOptions {
  now?: () => Date;
  budgetUsd?: number;
  signal?: AbortSignal;
  log?: Logger;
}

export function makeDeps(sql: Sql, extractor: Extractor, options: DepsOptions = {}): RunDeps {
  return {
    sql,
    extractor,
    log: options.log ?? captureLog().log,
    now: options.now ?? (() => new Date()),
    budgetUsd: options.budgetUsd ?? 0.5,
    pollMs: 10,
    signal: options.signal ?? new AbortController().signal,
  };
}

/** Ends every unfinished job, so the next test claims only its own. */
export async function settleJobs(sql: Sql): Promise<void> {
  await sql`
    UPDATE jobs SET status = 'failed', locked_at = NULL, last_error = 'test_settled'
    WHERE status IN ('queued', 'running')`;
}
