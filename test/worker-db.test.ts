import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { createSql, type Sql } from '../src/shared/db/sql.js';
import { budgetState } from '../src/worker/budget.js';
import { insertRunningRun } from '../src/worker/claims.js';
import { ExtractorError } from '../src/worker/extractor.js';
import { claimJob, MAX_ATTEMPTS } from '../src/worker/jobs.js';
import { drain, runOnce, runWorker } from '../src/worker/loop.js';
import { OpenAiExtractor } from '../src/worker/openai.js';
import { configHash } from '../src/worker/process.js';
import { PROMPT_HASH } from '../src/worker/prompts/extract-claims.v1.js';
import { newestMigration, readSchemaVersion } from '../src/worker/schema-wait.js';
import { fakeSecrets, randomToken } from './helpers/events.js';
import {
  captureLog,
  FAKE_CALL_COST,
  FAKE_MODEL_VERSION,
  FAKE_USAGE,
  FakeExtractor,
  isolatedDatabase,
  makeDeps,
  rawClaim,
  type Seeder,
  seedEvents,
  seeder,
  settleJobs,
} from './helpers/worker.js';

const adminUrl = inject('adminDatabaseUrl');

const PNPM = 'For the record, my preferred package manager is pnpm. Can you update the README?';
const PNPM_QUOTE = 'my preferred package manager is pnpm';

interface JobRow {
  job_id: string;
  status: string;
  attempts: number;
  run_after: Date;
  locked_at: Date | null;
  last_error: string | null;
}

