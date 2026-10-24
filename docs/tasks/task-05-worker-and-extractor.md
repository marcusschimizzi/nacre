# Task 5: Worker loop, `Extractor`, OpenAI adapter, prompt v1, cost guard

*Brief v1.1, Oct 24, 2026 (v1.1: Marcus's answers to the three questions are recorded as decided, and spec v0.2.18 now carries the decisions below). Written after task 4 merged (PR #28, merge `2a3ca55`). Paste this whole file into Claude Code or Codex, run from an up-to-date clone of `github.com/marcusschimizzi/nacre` (`main` at or after `2a3ca55`). Marcus reviews the PR. Spec: `docs/slice-1-spec.md` v0.2.18. **Task 6 (the quote verifier) is built in parallel by someone else;** the two briefs share one interface contract, §9 below.*

## Context
Task 4 made `POST /v1/events` write an event, its content and an `extract` job in one transaction. Nothing consumes those jobs: `src/worker/main.ts` is a placeholder loop. This task builds the **worker**: it waits for the schema, claims `extract` jobs with `FOR UPDATE SKIP LOCKED`, decides whether each event may be mined (§6.1), calls a model through a provider-agnostic `Extractor`, checks every proposed quote with code, and writes **`extraction_runs`, `claims`, `evidence_spans`, `model_calls` and activity entries**. It also enforces the **$0.50/day budget**. After this task a message posted to `/v1/events` ends up as `candidate` or `held` claims with verified evidence. **Nothing promotes them** (task 8) and nothing resolves their dates (task 7); no belief exists yet.

What one job does (spec §3, steps 2 to 4): load the event and its body, skip it if it must not be mined, build context from the same session, split a long body into chunks, check the budget, call the model once per chunk, verify each claim's quote against the chunk's text, and in one transaction per chunk write the run, the claims, their evidence spans and the activity entries; the last chunk's transaction also marks the job `done`.

**Decided, already in the spec or by Marcus (don't reopen):**
- **Models and API (§12.3):** default `gpt-6-luna`, fallback `gpt-5.6-luna` (a config change, `LLM_MODEL`), through OpenAI's **Responses API** with strict `json_schema` structured output and `reasoning.effort` `low`. Slice 1 ships the OpenAI adapter only; the `Extractor` interface stays provider-agnostic so an Anthropic adapter can be added later without touching the worker.
- **What is extracted (§6.1):** `role=user` messages and `remember` events. **Assistant turns are stored but never mined** (run logged `skipped: role:assistant`). **`private` and `restricted` events never go to a hosted model** (run logged `skipped`, with the sensitivity). Assistant turns are context for the next user turn only.
- **Prompt `extract-claims` v1 is §6.3**, output schema §5.3 (`additionalProperties: false`). Every run records the prompt id and **hash**; the raw model output is stored on the run even when every claim fails verification (§6.3, design notes).
- **Code decides quotes (§6.5).** The model never checks its own quote. A claim whose quote fails is **written as `held`** with the reason, never dropped, never promoted. Verification is task 6's function (§9).
- **Cost guard (§12.2, Decided budget $0.50/day):** the worker sums today's `model_calls.cost_usd`, **today = midnight to midnight America/Chicago**, before every paid call. Above `DAILY_LLM_BUDGET_USD` (default 0.50), no new paid call starts: the job waits with `run_after` set to the next day, and the attempted run is logged `skipped: budget`.
- **Jobs (§12.2):** the `jobs` table, `FOR UPDATE SKIP LOCKED`, polled every `WORKER_POLL_MS` (default 1,000).
- **No model calls in CI, ever.** Tests use a fake `Extractor` and recorded-shape fixtures (§13). The live OpenAI check is a **manual step for Marcus** (§12 and §14).
- **No secrets in the repo, logs or tests.** The key is `OPENAI_API_KEY`, set by Marcus on Railway himself. Never committed, never logged, never in an error message, never in a test (use obviously fake placeholder strings built at runtime, as `test/helpers/events.ts` does).
- **The worker never logs event content:** no body, no quote, no claim text, no raw model output, no provider error text. Ids, counts, codes and SQLSTATEs only (§11).
- Only `api` migrates (its pre-deploy step). **The worker never runs migrations**; it waits for them (`migrations/README.md`, "Only `api` migrates").

**Decided in this brief (now also in spec v0.2.18; list under "Spec updates to apply" in the PR only what the build adds beyond it):** the retry numbers (§3), chunking and one run per chunk (§4), context rules (§4), the held reasons written here (§10), the `checks` shape for a failed quote (§10), the env var name `OPENAI_API_KEY` (`.env.example` says `LLM_API_KEY`, which the build renames; spec v0.2.18 says `OPENAI_API_KEY`; Marcus chose the OpenAI-specific name on Oct 24, 2026, because the adapter is OpenAI-only and a later Anthropic adapter gets its own key), and the idle mode without a key (§1).

**This task adds exactly one migration, one line of SQL, and no other schema change.** `nacre_app` can't read `schema_migrations` today (`migrations/20261023000100_roles.sql` leaves it out on purpose; verified: `permission denied for table schema_migrations`), so the "worker waits until the schema is current" rule Marcus recorded in `migrations/README.md` cannot work as written. §2 adds `GRANT SELECT ON schema_migrations TO nacre_app` (read-only, one table). Everything else this task writes is already allowed: `nacre_app` has `SELECT, INSERT` on `events`, `event_content`, `extraction_runs`, `claims`, `evidence_spans`, `model_calls`, `activity_log` and `jobs`, `UPDATE` on `extraction_runs` and `jobs` (table-wide), `UPDATE (status, status_reason)` on `claims`, and `USAGE` on `jobs_job_id_seq`; no `DELETE`. **No new table, column, index or other grant.** If you think you need more, stop and say why in the PR (see Question 1 for the alternative to the grant).

**Read first:** `docs/slice-1-spec.md` §3, §4 (`events`, `event_content`, `extraction_runs`, `claims`, `evidence_spans`, `model_calls`, `jobs`, `activity_log`), §5.3, §5.4, §6.1, §6.3, §6.5, §12.1, §12.2 (cost guard), §12.3, §13.1, §13.2, §14 A4, A9, A12, §16 R8; `docs/tasks/task-06-quote-verifier.md` §1 (the contract) and §9; `docs/tasks/task-04-event-ingest.md` (style, and how events and jobs are written); `migrations/README.md` and `migrations/20261023000100_roles.sql`; `src/worker/main.ts`, `src/shared/{config,activity,ids,logger,events}.ts`, `src/shared/db/sql.ts`, `src/audit/schema-guards.ts`; `test/helpers/{app,db,events}.ts`, `test/a11.test.ts` (database tests as `nacre_app`), `test/redact.test.ts` (seeded properties and time guards), `test/db.test.ts`, `test/db-commands.test.ts`, `test/worker.test.ts`; `.railway/railway.ts`; `.env.example`.

## What to do

Suggested layout (rename if you have a reason, and say so in the PR):
- `src/worker/main.ts`: rewritten startup (§1, §2).
- `src/worker/schema-wait.ts`: `waitForSchema`.
- `src/worker/jobs.ts`: claim, complete, retry, fail, defer, release (§3).
- `src/worker/loop.ts`: `runOnce`, `drain`, `runWorker`.
- `src/worker/process.ts`: `processExtractJob`, the pipeline (§4, §10).
- `src/worker/skip.ts`, `src/worker/context.ts`, `src/worker/chunk.ts`: the pure pieces of §4.
- `src/worker/budget.ts`: the day bounds and the guard (§8).
- `src/worker/claims.ts`: the SQL that writes runs, claims, spans and model calls (§10).
- `src/worker/extractor.ts`: the `Extractor` interface, `ExtractorError` (§5).
- `src/worker/openai.ts`: the adapter (§7). `src/worker/prompts/extract-claims.v1.ts`: prompt v1 (§6).
- `src/worker/quote.ts`: the one file the pipeline imports the verifier from; `src/worker/quote-stub.ts`: temporary (§9).
- `src/worker/smoke.ts`: the manual live check (§12).
- `src/shared/pricing.ts`: the pinned price table and `costUsd` (§8). `src/shared/config.ts`: the worker variables (§1).
- `migrations/20261024120000_grant_schema_migrations_select.sql`; edits to `migrations/README.md`, `src/audit/schema-guards.ts`, `test/db.test.ts`, `test/db-commands.test.ts` (§2).
- Tests: see §13. `.env.example`, `.railway/railway.ts` (edit only), root `README.md`, `docs/tasks/README.md` (§14).

### 1. Configuration, and what `main.ts` does
`workerEnv` in `src/shared/config.ts` becomes:

| Variable | Rule |
|---|---|
| `DATABASE_URL` | **required**, `postgres://`. The runtime URL, as `nacre_app` (never the owner) |
| `OPENAI_API_KEY` | optional string, min length 1. **Never echoed:** `parse()` already reports names, not values; keep it so |
| `LLM_MODEL` | default `gpt-6-luna`; must be a key of the price table (§8), else startup fails naming the variable and listing the supported model names (names, not the value of the key) |
| `DAILY_LLM_BUDGET_USD` | number ≥ 0, default `0.50` |
| `WORKER_POLL_MS`, `LOG_LEVEL` | unchanged |

**Idle mode.** With no `OPENAI_API_KEY` the worker still starts (so a deploy before Marcus sets the key doesn't crash-loop under Railway's `ALWAYS` restart policy), logs a `warn` **`extraction disabled: OPENAI_API_KEY is not set`** at startup and once a minute, and **claims no jobs** (it still handles `SIGTERM`). Jobs wait in the table; nothing is lost.

`main.ts` does, in order: load config and logger; build `createSql(DATABASE_URL, { max: 4 })`; `waitForSchema` (§2); build the extractor (`OpenAiExtractor`) when there is a key; run the loop until `SIGTERM` or `SIGINT`; `sql.end()`; exit 0. The startup log lists the build info, model, budget and `openai: 'configured' | 'missing'`, never the key and never the config object. Keep the existing `shutdown requested` and `worker stopped` log messages (the SIGTERM test depends on them).

`.railway/railway.ts` (**edit the file only; Marcus applies it**): the `worker` env gains `DATABASE_URL: preserve()`, `OPENAI_API_KEY: preserve()`, `LLM_MODEL: 'gpt-6-luna'` and `DAILY_LLM_BUDGET_USD: '0.50'`, each with a one-line comment, in the file's existing style. `.env.example`: replace the commented `LLM_API_KEY` / `LLM_MODEL` / `DAILY_LLM_BUDGET_USD` lines with real entries under `# --- worker ---` (`OPENAI_API_KEY=` empty, `LLM_MODEL=gpt-6-luna`, `DAILY_LLM_BUDGET_USD=0.50`); leave the `EMBEDDING_*` lines for task 9.

### 2. Waiting for the schema, and the one migration
`waitForSchema({ readVersion, newest, signal, log, sleep? })` in `src/worker/schema-wait.ts`:
- `newest`: the greatest filename prefix in the image's `migrations/` directory, found with `new URL('../../migrations', import.meta.url)` (the same relative path from `src/worker/` under `tsx` and from `dist/worker/` in the image, which copies `migrations/` to `/app/migrations`). Read the directory once at startup. No `.sql` file found: fail startup, don't wait forever.
- `readVersion()`: `SELECT max(version) AS v FROM schema_migrations` (returns `null` on an empty table).
- Ready when `readVersion()` returns a string `>=` `newest` (fixed-width 14-digit versions, plain string compare; a database that is **ahead** of the worker is fine).
- **Not ready, keep waiting:** a smaller version, SQLSTATE `42501` (permission denied: the grant migration hasn't run yet, which is the normal state for a few seconds on the first deploy of this task), `42P01` (no `schema_migrations` yet), and connection errors (`ECONNREFUSED`, `57P03` starting up, `08*` and `53*` classes). Any other error: also keep waiting (never exit), but log it at `error`.
- Backoff 1 s, 2 s, 4 s, … capped at 30 s, **abortable** by the stop signal (it resolves `false` when aborted, and `main.ts` then exits 0 without starting the loop). Log `warn` per attempt with only `{ attempt, have, want, sqlstate }`; after 5 minutes of waiting log at `error` instead (once a minute).
- Returns `true` when ready.

**The migration** `migrations/20261024120000_grant_schema_migrations_select.sql`:
```sql
-- migrate:up
GRANT SELECT ON schema_migrations TO nacre_app;

-- migrate:down
REVOKE SELECT ON schema_migrations FROM nacre_app;
```
Everything that follows from it, in this PR:
- `migrations/README.md`: add the file to the table; replace the "**Task 5, when the worker first uses the database:** at startup the worker waits…" sentence with what was built; add a line that `nacre_app` has `SELECT` on `schema_migrations` **only** for the worker's wait. **Never edit an applied migration** (not `20261023000100_roles.sql` either): the new file is the only change.
- `src/audit/schema-guards.ts`: a new check, **`grants: schema_migrations read-only`**: `nacre_app` has `SELECT` and none of `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `REFERENCES`, `TRIGGER` on it. The existing matrix keeps excluding `schema_migrations`.
- `test/db.test.ts`: the "down migrations" test rolls back **three** times (was two). `test/db-commands.test.ts`: the applied-version lists (three places) gain `'20261024120000'`.
- Verify: `pnpm db:verify` prints the new PASS line, and `pnpm db:rollback && pnpm db:migrate` works on a scratch database.

### 3. Claiming jobs, retries, backoff
Constants in `src/worker/jobs.ts`: `MAX_ATTEMPTS = 5`; backoff after failed attempt `n` = `30 s × 4^(n-1)`, capped at 1 hour (30 s, 2 min, 8 min, 32 min, then failed: about 42 minutes in all); `STALE_LOCK = 10 minutes`; concurrency 1 (one job at a time).

Claim (one statement, `now` passed in so tests control it):
```sql
WITH next AS (
  SELECT job_id FROM jobs
  WHERE kind = 'extract'
    AND ((status = 'queued' AND run_after <= ${now})
      OR (status = 'running' AND locked_at < ${now} - interval '10 minutes'))
  ORDER BY run_after, job_id
  LIMIT 1
  FOR UPDATE SKIP LOCKED)
UPDATE jobs SET status = 'running', locked_at = ${now}, attempts = attempts + 1
FROM next WHERE jobs.job_id = next.job_id
RETURNING jobs.job_id, jobs.ref_id AS event_id, jobs.attempts
```
Only `kind = 'extract'`; never touch other kinds (task 9 adds `embed`). A reclaimed stale job whose `attempts` is now above `MAX_ATTEMPTS` is marked `failed` (`last_error = 'stale_lock'`) without processing, with an `extraction_error` activity entry.

Dispositions (each one SQL statement on `jobs`, guarded by `AND status = 'running'`; `last_error` is **a short code, never message text**):
| Outcome | Effect |
|---|---|
| success or skip | `status 'done'`, `locked_at NULL`, `last_error NULL` (done inside the last transaction of §4, so a crash can't leave an extracted event with a running job and no record) |
| retryable error, `attempts < MAX_ATTEMPTS` | `status 'queued'`, `run_after = now + backoff(attempts)`, `locked_at NULL`, `last_error = code` |
| retryable error, `attempts >= MAX_ATTEMPTS`, or a permanent error | `status 'failed'`, `last_error = code`, and one `extraction_error` activity entry (`actor 'worker'`, `targetKind 'job'`, `targetId` = job id, `eventIds [event]`, `reason` = code, `details { attempts }`) |
| budget exhausted (§8) | `status 'queued'`, `run_after` = the next Chicago midnight, `attempts = attempts - 1` (the wait is not a failure), `last_error 'budget'` |
| auth error from the provider (401, 403) | like budget: `queued`, `run_after = now + 5 minutes`, `attempts - 1`, `last_error 'auth'`; and the loop **pauses claiming for 5 minutes** and logs one `error` (`extractor_auth_failed`), so a bad key doesn't spend every job's retries |
| `SIGTERM` aborted the call | `queued`, `run_after = now`, `attempts - 1`, `last_error NULL` |

A `failed` job stays in the table (visible, and a later task can requeue it); nothing deletes jobs.

`runWorker({ sql, extractor | null, log, now, budgetUsd, pollMs, signal })`: loop until aborted: `runOnce` handles one job and returns its outcome or `null` when nothing is ready; on `null` sleep `pollMs` (abortable); on an unexpected error from `runOnce` (the database went away) log `error` with the SQLSTATE or error name only, and sleep with the §2 backoff. Also export `drain(deps)` (calls `runOnce` until it returns `null`; tests use it).

### 4. Processing one event (`processExtractJob`)
```ts
export interface ProcessDeps { sql: Sql; extractor: Extractor; log: Logger; now: () => Date; budgetUsd: number; signal: AbortSignal }
export interface ClaimedJob { jobId: number; eventId: string; attempts: number }
export type JobOutcome = 'done' | 'skipped' | 'retry' | 'deferred' | 'failed' | 'released';
export async function processExtractJob(deps: ProcessDeps, job: ClaimedJob): Promise<JobOutcome>;
```
It **never throws** for a job-level problem: every failure becomes a disposition from §3 (anything that is not an `ExtractorError` counts as retryable with `last_error = 'internal:' + (SQLSTATE or error name)`, never the message). Order:

1. **Load** `events` joined with `event_content`. No event row: `failed` (`event_not_found`). `body IS NULL` (ciphertext only, slice 8): `failed` (`missing_body`).
2. **Skip rules** (`src/worker/skip.ts`, a pure `skipReason(event, body): string | null`), first match wins:
   1. `sensitivity <> 'normal'` → `sensitivity:private` or `sensitivity:restricted`.
   2. `kind` not in (`message`, `remember`) → `kind:<kind>`. (Ingest only makes `message` today.)
   3. `role = 'assistant'` and `kind <> 'remember'` → `role:assistant`. **`remember` events are extracted whatever their `role`:** task 10 will store them with `role 'assistant'` (an agent made the call), and §6.1 says `remember` is mined.
   4. The body, with every `[REDACTED:<kind>]` marker removed, has no letter or digit (`/[\p{L}\p{N}]/u`) → `empty`.
   A skip writes **one `extraction_runs` row** (`status 'skipped'`, `skip_reason`, `finished_at`, the extractor, model, prompt and config fields filled in as for a real run, `input_event_ids = [event_id]`, tokens and cost null), **one `extraction_run` activity entry** (§10) and marks the job `done`, all in one transaction, and logs one `info` line `{ job_id, event_id, skip }`. It makes **no model call**: the fake extractor's call count is 0 in the tests.
3. **Resume check and cleanup.** Mark any `extraction_runs` row of this event still `running` as `error` (`error 'abandoned'`, `finished_at now`): a previous attempt crashed mid-call. Then count this event's runs with `status 'ok'` **and the same `prompt_hash` and `config_hash`**: `k`. Chunks are processed in order, one transaction each, so the first `k` chunks are already done; skip them and start at chunk `k` (this is what makes a retry after a partial failure add no duplicate claims). If `k` covers every chunk, mark the job `done` and return.
4. **Context** (`src/worker/context.ts`): up to **4** earlier events of the same `session_id` (none when it is null), oldest first, with `kind = 'message'` and `sensitivity = 'normal'`, strictly before the target by `(observed_at, event_id)` (`WHERE session_id = $1 AND (observed_at, event_id) < ($2, $3) ORDER BY observed_at DESC, event_id DESC LIMIT 4`, then reversed). Both roles are included (assistant turns exist for this). Each body is cut to its **first 1,000 code points**, no marker added. **Private and restricted events never appear as context**, because context goes to the hosted model too. Context events are for resolving references only; a claim whose quote exists only in context fails verification (§9) because only the target chunk is searched.
5. **Chunks** (`src/worker/chunk.ts`, pure, `chunkBody(body, max = 8000): { start: number; text: string }[]`): `start` is the code-point offset into the **full body**. A body of at most 8,000 code points is one chunk. Longer: split at paragraph boundaries (a run of two or more `\n`, optionally with spaces or tabs between them), packing whole paragraphs greedily up to 8,000 code points; a single paragraph longer than 8,000 is cut at the last whitespace before the limit, or at 8,000 when there is none. **Never cut inside a surrogate pair.** The chunks are contiguous and **concatenate to exactly the body** (no trimming), which is what lets chunk offsets be added to full-body offsets. The `extraction_runs` row and the model call are **per chunk**, with the same `input_event_ids`: the context event ids oldest first, then the target id.
6. **Per chunk** (from `k`): the budget check (§8, may defer the job); insert a run row `status 'running'` (own transaction, committed before the call); call `extractor.extract(...)`; on return, write the `model_calls` row (its own statement, committed immediately: the money is spent whatever happens next); then one transaction: update the run (`status 'ok'`, `raw_output`, tokens, cost, `model_version`, `finished_at`), verify and write the claims, spans and activity (§10), and for the **last** chunk also mark the job `done`. On an `ExtractorError`: write the `model_calls` row when the error carries usage (a billed schema violation or refusal), update the run to `error` (`error` = the code, `raw_output` = what the error carries, if anything), then apply the §3 disposition and **stop** (later chunks aren't tried; the earlier chunks stay committed and are skipped on retry by step 3).
7. Return the outcome and log one `info` line: `{ job_id, event_id, run_id, outcome, chunks, claims, verified, held, input_tokens, output_tokens, cost_usd, latency_ms, attempts }`.

`ExtractInput` and the prompt (§5, §6) get: the target chunk text, the event's `kind` and `role`, `observed_at` and `observed_tz`, and the context.

### 5. The `Extractor` interface (`src/worker/extractor.ts`)
Provider-agnostic: nothing OpenAI-shaped appears here.
```ts
export interface ExtractInput {
  observedAt: Date;
  observedTz: string | null;
  /** Oldest first, already cut to 1,000 code points each. */
  context: ReadonlyArray<{ role: 'user' | 'assistant'; text: string }>;
  target: { kind: 'message' | 'remember'; role: 'user' | 'assistant'; text: string };
}

/** One claim as the model returns it (spec §5.3), after schema validation, before verification. */
export interface RawClaim {
  text: string; subject: string; attribute: string; value: string;
  value_kind: 'entity' | 'literal';
  assertion_type: 'stated' | 'preference' | 'instruction' | 'plan' | 'decision' | 'hypothesis' | 'quoted_third_party';
  quote: string; time_phrase: string | null; confidence: number; confidence_reason: string;
}

export interface TokenUsage { inputTokens: number; cachedTokens: number; outputTokens: number } // input includes cached; output includes reasoning

export interface ExtractResult {
  claims: RawClaim[];
  /** The model's parsed JSON, stored as `extraction_runs.raw_output`. */
  rawOutput: unknown;
  usage: TokenUsage;
  /** The model string the provider returned (a pinned snapshot), or null. */
  modelVersion: string | null;
}

export interface Extractor {
  readonly id: string;        // extraction_runs.extractor, 'fastpass-v1'
  readonly provider: string;  // model_calls.provider, 'openai'
  readonly model: string;     // the configured model, 'gpt-6-luna'
  readonly promptId: string;  // 'extract-claims'
  readonly promptHash: string; // sha256 hex of the prompt template (§6)
  /** Everything else that changes outputs (model, effort, schema version); hashed with the worker's chunk and context sizes into extraction_runs.config_hash. */
  readonly settings: Readonly<Record<string, string | number | boolean>>;
  extract(input: ExtractInput, opts: { signal: AbortSignal }): Promise<ExtractResult>;
}

export type ExtractorErrorCode =
  | 'timeout' | 'network' | 'rate_limited' | 'http_5xx' | 'http_retryable' | 'api_error' | 'incomplete' | 'schema_violation' // retryable
  | 'auth' | 'http_4xx' | 'refusal'                                                                                     // auth: special (§3); the others permanent
  | 'aborted';

export class ExtractorError extends Error {
  constructor(readonly code: ExtractorErrorCode, readonly retryable: boolean, readonly extra: { status?: number; usage?: TokenUsage; rawOutput?: unknown } = {}) {
    super(code); // the message is the fixed code: never provider text, never content
  }
}
```
`config_hash` = sha256 hex of canonical JSON (keys sorted) of `{ ...extractor.settings, context_events: 4, context_chars: 1000, chunk_chars: 8000, schema_version: 1 }`; `extraction_runs.model` = `extractor.model`; `prompt_hash` and `prompt_id` come from the extractor.

### 6. Prompt `extract-claims` v1 (`src/worker/prompts/extract-claims.v1.ts`)
A **TypeScript module, not a `.md` file** (the image copies only `dist` and `migrations`; a text file would be missing at runtime). Exports `PROMPT_ID = 'extract-claims'`, `PROMPT_VERSION = 1`, `SYSTEM_PROMPT`, `USER_TEMPLATE`, `TARGET_HEADERS`, `OUTPUT_SCHEMA`, `renderUserMessage(input): string` and `PROMPT_HASH`.
- `SYSTEM_PROMPT` is the SYSTEM block of spec §6.3 **copied verbatim from `docs/slice-1-spec.md`** (from "You extract durable memories" through rule 8), lines joined with `\n`, no trailing newline. Don't retype it and don't improve it; v1 is the spec's text. (Prompt injection note: the message text is untrusted user data, but it can only add a claim whose quote really exists in the message, and promotion is gated by task 8.)
- `USER_TEMPLATE` is exactly (placeholders in double braces, filled in **one pass**, so a body containing `{{TARGET}}` is not re-expanded):
  ```
  OBSERVED_AT: {{OBSERVED_AT}}
  CONTEXT (do not extract from this; use only to resolve references):
  {{CONTEXT}}
  {{TARGET_HEADER}}
  <<<
  {{TARGET}}
  >>>
  ```
- `TARGET_HEADERS`: `message` → `TARGET (role=user):` (as in the spec); `remember` → `TARGET (explicit remember request; the user asked for this to be saved):` (it must not say "assistant", or rule "the assistant's suggestions don't qualify" would swallow it).
- `OBSERVED_AT` renders as `YYYY-MM-DDTHH:mm:ss±hh:mm (<zone>)` in `observed_tz` when it is a valid IANA zone, else in UTC as `…+00:00 (UTC)`, using `Intl.DateTimeFormat` parts (`hourCycle: 'h23'`, `timeZoneName: 'longOffset'`). `2026-10-21T19:05:09Z` in `America/Chicago` renders `2026-10-21T14:05:09-05:00 (America/Chicago)`, the spec's example.
- `CONTEXT` renders one line per event, `[user] <text>` or `[assistant] <text>` (text as stored, newlines kept), joined with `\n`; with no context it is the single line `(none)`.
- `OUTPUT_SCHEMA` is spec §5.3 in OpenAI strict form: `{ type: 'object', additionalProperties: false, required: ['claims'], properties: { claims: { type: 'array', items: <claim> } } }`, where `<claim>` has `additionalProperties: false`, **every** property in `required` (strict mode demands it), `time_phrase: { type: ['string', 'null'] }`, `value_kind` enum `entity | literal`, `assertion_type` enum of the seven values in rule 5, `confidence: { type: 'number' }`, and the other fields `string`. (No `minimum` or `maximum` in the JSON schema; the range is checked by zod after the call, §7.)
- `PROMPT_HASH` = sha256 hex of `SYSTEM_PROMPT + '\n---\n' + USER_TEMPLATE + '\n---\n' + canonicalJson(TARGET_HEADERS) + '\n---\n' + canonicalJson(OUTPUT_SCHEMA)`, computed once at module load: **the template, not the inputs** (the `prompt_hash` column comment). The schema has no `prompt_hash` column on `model_calls`; the hash lives on `extraction_runs.prompt_hash`, and `model_calls.ref_id` = the `run_id` links the two.
- **v1 is frozen.** A test asserts the **literal hex** of `PROMPT_HASH`; changing the prompt later means a new `…v2.ts` and a new id/version, never an edit. Compute the value once, paste it in the test, and put it in the PR description.

### 7. The OpenAI adapter (`src/worker/openai.ts`)
`class OpenAiExtractor implements Extractor`, constructor `{ apiKey, model, fetchImpl = fetch, timeoutMs = 60_000 }`. **No SDK and no new dependency**: plain `fetch` (Node 24). `id 'fastpass-v1'`, `provider 'openai'`, `settings { model, reasoning_effort: 'low', response_format: 'json_schema_strict' }`. **Before coding, check the current Responses API reference** (`developers.openai.com/api/docs`) and the `gpt-6-luna` model page; the shapes below are what spec §12.3 and the reference describe, and if the reference differs, follow the reference and say so in the PR.
- Request: `POST https://api.openai.com/v1/responses`, headers `Authorization: Bearer <key>` and `Content-Type: application/json`; body `{ model, input: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: <rendered user message> }], text: { format: { type: 'json_schema', name: 'extract_claims', strict: true, schema: OUTPUT_SCHEMA } }, reasoning: { effort: 'low' }, store: false, max_output_tokens: 8000 }`. **No `temperature`** (reasoning models reject it). `store: false`: OpenAI keeps no copy of the message.
- Timeout: `AbortSignal.any([opts.signal, AbortSignal.timeout(timeoutMs)])`; an abort from `opts.signal` is `aborted`, the timeout is `timeout`. **No retries inside the adapter** (the job's retries are the retry layer).
- Response handling, in this order:
  1. HTTP 401 or 403 → `auth`. 429 → `rate_limited` (retryable). 408, 409 → `http_retryable`. 5xx → `http_5xx`. Any other non-2xx → `http_4xx` (permanent). A failed `fetch` → `network`. Put only the status in `extra.status`; read the error body only for `error.type` / `error.code` and keep either only when it matches `/^[a-z0-9_.-]{1,64}$/` (it may go in a log field, never in `message`).
  2. 200 with `status: 'incomplete'` → `incomplete` (retryable; usage attached). A non-null `error` object → `api_error` (retryable).
  3. An output item of `type: 'message'` whose content has a `refusal` part → `refusal` (permanent; usage attached). Otherwise take the `output_text` part; none → `schema_violation`.
  4. `JSON.parse` the text; failure → `schema_violation` with `rawOutput` = the text string. Validate with a zod 4 schema: `claims` is an array; `text`, `subject`, `attribute`, `value`, `quote` are non-empty strings; `value_kind` and `assertion_type` are the enums; `time_phrase` is a string or null (an empty string becomes null); `confidence` is a number in [0, 1]; `confidence_reason` a string. Any violation → `schema_violation` (retryable; usage and `rawOutput` attached): one bad claim fails the chunk, because under strict structured output it should not happen and a retry is cheap.
  5. Normalize `attribute` in code: lowercase, runs of non-alphanumerics become `_`, leading and trailing `_` trimmed. An attribute that is empty afterwards fails the whole output as `schema_violation` too.
- Usage: `input_tokens`, `input_tokens_details.cached_tokens` (0 if absent), `output_tokens` (reasoning included). `modelVersion` = the response's `model` string. Cost is **not** computed here; the pipeline does it (§8).
- The key appears only in the `Authorization` header. It is never put in an error, a log field or `settings`. A test asserts that no `ExtractorError`, message or `extra` contains the key.

### 8. Cost, the price table and the guard
`src/shared/pricing.ts`: `MODEL_PRICES` in USD per 1 M tokens, `{ input, cachedInput, output }`: `gpt-6-luna` 0.10 / 0.01 / 0.50, `gpt-5.6-luna` 0.20 / 0.02 / 1.20 (spec §12.3, OpenAI pricing, Standard tier). `costUsd(model, usage): number` = `((input − cached) × input + cached × cachedInput + output × output) / 1e6`, rounded to 6 decimals (`numeric(10,6)`); an unknown model throws. The price is looked up by the **configured** model (the alias), not the returned snapshot string; `model_calls.model` stores the returned string (falling back to the configured one when the provider returned none). Checks: 2,500 input / 300 output tokens on `gpt-6-luna` is `0.000400` (spec §12.3); 2,500 input with 1,200 cached and 300 output is `0.000292`.

`src/worker/budget.ts`: `budgetState(sql, now, budgetUsd)` returns `{ day, spentUsd, exhausted, nextStart }`, computed in SQL so DST is Postgres's problem, not yours:
```sql
SELECT to_char(d.start AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD') AS day,
       d.start AS day_start, d.next AS next_start,
       coalesce((SELECT sum(cost_usd) FROM model_calls WHERE at >= d.start AND at < d.next), 0) AS spent
FROM (SELECT date_trunc('day', ${now}::timestamptz AT TIME ZONE 'America/Chicago') AT TIME ZONE 'America/Chicago' AS start,
             (date_trunc('day', ${now}::timestamptz AT TIME ZONE 'America/Chicago') + interval '1 day') AT TIME ZONE 'America/Chicago' AS next) d
```
(adjust the syntax as needed; compare `spent >= budget` in SQL as numeric, not in floats). It sums **all** `model_calls`, whatever the purpose (embeddings count too, §12.2). `exhausted` is `spent >= budgetUsd`.
- **Checked before every model call** (every chunk). Exhausted: in one transaction, insert a run row `status 'skipped'`, `skip_reason 'budget'` for this event (`input_event_ids = [event_id]`, `finished_at`), write the `extraction_run` activity entry, **and** write one `system` activity entry per Chicago day (`actor 'worker'`, `details { step: 'budget_stop', day, spent_usd, budget_usd }`; skip it when an entry with the same `step` and `day` already exists); set the job as in the §3 budget row; log one `warn` `{ job_id, event_id, day, spent_usd, budget_usd }`; return `deferred`. A budget stop applies only to a job that needs a model call: the skip rules of §4 run first, so assistant and private events are still logged `skipped` while the budget is exhausted.
- The guard is a **ceiling checked before the call, not a reservation**: with concurrency 1 the overshoot is at most one call (about $0.0004, up to $0.002 for a long body). Say so in a code comment and in the PR.
- Time is injected (`now: () => Date`), never read from the clock inside `budgetState`; tests pass fixed instants.

### 9. The quote verifier: the contract with task 6 (build against exactly this)
Task 6 builds `src/shared/quote.ts` **in parallel**. The simplest dependable way to build against a file that doesn't exist yet is a **fixed interface plus one switch point**:
- **Task 6 exports, from `src/shared/quote.ts`, exactly this** (names and signatures are final; neither task may change them, and either must say so at the top of its PR if it believes it must):
  ```ts
  export type QuoteFailureReason = 'quote_length' | 'ellipsis' | 'quote_not_found';

  export type QuoteVerification =
    | {
        ok: true;
        /** First match, in Unicode code points into `body`: [start, end). */
        start: number;
        end: number;
        matchKind: 'exact' | 'normalized';
        /** How many matches in all (>= 1). */
        occurrences: number;
        /** The body's own text at [start, end), never the model's string. */
        quote: string;
      }
    | { ok: false; reason: QuoteFailureReason };

  /** Spec §6.5. `body` is the stored NFC body of the TARGET event only. Pure and never throws. */
  export function verifyQuote(body: string, quote: string): QuoteVerification;

  /** Spec §6.5, `checks.value_in_quote`: a soft signal, never a gate. Pure and never throws. */
  export function valueInQuote(storedQuote: string, value: string): boolean;
  ```
  Argument order is `(body, quote)`. It never throws. When `ok` is true, `Array.from(body).slice(start, end).join('') === quote` and `end > start`, which is exactly what Postgres `substring(body FROM start + 1 FOR end - start)` returns.
- **This task imports it only through `src/worker/quote.ts`:**
  ```ts
  // The single place the worker gets the verifier from. While task 6 isn't on main this re-exports the
  // temporary exact-only stub; when src/shared/quote.ts exists, change this one line to
  //   export * from '../shared/quote.js';
  // and delete quote-stub.ts.
  export * from './quote-stub.js';
  ```
- **`src/worker/quote-stub.ts` (temporary, delete when wired):** exports the same types and functions with the same signatures, **exact matching only**: the length gate (8 to 400 code points and at least 2 words by `split(/\s+/)`), the ellipsis gate (`...` or `…` in the quote), then `indexOf` on the body in code points (convert UTF-16 indices to code-point indices correctly), `matchKind 'exact'`, `occurrences` counting non-overlapping hits (overlap semantics are task 6's), `quote` = the body's substring. It does **no** NFC folding and **no** normalization; don't add any (that is task 6's job, and a better stub would hide a broken wiring). The pipeline's tests that run before wiring use only exact-match quotes and a quote that is nowhere in the body.
- **Whoever merges second does the wiring.** If task 6 is already on `main` when you finish this task (check `src/shared/quote.ts` after rebasing): switch `src/worker/quote.ts` to the re-export above, delete `quote-stub.ts`, run the whole suite, and **add `test/a4.test.ts`** (the A4 box in §13). If task 6 is **not** on `main`: don't add `test/a4.test.ts` (it needs normalization, which the stub doesn't do); say in the PR that wiring and A4 are task 6's. Either way, note in the PR which case applied.
- The pipeline calls `verifyQuote(chunk.text, claim.quote)` per claim, **with the chunk's text** (not the full body, not the context), adds `chunk.start` to `start` and `end`, and calls `valueInQuote(result.quote, claim.value)` only when `ok`. Unit-test the pipeline's use of it with the stub-compatible cases only.
- Task 6 owns `test/helpers/prng.ts`. This task's property tests (the chunker, §13) use their own small seeded generator inside the test file; **don't create `test/helpers/prng.ts`** (it would conflict), and don't import it.

### 10. What gets written
All ids come from `newId` (`run`, `clm`, `spn`, `mcl`, `act`); the clock is the injected `now` for budget decisions and the database's `now()` for row timestamps.
- **`extraction_runs`**, one per chunk or skip: `run_id`, `event_id`, `extractor`, `model`, `model_version` (the returned string), `prompt_id`, `prompt_hash`, `config_hash`, `input_event_ids`, `raw_output` (the model's parsed JSON; for a schema violation, the raw text as a JSON string), `status`, `skip_reason`, `error` (a code), `input_tokens`, `output_tokens`, `cost_usd`, `started_at`, `finished_at`.
- **`model_calls`**, one per paid call, written right after the call returns: `purpose 'extract'`, `provider 'openai'`, `model` (returned string), `ref_id` = the run id, the three token counts, `cost_usd` from §8, `latency_ms`. A call that fails before returning (timeout, network, HTTP error) is **not billed** and writes no row; a billed failure (schema violation, refusal, incomplete) does.
- **`claims`**, one per `RawClaim`: `claim_id`, `event_id`, `extraction_run_id`, `text`, `subject_text` = `subject`, `attribute` (normalized), `value`, `value_kind`, `assertion_type`, `time_phrase` (verbatim, no date computed: that is task 7; leave `valid_from`, `valid_to` null and the column defaults for `valid_precision` and `time_source`), `confidence`, `confidence_reason`, `scope_id` and `sensitivity` copied from the event, `checks`, `status`, `status_reason`. Leave a one-line comment where task 7 will plug in time grounding; **don't build a seam for it**.
  - Quote verified (`ok`): `status 'candidate'`, `status_reason` null, `checks {"quote": "exact" | "normalized", "value_in_quote": true | false}`, plus one `evidence_spans` row: `span_start = chunk.start + start`, `span_end = chunk.start + end`, `quote` (the verifier's, the body's own text), `match_kind`, `occurrences`.
  - Quote failed: `status 'held'`, `status_reason` = the verifier's reason (`quote_length`, `ellipsis` or `quote_not_found`), `checks {"quote": "failed"}`, **no** `evidence_spans` row, and one **`extraction_error`** activity entry: `actor 'worker'`, `targetKind 'claim'`, `targetId` = the claim id, `eventIds [event]`, `claimIds [claim]`, `reason` = the reason, `details { run_id }`. **No quote text, no claim text** in the entry.
  - `tainted` events: not handled here. A tainted event's claims are held by promotion rule 4 in task 8; ingest never sets `tainted` today. Leave a comment.
- **Fidelity assertion in the same transaction:** after inserting a span, `SELECT substring(body FROM span_start + 1 FOR span_end - span_start) = quote FROM event_content WHERE event_id = …`; a mismatch throws (the transaction rolls back, the job takes the `internal` retry path, and the log line carries `{ job_id, event_id, code: 'span_mismatch' }`). It should never fire; it guards the invariant A5 and §13.1 audit.
- **`extraction_run` activity entry**, one per run or skip: `actor 'worker'`, `targetKind 'run'`, `targetId` = the run id, `eventIds [event]`, `details { status, skip_reason?, chunk, chunks, claims, verified, held, input_tokens, output_tokens, cost_usd, latency_ms }`.
- Leave the claims `candidate`. **Nothing here inserts `beliefs`, `belief_versions` or `claim_promoted`/`claim_held` entries.** Task 8 will run promotion over `candidate` claims, including ones written before it existed: leave a comment saying so.

### 11. Logging rules (a test enforces them)
pino, JSON, the existing `createLogger`. Allowed fields: `job_id`, `event_id`, `run_id`, `claim_id`, `outcome`, `skip`, `chunk`, `chunks`, counts, token counts, `cost_usd`, `latency_ms`, `attempts`, `day`, `spent_usd`, `budget_usd`, HTTP status, and error **codes** (`ExtractorErrorCode`, SQLSTATE, constraint name, `error.name`). **Never:** a body, a context text, a quote, a claim's text, subject or value, `raw_output`, a provider error message or body, an `Error.message` from the HTTP or JSON layer, the API key, a header, the config object, an environment variable's value. `last_error` and `extraction_runs.error` follow the same rule (codes only). The cost of one chunk, the job outcome and the budget stop are `info` or `warn`; a failed attempt is `warn`; a job reaching `failed` is `error`.

### 12. The manual live check (`src/worker/smoke.ts`, `pnpm extract:smoke`)
A script Marcus runs himself; **CI never runs it.** It reads `OPENAI_API_KEY` and `LLM_MODEL` from the environment (exit 2 with a clear message when the key is unset), builds the real `OpenAiExtractor`, and extracts one **built-in synthetic** message (`'For the record, my preferred package manager is pnpm. Can you update the README?'`, role user, no context). It prints: the model string the provider returned, the token counts, the cost, and per claim: attribute, value, assertion type, and the verifier's result (`exact`, `normalized` or the failure reason), then a PASS/FAIL line (PASS when at least one claim came back and every returned quote verified). It touches no database. It never prints the key or the request headers. Export a pure `runSmoke(extractor, print)` and unit-test it with the fake extractor; the `main` part is a few lines. Add `"extract:smoke": "tsx --env-file-if-exists=.env src/worker/smoke.ts"` to `package.json`. It compiles into `dist/worker/smoke.js`, so Marcus can also run it **inside the worker container, where the key already is**: `railway ssh --service worker -- node dist/worker/smoke.js`. One call costs about $0.0004.

### 13. Tests
No network, no real key, no model, anywhere. Database tests run against the scratch database as `nacre_app` and skip without `TEST_DATABASE_URL`, like the others. Add `test/helpers/worker.ts`: `FakeExtractor` (constructed with a function `(input: ExtractInput) => RawClaim[] | Promise<RawClaim[]> | ExtractorError`, counts and records calls, returns fixed usage such as 2,500 / 0 / 300 tokens and a `modelVersion` like `'fake-model-2026-10-01'`), `seedEvents(app, token, [...])` (events through `ingestEvent`, so they are stored exactly as ingest stores them, jobs included), `makeDeps(...)` and a log-capturing logger (as `startTestApp` does).

Unit, no database:
- **Prompt:** `PROMPT_HASH` equals the pinned hex; `SYSTEM_PROMPT` equals the spec's block (read `docs/slice-1-spec.md` and compare, so a drifting copy fails); `renderUserMessage` reproduces the spec's USER example byte for byte for the spec's inputs; a body containing `{{TARGET}}` and `>>>` is inserted unchanged; `remember` uses its header; the OBSERVED_AT rows from §6; no-context renders `(none)`; the schema is strict-valid (every property required, `additionalProperties false` at every object).
- **Chunking:** table cases (8,000 exactly is one chunk; 8,001 splits; paragraph packing; a single 20,000-code-point paragraph with spaces and without; astral characters at the cut), plus seeded properties (2,000 cases, a small `mulberry32` inside the file): chunks concatenate to the body, every chunk is at most 8,000 code points, `start` offsets equal the running code-point sum, no lone surrogate at an edge, deterministic. A 100,000-code-point adversarial body chunks in under 250 ms.
- **Skip rules:** the full table (assistant message; assistant `remember`; user `remember`; private; restricted; assistant and private together gives the sensitivity reason; `tool_result` kind; a body that is only `[REDACTED:api_key]` and whitespace; a body with real text plus a marker is not empty).
- **Backoff and dispositions:** the backoff table; each §3 outcome row.
- **Pricing and day bounds:** the two worked costs; an unknown model throws. Day bounds (database): `now = 2026-10-24T03:00:00Z` (Oct 23, 10 PM CDT) gives day `2026-10-23`, next start `2026-10-24T05:00:00Z`; `now = 2026-11-01T12:00:00Z` gives day `2026-11-01`, start `2026-11-01T05:00:00Z`, next `2026-11-02T06:00:00Z` (a 25-hour day: the clocks go back); a `model_calls` row at `2026-11-02T05:30:00Z` counts in Nov 1.
- **Adapter, fixture-driven** (`test/fixtures/openai/*.json`, with a `README.md` saying they are **hand-written in the documented Responses shape on Oct 24, 2026**, not captured from a live call, and that Marcus can replace one with a real capture later; the injected `fetchImpl` returns them): ok with two claims, ok with none, cached tokens, refusal, incomplete, malformed JSON text, schema violation (a confidence of 1.5; an empty quote; an attribute that normalizes to empty), HTTP 400, 401, 403, 408, 409, 429, 500 and a thrown fetch error. Assert the request (URL, `Authorization` header present, body has the model, `store: false`, `strict: true`, `reasoning.effort 'low'`, the schema, **no `temperature`**), each code and `retryable` flag in the error table, attribute normalization, and that **no error's message or `extra` contains the key or any fixture text**.
- **Config:** `DATABASE_URL` required; `OPENAI_API_KEY` optional; unsupported `LLM_MODEL` fails naming the variable; the budget parses; empty string counts as unset.
- **Schema wait:** with an injected `readVersion` and `sleep`: ready at once; a smaller version then a larger one; `42501`, `42P01` and a connection error each keep waiting; abort resolves `false`; a database ahead of the worker is ready.
- **Smoke:** `runSmoke` with the fake extractor prints PASS and FAIL cases, and its output never contains the key.

Database, as `nacre_app`:
- **Claiming:** two concurrent claims get two different jobs (and with one job, the second gets none: `SKIP LOCKED`); `run_after` in the future is not claimed; a `running` job locked 11 minutes ago is reclaimed and one locked 9 minutes ago is not; `embed` jobs are never touched; attempts increment; a stale job above `MAX_ATTEMPTS` is failed with an activity entry.
- **Pipeline happy path:** one user message, fake returns two claims with real quotes: one `ok` run with the right `prompt_hash`, a 64-hex `config_hash`, `extractor 'fastpass-v1'`, the model and returned `model_version`; one `model_calls` row (`ref_id` = the run id, `cost_usd` = §8's number, `purpose 'extract'`); two `candidate` claims with `scope_id` and `sensitivity` from the event; two spans whose `quote` equals the SQL `substring` at their offsets; one `extraction_run` entry; the job `done`.
- **Skips:** assistant message, private, restricted, empty: one `skipped` run each with the right `skip_reason`, one activity entry, the job `done`, **fake call count 0**, no `model_calls` row.
- **Held:** a quote that is nowhere in the body, a 3-character quote, and a quote containing `...` give `held` claims with `quote_not_found`, `quote_length`, `ellipsis`, no spans, one `extraction_error` entry each (claim id and reason, **no quote text**), and `checks {"quote": "failed"}`; the raw output is still on the run.
- **Context:** the fake sees up to four earlier same-session events oldest first, 1,000-code-point cuts, no private or restricted event, none from another session; a quote that exists only in context is held `quote_not_found`.
- **Chunks and resume:** a body of three chunks, the fake failing on chunk 2 with a retryable error the first time: after the first attempt the job is `queued` with the §3 backoff, chunk 1's claims exist, no duplicates after `drain` finishes the job, the fake was called 1 + 2 times in total, span offsets are relative to the **full body** (assert with SQL `substring`), and a `running` run left by a simulated crash is marked `error 'abandoned'`.
- **Dispositions:** retryable error → `queued`, `last_error` the code, `run_after` per the table; fifth failure → `failed` + `extraction_error` entry; permanent error → `failed` at once; auth error → `queued` +5 minutes with `attempts` unchanged and the loop paused; abort → released without consuming an attempt; a billed schema violation writes a `model_calls` row and an `error` run holding the raw text.
- **Budget:** with `model_calls` rows summing above the budget for the Chicago day: the job is deferred to the next Chicago midnight, `attempts` unchanged, a `skipped` run with `skip_reason 'budget'`, the fake called 0 times, **one** `system` `budget_stop` entry for two deferred jobs, and an assistant message in the same state is still logged `role:assistant`; with `now` moved past that midnight the same job runs. Spend exactly at the limit counts as exhausted. Spend from yesterday (Chicago) does not count. Embedding-purpose rows count.
- **Logs and secrets:** run success, skip, held, retry, failed and budget paths with bodies containing a sentinel string (built at runtime); assert **no log line, `jobs.last_error`, `extraction_runs.error` or activity row contains the sentinel**, the quote, or the claim text (activity rows excepted only where §10 stores ids and codes), and that no log line contains the fake API key given to the adapter.
- **Process test, rewrite `test/worker.test.ts`:** spawn `src/worker/main.ts` with `DATABASE_URL` set to the scratch database as `nacre_app`, no `OPENAI_API_KEY`: it logs `worker started` and the `extraction disabled` warning, claims **nothing** (a queued job stays `queued`), and exits 0 on `SIGTERM` with `shutdown requested` and `worker stopped`. A second case with `DATABASE_URL` pointing at a closed port (`127.0.0.1:1`): it logs that it is waiting for the schema, doesn't exit by itself, and **exits 0 within 5 seconds of `SIGTERM`** (the wait is abortable).
- **Schema wait against the real database:** `readVersion` as `nacre_app` on a migrated scratch database returns the newest version (this fails without the grant).

*`test/a4.test.ts` (spec §14 A4, the same text is in task 6's brief; add it only in the case §9 says).* Against the scratch database as `nacre_app`, with the real worker pipeline (`processExtractJob`, task 5) and a **fake `Extractor`** (no network). Seed one agent and three user events in one session through `ingestEvent`: **C** (context) `'My sister Dana works at Acme Corp as a data engineer.'`, **T1** (target) `'For the record, my preferred package manager is pnpm. Can you update the README?'`, **T2** `'She said “use  pnpm” and I agree with her completely.'`. The fake returns, for T1: claim 1 with quote `'my preferred package manager is pnpm'`; claim 2 with quote `'works at Acme Corp as a data engineer'` (only in C); claim 3 with quote `'my favourite package manager is pnpm'` (not anywhere). For T2: claim 4 with quote `'"use pnpm" and I agree'`. Assert:
- claim 1: one `evidence_spans` row, `match_kind 'exact'`, offsets 16 and 52, and `quote` equals `substring(body FROM 17 FOR 36)`; its `checks` is `{"quote":"exact","value_in_quote":true}`; status `candidate` (promotion is task 8's);
- claims 2 and 3: `status 'held'`, `status_reason 'quote_not_found'`, **no** `evidence_spans` row, and one `extraction_error` activity entry for each (with the claim id and the reason, no quote text);
- claim 4: `match_kind 'normalized'`, the stored `quote` is `'“use  pnpm” and I agree'` and equals the SQL substring at the stored offsets;
- the `beliefs` table has no row; no `claim_promoted` entry exists; every claim's `evidence_spans.quote` that exists equals the SQL substring.

### 14. Docs, and Marcus's steps
- Root `README.md`: the **Status** paragraph says what exists now (the worker claims `extract` jobs, skips assistant and private events, extracts claims with `gpt-6-luna`, verifies quotes, writes `candidate` or `held` claims with evidence, keeps to $0.50/day; nothing promotes them yet) and drops "the worker is still a placeholder". Add a **"Steps for task 5 (Marcus)"** section after "Steps for task 4", in the style of the earlier ones, with exactly these steps (concrete, in this order):
  1. **Before merging:** in Railway's dashboard, on the `worker` service, set `DATABASE_URL` as the reference `${{api.DATABASE_URL}}` (the `nacre_app` URL the `api` already uses) and `OPENAI_API_KEY` to your OpenAI key. **You** type the key; don't paste it into chat, a PR, an issue or a file. Optionally set a monthly spend limit on that key in OpenAI's dashboard.
  2. `railway config plan`, read it, then `railway config apply` (the file now declares the four worker variables; `preserve()` keeps the two secrets you set).
  3. Merge. `api`'s pre-deploy applies the one grant migration; the worker waits for it, then starts. Check the worker log for `worker started`, then no `waiting for schema` lines.
  4. **Live check:** `railway ssh --service worker -- node dist/worker/smoke.js` (about $0.0004): expect PASS and the model string `gpt-6-luna…`. Then post one real event to `/v1/events` as in "Steps for task 4" and, within a few seconds, run the SQL below with `railway connect nacredb`.
  5. The SQL (one query each: the run, the claims with status, the evidence, today's spend): give them in the README, reading `extraction_runs`, `claims` joined to `evidence_spans`, and `sum(cost_usd)` from `model_calls` for today.
  6. If the key is wrong or missing: the worker logs `extractor_auth_failed` or `extraction disabled`; jobs wait and nothing is lost. If the budget is hit: `budget_stop` appears in `activity_log` and jobs resume after midnight Chicago.
- `docs/tasks/README.md`: row 05 becomes **"In progress (PR #NN)"** (add this brief file to `docs/tasks/` if it isn't there yet), as a separate `docs:` commit.
- Leave `docs/slice-1-spec.md` alone. In the PR, add a **"Spec updates to apply"** list for whatever the build adds that v0.2.18 doesn't say (what this brief decided, listed under "Decided in this brief" above, is already in v0.2.18).

## Out of scope
- Promotion, the future-tense guard and beliefs (task 8); time grounding and resolving `time_phrase` (task 7); embeddings and the `embed` job (task 9); `remember` itself (task 10); entity resolution; the quote verifier's logic (task 6); the nightly self-audit (task 14).
- A new dependency (no OpenAI SDK, no retry or queue library), a new table, column, index or grant beyond the one in §2, a second migration.
- An Anthropic adapter, a local extractor for private content, mining assistant turns, a batch API, prompt caching tuning, streaming.
- Running or touching Railway (Marcus applies `.railway/railway.ts`), real model calls in tests or CI, committing any key or key-shaped string.
- Editing `docs/slice-1-spec.md`.

## Done when (list each check and its result in the PR description)
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test` (with `TEST_DATABASE_URL`) and `pnpm build` pass locally and in CI; paste the test count. **No test makes a network call** (the adapter tests use the injected `fetch`).
- [ ] **Migration:** exactly one new file, `migrations/20261024120000_grant_schema_migrations_select.sql`; `git diff main --stat -- migrations` shows it plus the `README.md` edit; `pnpm db:verify` shows the new `grants: schema_migrations read-only` PASS line; `pnpm db:rollback && pnpm db:migrate` works on a scratch database; the down-migration and `db-commands` tests are updated and pass.
- [ ] **Schema wait:** on the real scratch database `nacre_app` can read `schema_migrations`; the worker waits (no crash, abortable) against an unmigrated or unreachable database; the process tests pass.
- [ ] **Claiming:** `FOR UPDATE SKIP LOCKED` is in the claim statement; the concurrency, stale-lock, `run_after` and `embed`-untouched tests pass.
- [ ] **Skips (§6.1):** assistant, private, restricted and empty events produce `skipped` runs with the right reasons, no model call, no `model_calls` row.
- [ ] **Pipeline:** the happy-path, held, context, chunk-and-resume and disposition tests pass; span offsets equal Postgres `substring` for every span written; no duplicate claims after a partial failure.
- [ ] **Prompt:** `PROMPT_HASH` is pinned by a test, equals the spec's SYSTEM block, and every run's `prompt_hash` equals it; the hash is in the PR description.
- [ ] **Adapter:** the fixture tests pass, including the request shape (strict schema, `reasoning.effort low`, `store false`, no temperature) and the error table; no SDK dependency was added (`git diff main -- package.json` shows only the `extract:smoke` script).
- [ ] **Cost guard:** the budget tests pass, including DST, exact-limit, yesterday's spend, embedding rows and one `budget_stop` entry per day; the worked costs `0.000400` and `0.000292` pass.
- [ ] **No content, no secrets in logs:** the sentinel test passes on every path; `grep -rn "sk-" src test` finds no key-shaped literal.
- [ ] **Contract with task 6:** `src/worker/quote.ts` is the only importer of the verifier; the stub exports exactly the §9 types and signatures; the PR says whether task 6 was on `main` and, if so, that `src/worker/quote.ts` re-exports `../shared/quote.js`, the stub is deleted and `test/a4.test.ts` passes, or, if not, that wiring and A4 are task 6's.
- [ ] **Config and Railway:** `.env.example` and `.railway/railway.ts` updated as in §1; **Railway was not touched**; the README steps exist and match.
- [ ] **Live check (Marcus, after merge):** the steps in the README. State in the PR that **this part is manual and not done by the agent**; CI proves everything else without a key.
- [ ] PR from `task-05-worker-and-extractor` to `main`, titled **"Task 5: Worker loop, Extractor and the OpenAI adapter"**, with deviations, **Spec updates to apply**, and open questions per `docs/tasks/README.md`. Don't merge.

## Decided by Marcus (Oct 24, 2026)
1. **How does the worker "wait for the schema" when `nacre_app` can't read `schema_migrations`?** The roles migration left that table out on purpose, but your rule in `migrations/README.md` needs the worker to read it. *Decided (built): one migration, `GRANT SELECT ON schema_migrations TO nacre_app`:* read-only, one table, the worker compares `max(version)` with the newest migration in its image, and a guard check keeps the grant read-only. The alternative needs no grant: the worker polls the catalog (for example, that the last tables and columns it uses exist), which is weaker (it can pass between two migrations) and has to be updated with every migration, so I don't recommend it.
2. **Retry numbers.** The spec says only "jobs table, `SKIP LOCKED`". *Decided (built): 5 attempts, backoff 30 s × 4^(n−1) capped at 1 hour (30 s, 2 min, 8 min, 32 min, then `failed`), stale lock 10 minutes, one job at a time.* A rate-limit or outage lasting under about 40 minutes self-heals; a longer one leaves `failed` jobs you can see. The alternative is more attempts with a longer cap, at the price of events sitting unextracted for hours before anyone sees a failure.
3. **No `OPENAI_API_KEY`: idle or crash?** *Decided (built): idle, with a warning each minute and no claiming*, so merging before the key is set doesn't crash-loop the worker and no job is lost. The alternative is exiting at startup, which makes a missing key obvious in Railway's status but restarts forever.

## Conventions
Conventional Commits, small and readable. The docs change is its own commit. One task per PR. TypeScript strict, biome-clean, hand-written SQL, zod 4 for external data. No secrets in the repo, ever, and no secret-shaped literals in tests (build fake keys at runtime, as `test/helpers/events.ts` does). No content in logs (§11). Time is injected, never read inside logic that tests need to fix. Don't merge.