describe.skipIf(!adminUrl)('worker against Postgres, as nacre_app', () => {
  let sql: Sql;
  let s: Seeder;
  let drop: () => Promise<void>;

  beforeAll(async () => {
    const db = await isolatedDatabase(adminUrl, 'worker');
    drop = db.drop;
    sql = createSql(db.appUrl, { max: 6 });
    s = await seeder(sql, 'worker');
  });
  afterAll(async () => {
    await sql?.end();
    await drop?.();
  });
  beforeEach(() => settleJobs(sql));

  const jobFor = async (eventId: string): Promise<JobRow> => {
    const [row] = await sql<JobRow[]>`
      SELECT job_id, status, attempts, run_after, locked_at, last_error
      FROM jobs WHERE kind = 'extract' AND ref_id = ${eventId}`;
    if (!row) throw new Error('no job');
    return row;
  };
  const runsFor = (eventId: string) =>
    sql<Record<string, unknown>[]>`
      SELECT * FROM extraction_runs WHERE event_id = ${eventId} ORDER BY started_at, run_id`;
  const claimsFor = (eventId: string) =>
    sql<Record<string, unknown>[]>`
      SELECT * FROM claims WHERE event_id = ${eventId} ORDER BY created_at, claim_id`;
  /** Every span of the event, with Postgres's own substring at its offsets. */
  const spansFor = (eventId: string) =>
    sql<
      {
        claim_id: string;
        span_start: number;
        span_end: number;
        quote: string;
        sql_quote: string;
        match_kind: string;
        occurrences: number;
      }[]
    >`
      SELECT s.claim_id, s.span_start, s.span_end, s.quote, s.match_kind, s.occurrences,
             substring(c.body FROM s.span_start + 1 FOR s.span_end - s.span_start) AS sql_quote
      FROM evidence_spans s JOIN event_content c USING (event_id)
      WHERE s.event_id = ${eventId} ORDER BY s.span_start`;
  const activityFor = (eventId: string, kind: string) =>
    sql<Record<string, unknown>[]>`
      SELECT * FROM activity_log WHERE kind = ${kind} AND ${eventId} = ANY (event_ids)
      ORDER BY at, entry_id`;
  const modelCallsFor = (eventId: string) =>
    sql<Record<string, unknown>[]>`
      SELECT m.* FROM model_calls m JOIN extraction_runs r ON r.run_id = m.ref_id
      WHERE r.event_id = ${eventId}`;

  /** A model_calls row at `at` (only the budget reads these; no run refers to them). */
  const spend = async (at: string, usd: number, purpose = 'extract') => {
    await sql`
      INSERT INTO model_calls (call_id, at, purpose, provider, model, cost_usd)
      VALUES (${`mcl_budget_${randomToken('alnum', 12, `${at}:${usd}:${purpose}:${spent++}`)}`},
              ${at}, ${purpose}, 'openai', 'gpt-6-luna', ${usd})`;
  };
  let spent = 0;

  describe('schema wait', () => {
    it('nacre_app can read schema_migrations, and it holds the newest migration', async () => {
      expect(await readSchemaVersion(sql)).toBe(newestMigration());
    });
  });

  describe('claiming', () => {
    it('two concurrent claims get two different jobs; with one job, the second gets none', async () => {
      const [a, b] = await seedEvents(s, [{ content: PNPM }, { content: PNPM }]);
      const now = new Date();
      const [x, y] = await Promise.all([claimJob(sql, now), claimJob(sql, now)]);
      expect(new Set([x?.eventId, y?.eventId])).toEqual(new Set([a, b]));
      expect(x?.attempts).toBe(1);

      await settleJobs(sql);
      const [c] = await seedEvents(s, [{ content: PNPM }]);
      const later = new Date(Date.now() + 1000);
      const both = await Promise.all([claimJob(sql, later), claimJob(sql, later)]);
      expect(both.filter(Boolean).map((j) => j?.eventId)).toEqual([c]);
      const job = await jobFor(c ?? '');
      expect([job.status, job.attempts]).toEqual(['running', 1]);
      expect(job.locked_at?.getTime()).toBe(later.getTime());
    });

    it('a job another worker holds locked is skipped at once, not waited for', async () => {
      const [e = ''] = await seedEvents(s, [{ content: PNPM }]);
      const later = new Date(Date.now() + 1000);
      let claimed: unknown = 'not run';
      await sql.begin(async (tx) => {
        await tx`SELECT 1 FROM jobs WHERE ref_id = ${e} FOR UPDATE`;
        const blocked = new Promise((resolve) => setTimeout(() => resolve('blocked'), 2000));
        claimed = await Promise.race([claimJob(sql, later), blocked]);
      });
      expect(claimed).toBeNull();
    });

    it('the claim statement uses FOR UPDATE SKIP LOCKED', () => {
      expect(readFileSync('src/worker/jobs.ts', 'utf8')).toMatch(/FOR UPDATE SKIP LOCKED/);
    });

    it('a job whose run_after is in the future is not claimed', async () => {
      const [e] = await seedEvents(s, [{ content: PNPM }]);
      await sql`UPDATE jobs SET run_after = now() + interval '1 hour' WHERE ref_id = ${e ?? ''}`;
      expect(await claimJob(sql, new Date())).toBeNull();
    });

    it('a running job locked 11 minutes ago is reclaimed; 9 minutes ago it is not', async () => {
      const [e] = await seedEvents(s, [{ content: PNPM }]);
      const now = new Date();
      await sql`
        UPDATE jobs SET status = 'running', attempts = 1,
                        locked_at = ${new Date(now.getTime() - 9 * 60_000)}
        WHERE ref_id = ${e ?? ''}`;
      expect(await claimJob(sql, now)).toBeNull();
      await sql`
        UPDATE jobs SET locked_at = ${new Date(now.getTime() - 11 * 60_000)}
        WHERE ref_id = ${e ?? ''}`;
      expect(await claimJob(sql, now)).toMatchObject({ eventId: e, attempts: 2 });
    });

    it('never touches an embed job', async () => {
      await sql`INSERT INTO jobs (kind, ref_id) VALUES ('embed', 'blv_untouched')`;
      expect(await claimJob(sql, new Date())).toBeNull();
      const [row] = await sql<JobRow[]>`SELECT * FROM jobs WHERE kind = 'embed'`;
      expect([row?.status, row?.attempts, row?.locked_at]).toEqual(['queued', 0, null]);
      await sql`UPDATE jobs SET status = 'done' WHERE kind = 'embed'`;
    });

    it('a stale job past MAX_ATTEMPTS fails without processing, with an activity entry', async () => {
      const [e = ''] = await seedEvents(s, [{ content: PNPM }]);
      await sql`
        UPDATE jobs SET status = 'running', attempts = ${MAX_ATTEMPTS},
                        locked_at = now() - interval '11 minutes'
        WHERE ref_id = ${e}`;
      const fake = new FakeExtractor();
      expect(await runOnce(makeDeps(sql, fake))).toEqual({ outcome: 'failed' });
      expect(fake.calls).toHaveLength(0);
      const job = await jobFor(e);
      expect([job.status, job.last_error, job.attempts]).toEqual(['failed', 'stale_lock', 6]);
      const [entry] = await activityFor(e, 'extraction_error');
      expect(entry).toMatchObject({
        actor: 'worker',
        target_kind: 'job',
        target_id: job.job_id,
        reason: 'stale_lock',
        details: { attempts: 6 },
      });
    });
  });

  describe('pipeline', () => {
    it('happy path: one ok run, one model call, two candidate claims with spans, the job done', async () => {
      const [e = ''] = await seedEvents(s, [{ content: PNPM }]);
      const fake = new FakeExtractor(() => [
        rawClaim(PNPM_QUOTE),
        rawClaim('Can you update the README', {
          text: 'The user wants the README updated.',
          attribute: 'pending_request',
          value: 'README',
          assertion_type: 'instruction',
        }),
      ]);
      expect(await drain(makeDeps(sql, fake))).toEqual([{ outcome: 'done' }]);
      expect(fake.calls).toHaveLength(1);
      expect(fake.calls[0]?.target).toEqual({ kind: 'message', role: 'user', text: PNPM });

      const [run, ...more] = await runsFor(e);
      expect(more).toEqual([]);
      expect(run).toMatchObject({
        status: 'ok',
        extractor: 'fastpass-v1',
        model: 'gpt-6-luna',
        model_version: FAKE_MODEL_VERSION,
        prompt_id: 'extract-claims',
        prompt_hash: PROMPT_HASH,
        config_hash: configHash(fake),
        input_event_ids: [e],
        input_tokens: 2500,
        output_tokens: 300,
        cost_usd: '0.000400',
        error: null,
        skip_reason: null,
      });
      expect(run?.config_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(run?.finished_at).toBeInstanceOf(Date);
      expect(run?.raw_output).toEqual({ claims: fake.calls.length ? expect.any(Array) : [] });

      const calls = await modelCallsFor(e);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        purpose: 'extract',
        provider: 'openai',
        model: FAKE_MODEL_VERSION,
        ref_id: run?.run_id,
        input_tokens: 2500,
        cached_tokens: 0,
        output_tokens: 300,
        cost_usd: '0.000400',
      });

      const claims = await claimsFor(e);
      expect(claims.map((c) => [c.status, c.scope_id, c.sensitivity])).toEqual([
        ['candidate', 'personal', 'normal'],
        ['candidate', 'personal', 'normal'],
      ]);
      expect(claims[0]).toMatchObject({
        extraction_run_id: run?.run_id,
        subject_text: 'user',
        attribute: 'preferred_package_manager',
        value: 'pnpm',
        value_kind: 'literal',
        assertion_type: 'preference',
        checks: { quote: 'exact', value_in_quote: true },
        status_reason: null,
        valid_from: null,
        valid_to: null,
        valid_precision: 'unknown',
        time_source: 'inferred_from_event_time',
      });
      expect(claims[1]?.checks).toEqual({ quote: 'exact', value_in_quote: true });

      const spans = await spansFor(e);
      expect(spans).toHaveLength(2);
      for (const span of spans) expect(span.quote).toBe(span.sql_quote);
      expect(spans[0]).toMatchObject({
        span_start: 16,
        span_end: 52,
        quote: PNPM_QUOTE,
        match_kind: 'exact',
        occurrences: 1,
      });

      const [entry, ...others] = await activityFor(e, 'extraction_run');
      expect(others).toEqual([]);
      expect(entry).toMatchObject({
        actor: 'worker',
        target_kind: 'run',
        target_id: run?.run_id,
        details: {
          status: 'ok',
          chunk: 1,
          chunks: 1,
          claims: 2,
          verified: 2,
          held: 0,
          input_tokens: 2500,
          output_tokens: 300,
          cost_usd: FAKE_CALL_COST,
        },
      });
      const job = await jobFor(e);
      expect([job.status, job.locked_at, job.last_error, job.attempts]).toEqual([
        'done',
        null,
        null,
        1,
      ]);
      // Nothing promotes yet.
      expect(await sql`SELECT 1 FROM beliefs`).toHaveLength(0);
      expect(await activityFor(e, 'claim_promoted')).toHaveLength(0);
    });

    it('value_in_quote is a soft signal: false, and the claim is still a candidate', async () => {
      const [e = ''] = await seedEvents(s, [{ content: PNPM }]);
      const fake = new FakeExtractor(() => [rawClaim(PNPM_QUOTE, { value: 'yarn' })]);
      await drain(makeDeps(sql, fake));
      const [claim] = await claimsFor(e);
      expect([claim?.status, claim?.checks]).toEqual([
        'candidate',
        { quote: 'exact', value_in_quote: false },
      ]);
    });

    it.each([
      ['an assistant message', { role: 'assistant' }, 'role:assistant'],
      ['a private message', { sensitivity_hint: 'private' }, 'sensitivity:private'],
      ['a restricted message', { sensitivity_hint: 'restricted' }, 'sensitivity:restricted'],
      ['a message that is only a redacted key', { content: fakeSecrets().skKey }, 'empty'],
    ])('skips %s: one skipped run, one entry, the job done, no model call', async (_n, o, why) => {
      const [e = ''] = await seedEvents(s, [{ content: PNPM, ...o }]);
      const fake = new FakeExtractor(() => [rawClaim(PNPM_QUOTE)]);
      expect(await drain(makeDeps(sql, fake))).toEqual([{ outcome: 'skipped' }]);
      expect(fake.calls).toHaveLength(0);
      const runs = await runsFor(e);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        status: 'skipped',
        skip_reason: why,
        input_event_ids: [e],
        input_tokens: null,
        output_tokens: null,
        cost_usd: null,
        prompt_hash: PROMPT_HASH,
      });
      expect(runs[0]?.finished_at).toBeInstanceOf(Date);
      const entries = await activityFor(e, 'extraction_run');
      expect(entries).toHaveLength(1);
      expect(entries[0]?.details).toMatchObject({ status: 'skipped', skip_reason: why });
      expect((await jobFor(e)).status).toBe('done');
      expect(await modelCallsFor(e)).toHaveLength(0);
      expect(await claimsFor(e)).toHaveLength(0);
    });

    it('holds claims whose quote fails: no span, one extraction_error each, raw output kept', async () => {
      const [e = ''] = await seedEvents(s, [{ content: PNPM }]);
      const fake = new FakeExtractor(() => [
        rawClaim('my favourite package manager is pnpm'),
        rawClaim('pnp'),
        rawClaim('my preferred... is pnpm'),
      ]);
      await drain(makeDeps(sql, fake));
      const claims = await claimsFor(e);
      expect(claims.map((c) => [c.status, c.status_reason, c.checks])).toEqual([
        ['held', 'quote_not_found', { quote: 'failed' }],
        ['held', 'quote_length', { quote: 'failed' }],
        ['held', 'ellipsis', { quote: 'failed' }],
      ]);
      expect(await spansFor(e)).toHaveLength(0);
      const errors = await activityFor(e, 'extraction_error');
      expect(errors.map((a) => [a.target_id, a.reason])).toEqual(
        claims.map((c) => [c.claim_id, c.status_reason]),
      );
      for (const [i, a] of errors.entries()) {
        expect(a).toMatchObject({
          actor: 'worker',
          target_kind: 'claim',
          claim_ids: [claims[i]?.claim_id],
          event_ids: [e],
        });
        expect(JSON.stringify(a)).not.toMatch(/favourite|pnp'|preferred/);
      }
      const [run] = await runsFor(e);
      expect(run?.status).toBe('ok');
      expect(run?.raw_output).toEqual({
        claims: expect.arrayContaining([expect.objectContaining({ quote: 'pnp' })]),
      });
      expect((await activityFor(e, 'extraction_run'))[0]?.details).toMatchObject({
        claims: 3,
        verified: 0,
        held: 3,
      });
    });

    it('context: up to four earlier same-session events, oldest first, cut to 1,000 code points', async () => {
      const at = (sec: number) => `2026-10-21T14:05:${String(sec).padStart(2, '0')}-05:00`;
      const session = `sess-ctx-${randomToken('alnum', 8, String(Date.now()))}`;
      const long = `${'😀'.repeat(990)} Dana works at Acme Corp as a data engineer. ${'x'.repeat(600)}`;
      const ids = await seedEvents(s, [
        { session_id: session, observed_at: at(1), content: 'first, too old to be seen' },
        { session_id: session, observed_at: at(2), content: 'assistant turn', role: 'assistant' },
        {
          session_id: session,
          observed_at: at(3),
          content: 'a private turn',
          sensitivity_hint: 'private',
        },
        { session_id: 'another-session', observed_at: at(4), content: 'other session' },
        { session_id: session, observed_at: at(5), content: long },
        {
          session_id: session,
          observed_at: at(6),
          content: 'restricted',
          sensitivity_hint: 'restricted',
        },
        { session_id: session, observed_at: at(7), content: 'sixth' },
        { session_id: session, observed_at: at(8), content: 'seventh' },
        {
          session_id: session,
          observed_at: at(9),
          content: 'She is my sister. My preferred package manager is pnpm.',
        },
        { session_id: session, observed_at: at(20), content: 'later turn, not context' },
      ]);
      const target = ids[8] ?? '';
      const fake = new FakeExtractor((input) =>
        input.target.text.startsWith('She is my sister')
          ? [rawClaim('Dana works at Acme Corp as a data engineer', { value: 'Acme Corp' })]
          : [],
      );
      await drain(makeDeps(sql, fake));
      const call = fake.calls.find((c) => c.target.text.startsWith('She is my sister'));
      expect(call?.context.map((c) => c.role)).toEqual(['assistant', 'user', 'user', 'user']);
      expect(call?.context.map((c) => c.text)).toEqual([
        'assistant turn',
        Array.from(long).slice(0, 1000).join(''),
        'sixth',
        'seventh',
      ]);
      const [run] = await runsFor(target);
      expect(run?.input_event_ids).toEqual([ids[1], ids[4], ids[6], ids[7], target]);
      // A quote found only in context is held.
      const [claim] = await claimsFor(target);
      expect([claim?.status, claim?.status_reason]).toEqual(['held', 'quote_not_found']);
      // No context without a session.
      const [lone = ''] = await seedEvents(s, [{ session_id: null, content: PNPM }]);
      await drain(makeDeps(sql, fake));
      expect(fake.calls.at(-1)?.context).toEqual([]);
      expect((await runsFor(lone))[0]?.input_event_ids).toEqual([lone]);
    });

    it('chunks: a retryable failure on chunk 2 resumes there, with no duplicate claims', async () => {
      const filler = (n: number) => 'lorem ipsum dolor '.repeat(n);
      const paragraphs = [
        `Fact one: I drink green tea every morning. ${filler(270)}`,
        `Fact two: my sister Dana lives in Austin. ${filler(270)}`,
        `Fact three: I ride a red bicycle to work. ${filler(270)}`,
      ];
      const body = paragraphs.join('\n\n');
      const [e = ''] = await seedEvents(s, [{ content: body }]);
      const quotes = [
        'I drink green tea every morning',
        'my sister Dana lives in Austin',
        'I ride a red bicycle to work',
      ];
      const seen: number[] = [];
      let failedOnce = false;
      const fake = new FakeExtractor((input) => {
        const n = quotes.findIndex((q) => input.target.text.includes(q));
        seen.push(n + 1);
        if (n === 1 && !failedOnce) {
          failedOnce = true;
          return new ExtractorError('rate_limited', true);
        }
        return [rawClaim(quotes[n] ?? '', { value: 'x' })];
      });
      const t0 = new Date();
      expect(await drain(makeDeps(sql, fake, { now: () => t0 }))).toEqual([{ outcome: 'retry' }]);
      let job = await jobFor(e);
      expect([job.status, job.last_error, job.attempts]).toEqual(['queued', 'rate_limited', 1]);
      expect(job.run_after.getTime()).toBe(t0.getTime() + 30_000);
      expect(await claimsFor(e)).toHaveLength(1);

      const t1 = new Date(t0.getTime() + 31_000);
      expect(await drain(makeDeps(sql, fake, { now: () => t1 }))).toEqual([{ outcome: 'done' }]);
      job = await jobFor(e);
      expect([job.status, job.attempts]).toEqual(['done', 2]);
      // Chunk 1 once, chunk 2 twice (failed, then retried), chunk 3 once: 1 + 2 + 1.
      expect(seen).toEqual([1, 2, 2, 3]);
      const claims = await claimsFor(e);
      expect(claims).toHaveLength(3);
      const spans = await spansFor(e);
      expect(spans.map((sp) => sp.quote)).toEqual(quotes);
      for (const sp of spans) expect(sp.quote).toBe(sp.sql_quote);
      // Offsets are into the full body, not the chunk.
      expect(spans[2]?.span_start).toBeGreaterThan(8000);
      expect(spans[2]?.span_start).toBe(body.indexOf(quotes[2] ?? ''));
      const runs = await runsFor(e);
      expect(runs.map((r) => [r.status, r.error])).toEqual([
        ['ok', null],
        ['error', 'rate_limited'],
        ['ok', null],
        ['ok', null],
      ]);
      expect(
        (await activityFor(e, 'extraction_run')).map((a) => (a.details as { chunk: number }).chunk),
      ).toEqual([1, 2, 2, 3]);
    });

    it('a run left running by a crash is closed as abandoned', async () => {
      const [e = ''] = await seedEvents(s, [{ content: PNPM }]);
      const fake = new FakeExtractor(() => []);
      const crashed = await insertRunningRun(
        sql,
        { extractor: fake, configHash: configHash(fake) },
        { eventId: e, inputEventIds: [e] },
      );
      await drain(makeDeps(sql, fake));
      const [row] = await sql<{ status: string; error: string; finished_at: Date }[]>`
        SELECT status, error, finished_at FROM extraction_runs WHERE run_id = ${crashed}`;
      expect([row?.status, row?.error]).toEqual(['error', 'abandoned']);
      expect((await jobFor(e)).status).toBe('done');
    });
  });

  describe('dispositions', () => {
    it('a retryable error requeues with the backoff and the code', async () => {
      const [e = ''] = await seedEvents(s, [{ content: PNPM }]);
      const now = new Date();
      await sql`UPDATE jobs SET attempts = 2 WHERE ref_id = ${e}`;
      const fake = new FakeExtractor(() => new ExtractorError('http_5xx', true, { status: 502 }));
      expect(await drain(makeDeps(sql, fake, { now: () => now }))).toEqual([{ outcome: 'retry' }]);
      const job = await jobFor(e);
      expect([job.status, job.last_error, job.attempts, job.locked_at]).toEqual([
        'queued',
        'http_5xx',
        3,
        null,
      ]);
      expect(job.run_after.getTime()).toBe(now.getTime() + 8 * 60_000);
      expect(await modelCallsFor(e)).toHaveLength(0);
    });

    it('the fifth failure fails the job, with an extraction_error entry', async () => {
      const [e = ''] = await seedEvents(s, [{ content: PNPM }]);
      await sql`UPDATE jobs SET attempts = ${MAX_ATTEMPTS - 1} WHERE ref_id = ${e}`;
      const fake = new FakeExtractor(() => new ExtractorError('timeout', true));
      expect(await drain(makeDeps(sql, fake))).toEqual([{ outcome: 'failed' }]);
      const job = await jobFor(e);
      expect([job.status, job.last_error, job.attempts]).toEqual(['failed', 'timeout', 5]);
      const entries = await activityFor(e, 'extraction_error');
      expect(entries.map((a) => [a.target_kind, a.reason, a.details])).toEqual([
        ['job', 'timeout', { attempts: 5 }],
      ]);
    });

    it('a permanent error fails at once', async () => {
      const [e = ''] = await seedEvents(s, [{ content: PNPM }]);
      const fake = new FakeExtractor(() => new ExtractorError('http_4xx', false, { status: 400 }));
      expect(await drain(makeDeps(sql, fake))).toEqual([{ outcome: 'failed' }]);
      expect(await jobFor(e)).toMatchObject({
        status: 'failed',
        last_error: 'http_4xx',
        attempts: 1,
      });
    });

    it('an auth error waits 5 minutes without spending an attempt, and the loop pauses', async () => {
      const [a = '', b = ''] = await seedEvents(s, [{ content: PNPM }, { content: PNPM }]);
      const fake = new FakeExtractor(() => new ExtractorError('auth', false, { status: 401 }));
      const controller = new AbortController();
      const captured = captureLog();
      const now = new Date();
      const worker = runWorker({
        ...makeDeps(sql, fake, { now: () => now, log: captured.log }),
        signal: controller.signal,
      });
      // With 10 ms polls, an unpaused loop would reach the second job at once.
      const until = Date.now() + 400;
      while (Date.now() < until && fake.calls.length === 0)
        await new Promise((r) => setTimeout(r, 5));
      await new Promise((r) => setTimeout(r, 300));
      controller.abort();
      await worker;
      expect(fake.calls).toHaveLength(1);
      const first =
        (await jobFor(a)).status === 'queued' && (await jobFor(a)).last_error === 'auth' ? a : b;
      const job = await jobFor(first);
      expect([job.status, job.last_error, job.attempts]).toEqual(['queued', 'auth', 0]);
      expect(job.run_after.getTime()).toBe(now.getTime() + 5 * 60_000);
      expect(captured.records().filter((l) => l.msg === 'extractor_auth_failed')).toHaveLength(1);
    });

    it('a shutdown during the call releases the job without spending an attempt', async () => {
      const [e = ''] = await seedEvents(s, [{ content: PNPM }]);
      const controller = new AbortController();
      const now = new Date();
      const fake = new FakeExtractor(() => {
        controller.abort();
        return new ExtractorError('aborted', false);
      });
      const deps = makeDeps(sql, fake, { now: () => now, signal: controller.signal });
      expect(await runOnce(deps)).toEqual({ outcome: 'released' });
      const job = await jobFor(e);
      expect([job.status, job.attempts, job.last_error]).toEqual(['queued', 0, null]);
      expect(job.run_after.getTime()).toBe(now.getTime());
      expect((await runsFor(e))[0]).toMatchObject({ status: 'error', error: 'aborted' });
    });

    it('a billed schema violation writes a model call and an error run holding the raw text', async () => {
      const [e = ''] = await seedEvents(s, [{ content: PNPM }]);
      const fake = new FakeExtractor(
        () =>
          new ExtractorError('schema_violation', true, {
            usage: FAKE_USAGE,
            rawOutput: '{"claims": [ not json',
          }),
      );
      expect(await drain(makeDeps(sql, fake))).toEqual([{ outcome: 'retry' }]);
      const [run] = await runsFor(e);
      expect(run).toMatchObject({
        status: 'error',
        error: 'schema_violation',
        raw_output: '{"claims": [ not json',
        cost_usd: '0.000400',
      });
      const calls = await modelCallsFor(e);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ ref_id: run?.run_id, cost_usd: '0.000400' });
    });
  });

  describe('budget (spec §12.2)', () => {
    it('day bounds follow Chicago, DST included', async () => {
      const a = await budgetState(sql, new Date('2026-10-24T03:00:00Z'), 0.5);
      expect([a.day, a.nextStart.toISOString()]).toEqual([
        '2026-10-23',
        '2026-10-24T05:00:00.000Z',
      ]);
      const b = await budgetState(sql, new Date('2026-11-01T12:00:00Z'), 0.5);
      expect([b.day, b.dayStart.toISOString(), b.nextStart.toISOString()]).toEqual([
        '2026-11-01',
        '2026-11-01T05:00:00.000Z',
        '2026-11-02T06:00:00.000Z',
      ]);
      await spend('2026-11-02T05:30:00Z', 0.123);
      expect((await budgetState(sql, new Date('2026-11-01T12:00:00Z'), 0.5)).spentUsd).toBe(0.123);
      expect((await budgetState(sql, new Date('2026-11-02T12:00:00Z'), 0.5)).spentUsd).toBe(0);
    });

    it('spend exactly at the limit counts as exhausted; yesterday does not count; embeddings do', async () => {
      await spend('2030-07-01T17:00:00Z', 0.5);
      expect((await budgetState(sql, new Date('2030-07-01T18:00:00Z'), 0.5)).exhausted).toBe(true);
      expect((await budgetState(sql, new Date('2030-07-01T18:00:00Z'), 0.500001)).exhausted).toBe(
        false,
      );
      // 2030-07-02T04:00Z is still July 1 in Chicago.
      await spend('2030-07-02T04:00:00Z', 0.2);
      const next = await budgetState(sql, new Date('2030-07-02T12:00:00Z'), 0.5);
      expect([next.day, next.spentUsd, next.exhausted]).toEqual(['2030-07-02', 0, false]);
      await spend('2030-07-03T15:00:00Z', 0.3, 'embed_belief');
      await spend('2030-07-03T16:00:00Z', 0.2, 'embed_query');
      expect((await budgetState(sql, new Date('2030-07-03T18:00:00Z'), 0.5)).exhausted).toBe(true);
    });

    it('defers jobs to the next Chicago midnight, one budget_stop per day, skips still logged', async () => {
      await spend('2030-06-12T15:00:00Z', 0.3);
      await spend('2030-06-12T16:00:00Z', 0.25, 'embed_belief');
      const [x = '', y = '', z = ''] = await seedEvents(s, [
        { content: PNPM },
        { content: PNPM },
        { content: PNPM, role: 'assistant' },
      ]);
      const fake = new FakeExtractor(() => [rawClaim(PNPM_QUOTE)]);
      const captured = captureLog();
      const day1 = new Date('2030-06-12T18:00:00Z');
      const outcomes = await drain(makeDeps(sql, fake, { now: () => day1, log: captured.log }));
      expect(outcomes.map((o) => o.outcome).sort()).toEqual(['deferred', 'deferred', 'skipped']);
      expect(fake.calls).toHaveLength(0);
      for (const e of [x, y]) {
        const job = await jobFor(e);
        expect([job.status, job.attempts, job.last_error]).toEqual(['queued', 0, 'budget']);
        expect(job.run_after.toISOString()).toBe('2030-06-13T05:00:00.000Z');
        const runs = await runsFor(e);
        expect(runs.map((r) => [r.status, r.skip_reason])).toEqual([['skipped', 'budget']]);
        expect(await activityFor(e, 'extraction_run')).toHaveLength(1);
      }
      expect((await runsFor(z))[0]?.skip_reason).toBe('role:assistant');
      const stops = await sql<{ details: Record<string, unknown> }[]>`
        SELECT details FROM activity_log
        WHERE kind = 'system' AND details->>'step' = 'budget_stop' AND details->>'day' = '2030-06-12'`;
      expect(stops).toEqual([
        { details: { step: 'budget_stop', day: '2030-06-12', spent_usd: 0.55, budget_usd: 0.5 } },
      ]);
      const warns = captured.records().filter((l) => l.level === 40);
      expect(warns[0]).toMatchObject({ day: '2030-06-12', spent_usd: 0.55, budget_usd: 0.5 });

      // Past that midnight the same jobs run.
      const day2 = new Date('2030-06-13T05:00:01Z');
      expect((await drain(makeDeps(sql, fake, { now: () => day2 }))).map((o) => o.outcome)).toEqual(
        ['done', 'done'],
      );
      expect(fake.calls).toHaveLength(2);
      expect((await jobFor(x)).attempts).toBe(1);
    });
  });

  describe('no content and no secrets in logs, job errors, run errors or activity', () => {
    it('on the success, skip, held, retry, failed and budget paths', async () => {
      const sentinel = `SENTINEL${randomToken('alnum', 16, 'worker-sentinel')}`;
      const quote = `my preferred tool is ${sentinel} today`;
      const body = `For the record, ${quote}. Please note it.`;
      const claimText = `CLAIMTEXT${sentinel}`;
      const claim = (q: string) => rawClaim(q, { text: claimText, value: sentinel });
      const captured = captureLog();
      const run = async (behavior: ConstructorParameters<typeof FakeExtractor>[0], o = {}) => {
        const [e = ''] = await seedEvents(s, [{ content: body, ...o }]);
        await drain(makeDeps(sql, new FakeExtractor(behavior), { log: captured.log }));
        return e;
      };
      const events = [
        await run(() => [claim(quote)]),
        await run(() => [claim(quote)], { role: 'assistant' }),
        await run(() => [claim(`${sentinel} is not in the body`)]),
        await run(
          () =>
            new ExtractorError('schema_violation', true, {
              rawOutput: sentinel,
              usage: FAKE_USAGE,
            }),
        ),
        await run(() => new ExtractorError('refusal', false, { usage: FAKE_USAGE })),
      ];
      await spend('2030-09-01T15:00:00Z', 1);
      const [budgeted = ''] = await seedEvents(s, [{ content: body }]);
      await drain(
        makeDeps(sql, new FakeExtractor(() => [claim(quote)]), {
          log: captured.log,
          now: () => new Date('2030-09-01T18:00:00Z'),
        }),
      );
      events.push(budgeted);

      const logs = captured.lines.join('\n');
      for (const needle of [sentinel, quote, claimText, 'For the record']) {
        expect(logs).not.toContain(needle);
      }
      const rows = await sql<{ j: string }[]>`
        SELECT concat_ws(' ',
          (SELECT string_agg(coalesce(last_error, ''), ' ') FROM jobs WHERE ref_id = ANY (${events})),
          (SELECT string_agg(coalesce(error, ''), ' ') FROM extraction_runs WHERE event_id = ANY (${events})),
          (SELECT string_agg(a::text, ' ') FROM activity_log a WHERE event_ids && ${events})) AS j`;
      expect(rows[0]?.j).not.toContain(sentinel);
      expect(rows[0]?.j).toContain('quote_not_found');
      // But the content is where it belongs: the claim, the span and the run's raw output.
      expect(await sql`SELECT 1 FROM claims WHERE text = ${claimText}`).not.toHaveLength(0);
    });

    it('the real adapter, served fixtures, never logs its key', async () => {
      const key = `sk-${'proj-'}${randomToken('alnum', 48, 'worker-db-key')}`;
      const okBody = readFileSync(
        new URL('./fixtures/openai/ok-two-claims.json', import.meta.url),
        'utf8',
      );
      const captured = captureLog();
      for (const [status, body] of [
        [200, okBody],
        [401, '{"error":{"code":"invalid_api_key","message":"Incorrect API key provided"}}'],
      ] as const) {
        await settleJobs(sql);
        const [e = ''] = await seedEvents(s, [{ content: PNPM }]);
        const extractor = new OpenAiExtractor({
          apiKey: key,
          model: 'gpt-6-luna',
          fetchImpl: async () => new Response(body, { status }),
        });
        await drain(makeDeps(sql, extractor, { log: captured.log }));
        if (status === 200) {
          const claims = await claimsFor(e);
          // Both fixture quotes are in the body.
          expect(claims.map((c) => [c.status, c.attribute])).toEqual([
            ['candidate', 'preferred_package_manager'],
            ['candidate', 'pending_request'],
          ]);
          expect((await modelCallsFor(e))[0]).toMatchObject({
            model: 'gpt-6-luna',
            cost_usd: '0.000400',
          });
        } else {
          expect(await jobFor(e)).toMatchObject({ status: 'queued', last_error: 'auth' });
        }
      }
      expect(captured.lines.join('\n')).not.toContain(key);
      expect(captured.lines.join('\n')).not.toContain('Incorrect API key');
      expect(captured.records().find((l) => l.msg === 'extractor_auth_failed')).toMatchObject({
        status: 401,
        provider_code: 'invalid_api_key',
      });
    });
  });
});
