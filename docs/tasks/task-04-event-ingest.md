# Task 4: Event ingest (`POST /v1/events`)

*Brief v1.1, Oct 24, 2026 (v1.1: `future` has a 60-second tolerance, to match spec v0.2.16; v1 implemented it literally). Written after task 3c merged (PR #27, merge `935d12c`). Paste this whole file into Claude Code or Codex, run from an up-to-date clone of `github.com/marcusschimizzi/nacre` (`main` at or after `935d12c`, the task 3c merge). Marcus reviews the PR.*

## Context
Tasks 3, 3b and 3c gave the `api` its auth: one verifier for static and OAuth tokens, `tokenAuth({ route: 'v1' })` (static tokens only; an OAuth access token gets 401 on `/v1/*`), an exact-match `Origin` check, the activity-log helper, an in-memory `SlidingWindowLimiter`, and a request log that never writes bodies. There is no `/v1/*` route yet. This task builds the **write path's front door**: the first real endpoint, `POST /v1/events` (spec §5.1, §6.2, §7.4). The Claude Code hooks (task 11) and `remember` (task 10) will both call the same ingest code, so build it as a reusable function with a thin HTTP route on top.

What one call does (spec §3, step 1): check the token, validate and normalize the event, **strip pasted secrets**, hash the redacted body, and in **one transaction** write the `events` row, the `event_content` row, an `event_append` activity entry and an `extract` job. A repeated `client_event_id` returns the original event instead of a second one.

**Decided, already in the spec (don't reopen):**
- Secrets are stripped from the stored body before hashing and storing (§6.2, §17 Q2): `[REDACTED:<kind>]`, with `[{kind,count}]` in `events.redactions`.
- Everything lands in the `personal` scope (§17 Q3). `scope_hint` is stored, not acted on.
- Assistant turns are stored but not mined (§17 Q4, §6.1). **The `extract` job is still enqueued for every event**, assistant and `private`/`restricted` included: §6.1 says the worker logs those runs as `skipped` (`role:assistant`, `sensitivity:private`), so it needs the job to find them. This task writes no skip logic. `role` and `trust_tier` are what mark an assistant turn; there is no extra column.
- `content_hash` is `sha256` over the **redacted, NFC** body (`hash_alg = 'sha256'`).

**This task adds no migration and no Railway variable.** The schema already has `events`, `event_content`, `jobs` (`UNIQUE (kind, ref_id)`) and `activity_log`, and `nacre_app` already has `INSERT` on all four plus `USAGE` on `jobs_job_id_seq`. The idempotency key is the existing `UNIQUE (agent_id, client_event_id)`. If you think a migration or a variable is needed, stop and say why in the PR. Verify with `git diff main --stat -- migrations` (empty) and by running the whole suite as `nacre_app`, as it already does.

**Read first:** `docs/slice-1-spec.md` §3, §4 (`events`, `event_content`, `jobs`, `activity_log`), §5.1, §6.1, §6.2, §7.4, §13.1, §13.2, §14 A6 and A16, §16 R4 and R5a; `docs/tasks/task-03-tokens-auth-and-origin.md` and `task-03c-oauth-followups.md` (style, and what the auth layer already does); `src/api/app.ts`, `src/api/auth.ts`, `src/api/env.ts`, `src/api/origin.ts`, `src/api/rate-limit.ts`, `src/api/oauth/routes.tsx` (its `bodyLimit` and 429 handling are the pattern to follow); `src/shared/activity.ts` (`logActivity` takes a transaction and refuses token-shaped values), `src/shared/ids.ts` (`newId('evt')`), `src/shared/db/sql.ts`; `test/helpers/app.ts` (`startTestApp`, `staticToken`, `oauthToken`, `testAgent`), `test/a11.test.ts` (the pattern for HTTP tests against the real api as `nacre_app`), `test/oauth-unit.test.ts` (a pure unit-test file).

## What to do

Suggested layout (rename if you have a reason, and say so in the PR):
- `src/shared/redact.ts`: the pure redactor.
- `src/shared/events.ts`: limits, the zod schema, `clockFlags()`, `contentHash()` and `ingestEvent()`.
- `src/api/v1/events.ts`: the Hono route; `src/api/app.ts` mounts it.
- Tests: `test/redact.test.ts` and `test/events-unit.test.ts` (no database), `test/events.test.ts` (HTTP, against the scratch database as `nacre_app`), `test/events-rollback.test.ts` (see §8), plus a small `test/helpers/events.ts` (`validEvent(overrides)`, `postEvent(app, token, body)`).

### 1. Wiring and request order
In `createApp`, for `/v1/*`: `originCheck(config.allowedOrigins)`, then `tokenAuth({ ..., route: 'v1', log })` (no `resourceMetadataUrl`; `/v1` keeps the plain challenge), then the routes. For `POST /v1/events`, in this order:
1. Origin check → `403 {error:'forbidden'}`. Hook scripts send no `Origin`, so they pass; a browser from a foreign origin doesn't (spec §11 doesn't mention `/v1`, so this is a defense-in-depth choice; flag it in the PR).
2. Token → `401` (existing behavior; don't change `auth.ts`).
3. The token's `rights` must include `write`, else `403 {error:'forbidden'}`. Scopes and `label_ceiling` are **not** checked (later slices). Request log `ingest: 'rejected:no_write_right'`; no activity row.
4. Rate limit (§7).
5. Body-size cap (§6), then JSON parse, then validation (§2), then the size caps on content and metadata (§6), then redaction and ingest (§3 to §5).

`/v1/events` accepts `POST` only. Mount the routes on a sub-app (`app.route('/v1', …)`) so the error handler in §9 covers `/v1` and nothing else.

### 2. Request validation (zod, strict)
Body must be `application/json` (`/^application\/json\b/i`, a charset is fine) and parse as a JSON object, else `400 {error:'invalid_json'}`. Then validate with a **strict** zod object. Unknown top-level keys are rejected: this is what stops a client sending `agent_id`, `token_id`, `scope_id`, `trust_tier`, `tainted` or `explicit_remember` and having them silently ignored.

| Field | Rule |
|---|---|
| `client_event_id` | required; printable ASCII with no spaces, `^[\x21-\x7E]{1,200}$` |
| `kind` | required; only `"message"` in slice 1 (`remember` is built internally by task 10) |
| `role` | required; `"user"` or `"assistant"` |
| `session_id` | optional or null; same pattern as `client_event_id` |
| `observed_at` | required; ISO 8601 with a `Z` or numeric offset (zod 4: `z.iso.datetime({ offset: true })`). It must accept exactly what the spec §8.3 hook sends, `2026-10-21T14:05:09-05:00`. Stored as `timestamptz` |
| `observed_tz` | optional or null, ≤ 64 chars. **Lenient on purpose:** `""` or anything `new Intl.DateTimeFormat('en', { timeZone })` rejects is stored as `NULL`, not a 422, because the hook's `readlink` can yield junk and a lost event is worse than a lost zone |
| `content` | required string. Must contain a non-whitespace character (`empty_content`). Not trimmed |
| `scope_hint` | optional or null string, ≤ 100 chars. Stored in `scope_hint`; nothing reads it |
| `sensitivity_hint` | optional or null; `normal` (default), `private` or `restricted`. This is the stored `sensitivity` (the spec's "stricter of hint and default" is the hint, since the default is the weakest) |
| `metadata` | optional JSON **object** (default `{}`): any JSON values, nested; not an array |

- **Characters:** a string anywhere in `content` or `metadata` (keys too) containing U+0000, or not well-formed UTF-16 (`!s.isWellFormed()`), is `422 invalid_characters`. Postgres `text` and `jsonb` can't hold NUL, so without this it would be a 500.
- **422 body:** `{ "error": "invalid_request", "issues": [{ "path": "role", "code": "invalid_value" }] }`. `path` is the known field name (`""` for the body or an unknown key), `code` is zod's issue code or one of ours (`empty_content`, `invalid_characters`, `unrecognized_keys`). **Never echo a submitted value, and never name an unknown key**: build `issues` yourself from `error.issues`, don't pass zod's messages through.
- Fields the server sets (never client-set): `event_id` (`newId('evt')`), `agent_id`, `token_id`, `source_client`, `received_at`, `redactions`, `content_hash`, `hash_alg`, `clock_flags`, `trust_tier`, `scope_id` (`personal`), `tainted` (`false`), `explicit_remember` (`false`), `principal`, `schema_version`, `content_type` (`text/plain`), `refs_event_ids`.
  - `agent_id` and `token_id` come from the verified token (`c.get('auth')`).
  - **`source_client = agent_id`**, as in the spec's examples. Don't use `agents.client_kind`: `nacre token create` defaults it to `cli`, which would label Claude Code's events `cli`.
  - `trust_tier`: `user_typed` for role `user`, `agent_inferred` for `assistant` (§5.1).
  - `received_at` is the hub's clock, passed in explicitly from an injectable `now` (see §3) so tests can fix it.

### 3. Clock flags
With `received` = the hub's `now()` and `observed` = `observed_at`:
- `drift` if `|observed − received| > 5 minutes` (exactly 5:00 is not a drift);
- `future` if `observed > received + 60 seconds` (exactly 60 s ahead is not `future`).
- Both can apply (6 minutes ahead gives both); store them in alphabetical order, as `text[]`.

`future` has a **60-second tolerance** (spec §5.1, v0.2.16): 2 seconds ahead is not `future`, because a few seconds of device clock skew is normal. The tolerance is a named constant next to the 5-minute drift one.

Make the clock injectable: an optional `now?: () => Date` on `AppDeps`, passed to the route and to `ingestEvent`; default `() => new Date()`. Add it to `TestAppOptions` in `test/helpers/app.ts`.

### 4. Normalize, redact, hash (`src/shared/redact.ts`, `src/shared/events.ts`)
In this order, on `content`: (1) `normalize('NFC')`; (2) `redactSecrets`; (3) `sha256` over the UTF-8 bytes of the result, as a 32-byte `Buffer` for `content_hash`. The stored `event_content.body` is the same string that was hashed. Nothing else changes the text (no trimming, no truncation).

**Redactor API:** `redactSecrets(text: string): { text: string; redactions: { kind: RedactionKind; count: number }[] }`, pure and synchronous. `redactions` lists only kinds with count > 0, sorted by `kind`. Also redact the **string values** inside `metadata` (recursively, not keys) with the same function, and merge those counts into the event's `redactions`. A secret must never reach the database, the activity log, the response or a log line.

**Kinds** (a closed set, `REDACTION_KINDS`): `private_key`, `jwt`, `url_credentials`, `bearer_token`, `api_key`, `password`, `high_entropy`. Marker: `[REDACTED:<kind>]`. Rules run in exactly this order, each on the output of the one before, so a span is counted once (the spec says to cover "API-key patterns, JWTs, private-key blocks, `password=`-style pairs and long high-entropy tokens"; `url_credentials` and `bearer_token` are the two additions this brief makes, called out as such in the PR). The regexes below are the intended behavior; if you change one, keep the test cases in §5 passing.

1. **`private_key`**: a PEM block, `-----BEGIN … PRIVATE KEY-----` through `-----END … PRIVATE KEY-----`, or **to the end of the text** if there is no END line (a truncated paste). Whole block replaced by one marker. `/-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----|$)/g`
2. **`jwt`**: `/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g`
3. **`url_credentials`**: the `user:password` part of `scheme://user:password@host`, keeping scheme and host: `postgres://[REDACTED:url_credentials]@db.internal:5432/app`. `/\b([a-z][a-z0-9+.-]{1,20}:\/\/)([^\s:@\/?#]+):([^\s@\/?#]+)@/gi`
4. **`bearer_token`**: `Bearer ` followed by a 16+ character token; the word stays: `Authorization: Bearer [REDACTED:bearer_token]`. `/\b(Bearer\s+)([A-Za-z0-9._~+\/=-]{16,})/gi`
5. **`api_key`**: any of these prefixes (all case-sensitive except where noted), whole match replaced:
   - `\bsk-[A-Za-z0-9_-]{20,}` (OpenAI, Anthropic `sk-ant-…`, `sk-test-…`);
   - `\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}` and `\bgithub_pat_[A-Za-z0-9_]{40,}`;
   - `\b(?:AKIA|ASIA)[0-9A-Z]{16}\b`;
   - `\bxox[abprs]-[A-Za-z0-9-]{10,}`;
   - `\bAIza[0-9A-Za-z_-]{35}`;
   - `\b[rs]k_(?:live|test)_[0-9A-Za-z]{16,}`;
   - Nacre's own tokens, `\bnacre_tok_[0-9A-Za-z]{26}_[A-Za-z0-9_-]{16,}` (a pasted Nacre token must never be stored, and `logActivity` refuses token-shaped values).
6. **`password`**: a key, then `:` or `=`, then a value; **the key stays, the value is replaced**: `DB_PASSWORD=[REDACTED:password]`. Keys (case-insensitive, matched with `(?<![A-Za-z0-9])` in front so `DB_PASSWORD` and `client_secret` match but `mypassword` doesn't): `password`, `passwd`, `pwd`, `passphrase`, `secret`, `token`, `api_key`/`api-key`/`apikey`, `access_token`, `auth_token`, `client_secret`, `secret_key`, `private_key`; an optional closing quote after the key (JSON: `"password": "…"`) and optional spaces around the separator. Value: a double- or single-quoted string of 4–200 characters on one line (quotes included in what's replaced), or an unquoted run of **6+** characters with no whitespace, quote, comma or semicolon. **Skip a value that already starts with `[REDACTED:`** (a `token=sk-…` is `api_key`, counted once). Prose false positives (`secret: recipe`) are accepted (§6.2).
7. **`high_entropy`**: split on `/[A-Za-z0-9+\/_=-]{32,}/g` and replace a candidate only if **all** hold: it has at least one lowercase letter, one uppercase letter and one digit; it is not hexadecimal once `-` is removed (so UUIDs, git SHAs and sha256 digests stay); and its Shannon entropy is ≥ 4.2 bits per character. Camel-case identifiers, long lowercase paths and hex all fail one of these tests on purpose.

**Performance:** the redactor runs on up to 100,000 characters per request. No pattern may backtrack catastrophically; the tests in §5 include adversarial inputs with a time guard.

### 5. Idempotency, and the transaction (`ingestEvent`)
`ingestEvent(sql, caller, input, { now })` takes the already-validated input and returns `{ eventId, created, hashMatches }`. The route calls it; task 10's `remember` will too.

In **one** `sql.begin` transaction:
1. `INSERT INTO events (…) VALUES (…) ON CONFLICT (agent_id, client_event_id) DO NOTHING RETURNING event_id`. Pass `received_at` explicitly. `content_hash` is a `Buffer`, `redactions` is `sql.json`, `clock_flags` a `text[]`.
2. **No row returned (a duplicate):** `SELECT event_id, content_hash FROM events WHERE agent_id = … AND client_event_id = …`, and return `created: false` with `hashMatches` = whether the stored hash equals the hash of this request's redacted body. **Write nothing else**: no content row, no job, no activity entry. (Under concurrency, `ON CONFLICT DO NOTHING` waits for the other transaction to commit, so the select sees its row.)
3. Otherwise: `INSERT INTO event_content (event_id, body)`; `INSERT INTO jobs (kind, ref_id) VALUES ('extract', <event_id>)`; and `logActivity(tx, { kind: 'event_append', actor: agentId, tokenId, requestId, targetKind: 'event', targetId: eventId, eventIds: [eventId], details })`. `logActivity` goes **last**, so a failure there rolls back everything before it (§8 tests this).

**`details`** for `event_append`: `{ kind, role, sensitivity, clock_flags, redactions, content_chars }` and nothing else: no content, no `client_event_id`, no `session_id`, no metadata. `content_chars` is the code-point count of the stored body.

**Dedup semantics** (spec §5.1, A6: same key → `200` with the original `event_id`):
- The key is **per agent**, not per token (rotating a token mustn't re-open old keys), and two agents may use the same `client_event_id`.
- A repeat with the **same key but different content** also returns `200` with the original id, and the new content is **not stored**. `hashMatches: false` is logged, not rejected (the request log gets `ingest: 'duplicate_mismatch'`). Question 2 below.

**Response:**
- New event: `201 {"event_id":"evt_…","status":"accepted","job":"extract"}`.
- Duplicate: `200` with the same three fields **plus** `"duplicate": true` (an addition the spec doesn't mention; list it in the PR).
- Set the request log's `ingest` to `created`, `duplicate` or `duplicate_mismatch`, and `event_id`. Add `ingest?: string` and `eventId?: string` to `AppEnv`, and both fields to the request-log line in `app.ts`. Rejections set `ingest: 'rejected:<code>'` (`rejected:content_too_large`, `rejected:invalid_request`, and so on).

### 6. Size limits (413)
Constants in one place, `EVENT_LIMITS` in `src/shared/events.ts` (no env variables):
- request body: **512 KiB**, enforced with `hono/body-limit` before the body is read (it covers a missing `Content-Length`), like `src/api/oauth/routes.tsx` does;
- `content`: **100,000 characters** (code points, before NFC);
- `metadata`: **8 KiB** of `JSON.stringify` (UTF-8 bytes).

Over any of them: `413 {"error":"payload_too_large","field":"body"|"content"|"metadata"}`. **Rejected, not truncated** (Question 1). Shape errors (422) are reported before the content and metadata caps. A 100,000-character event is about 13 extraction chunks (§6.2 item 4); the cost guard is task 5's job, not this task's.

### 7. Rate limit (429)
The spec sets no limit for `/v1/events`, but events can never be deleted, so a runaway hook loop would fill the log permanently. Use the existing `SlidingWindowLimiter`: **120 requests per minute per `agent_id`**, one limiter per agent in a `Map` (it can't grow past the number of agents, since only authenticated callers reach it). Claim the slot with `tryHit()` right after the token and rights checks and **before** reading the body; every authenticated attempt counts, good or bad; a 401 or 403 never does. Over the limit: `429 {"error":"too_many_requests"}` with `Retry-After: <whole seconds, at least 1>`, the same shape as `/oauth/register`. Memory is per process, so a restart resets it (fine for one `api` instance). The limit is `AppDeps.eventLimits?: { perMinute?: number }` for tests, defaulting to 120. The normal rate is a few events a minute, and a spool flush is at most 20 files (spec §8.3), so 120 leaves headroom.

### 8. Tests
**Unit (no database).**
- `test/redact.test.ts`, with these fixtures. **Build every fake secret at runtime** (`'sk-' + 'test-' + 'a1B2c3D4'.repeat(3)`, `'AKIA' + 'ABCDEFGHIJKLMNOP'`, a JWT from `Buffer.from(JSON.stringify(…)).toString('base64url')`), never as a literal in the repo, so GitHub secret scanning and push protection don't flag the PR.
  - **Redacted, with the right kind and count:** one fixture per `api_key` prefix above; an `eyJ…` JWT; a PEM block, a PEM with no END line (to end of text), and a PGP `PRIVATE KEY BLOCK`; `postgres://app:hunter2hunter2@db.internal:5432/app` (host and path kept); `Authorization: Bearer <20 chars>`; `password=hunter2hunter2`, `DB_PASSWORD="correct horse battery"`, `{"client_secret": "abcd1234efgh"}`, `token: 9f8e7d6c5b4a`; a 43-character random base64url string; a 50-character random alnum string inside a sentence.
  - **Left alone:** a UUID; a 40-character git SHA; a 64-character sha256 hex; a 40-character camel-case identifier; a long lowercase path (`/home/marcus/dev/nacre/src/shared/redact.test.ts`); `password` in prose ("I changed my password yesterday"); `password=abc` (too short); `task-force`/`risk-assessment` (no `sk-` boundary); `sk-learn`; a `token=` whose value is already `[REDACTED:…]`.
  - **Properties:** `redactSecrets(redactSecrets(x).text).text` equals `redactSecrets(x).text` with no new redactions; text with no secrets comes back identical; counts add up across several secrets of one kind; a `token=sk-…` counts one `api_key` and no `password`; markers keep the surrounding text byte for byte.
  - **Time guard** (each under 250 ms): 100,000 characters of `a=b ` pairs; 100,000 characters of `-----BEGIN PRIVATE KEY-----` repeated; a 100,000-character run of base64 characters; 100,000 characters of `password:` repeated.
- `test/events-unit.test.ts`: `clockFlags` (6 min ago → `['drift']`; 6 min ahead → `['drift','future']`; 2 s ahead → `[]`; exactly 60 s ahead → `[]`; 61 s ahead → `['future']`; exactly 5:00 ago → `[]`; exactly 5:00 ahead → `['future']`; 4:59 ago → `[]`); the zod schema (the hook's exact `observed_at`; the `observed_tz` lenience; every 422 case in §2, including that `issues` contains no submitted value); `contentHash` (NFC-equivalent inputs hash the same; a different body hashes differently).

**HTTP (`test/events.test.ts`)**, against the real api as `nacre_app`, using `startTestApp`, `staticToken` and `testAgent` so test files sharing the database never collide:
- **Happy path:** `201` with the three fields; the `events` row has every server-set field per §2 (`source_client = agent`, `trust_tier`, `scope_id = 'personal'`, `received_at` = the injected clock, `observed_at` converted to UTC); `event_content.body` is the NFC text; `content_hash` is 32 bytes and equals `sha256(body)`; one `jobs` row `('extract', evt_…, 'queued')`; one `activity_log` row `event_append` with the agent, the token id, the request id (`x-request-id`) and a `details` that matches §5 exactly.
- **NFC:** content `'cafe\u0301'` is stored as `'caf\u00e9'`, and the hash is over that.
- **Attribution:** a body carrying `agent_id`, `token_id`, `source_client` or `trust_tier` is `422`; with two tokens for one agent, the event records the token that made the call.
- **Assistant and private:** `role: 'assistant'` → `trust_tier = 'agent_inferred'`, stored, **and** a queued `extract` job; `sensitivity_hint: 'private'` → `sensitivity = 'private'`, stored, job queued.
- **Idempotency (A6):** posting the same payload twice gives `201` then `200` with the same `event_id` and `duplicate: true`, and exactly one row each in `events`, `event_content`, `jobs` and `activity_log`. The same key with different content is `200`, stores nothing new, and the request log has `ingest: 'duplicate_mismatch'`. The same key from a second agent creates a second event. **Ten parallel posts** of one key give exactly one `201` and nine `200`s and one row in each table.
- **Secrets (A16):** post one prompt containing a fake `sk-` key, a JWT, a `password=…` pair and an ordinary sentence ("my preferred package manager is pnpm"), plus a fake key in a `metadata` value. The stored body keeps the sentence and holds the markers and none of the secrets; `redactions` lists each kind with its count (metadata's included); `content_hash` matches the redacted body. Then search for every secret string in: the response, `events` and `event_content` (as `row_to_json` text), `activity_log`, `jobs`, and `app.logLines`. **None appear anywhere.** Repeat the log search after a `422` (valid content, bad `role`), a `413` and a `429` carrying the same secrets.
- **Status codes:**
  - `401`: no token; a malformed header; a revoked token; `?access_token=<valid token>` even with a valid header; an OAuth **access** token (`oauthToken` helper) on `/v1/events` (A17.5); each with the existing `WWW-Authenticate: Bearer realm="nacre"` and `{error:'unauthorized'}`.
  - `403`: `Origin: https://evil.example` (and an allowed `Origin` passes); a static token whose `rights` is `{read}` (insert the row directly as `oauthToken` does, since `nacre_app` can't `UPDATE` `rights`, or add a `rights` option to `createStaticToken` if that's tidier).
  - `400`: not JSON, wrong content type, a JSON array.
  - `422`: each row of §2's table with one bad value, an unknown key, an empty or whitespace-only `content`, a NUL in `content` and in a `metadata` key, a lone surrogate (`'\ud800'`).
  - `413`: a 600 KiB body (with and without `Content-Length`, i.e. chunked); 100,001 characters of `content`; a 9 KiB `metadata`. Exactly 100,000 characters passes.
  - `429`: with `eventLimits: { perMinute: 3 }`, the 4th request in a minute gets `429` and a `Retry-After` of at least 1; a second agent's token still gets `201`; invalid requests count; a `401` doesn't.
  - **No ingest on failure:** after every `4xx` above, no `events` row exists for that key.
- **Request log:** the line for a successful post has `agent_id`, `token_id`, `ingest: 'created'`, `event_id` and status; no line contains `content`, `body` or `metadata` keys, or any posted text.

**Rollback (`test/events-rollback.test.ts`).** Separate file, because it mocks a module. `vi.mock('../src/shared/activity.js', …)` wrapping the real `logActivity` in a `vi.fn`, then `mockRejectedValueOnce(new Error('boom ' + <the posted content>))`. Post a valid event: the response is `500 {"error":"internal"}`; **no** `events`, `event_content`, `jobs` or `activity_log` row exists for it (the transaction rolled back, with `logActivity` last); the log has an error line with no message text and no content; then posting the same payload again gives `201` (the key wasn't burned). This also covers §9.

### 9. Errors: nothing leaks
Give the `/v1` sub-app an `onError` that logs **only** `{ request_id, err_name, sqlstate, constraint }` (SQLSTATE from the postgres.js error's `code`, constraint from `constraint_name`) and returns `500 {"error":"internal"}`. **Never log `err.message`, `err.detail`, the query or the stack.** Postgres check- and not-null-violation messages quote the failing row ("Failing row contains …"), which would put message content in the logs, and Hono's default handler prints the whole error to the console.

### 10. Docs
- **Repo docs** (a `docs:` commit, separate from the code):
  - `docs/tasks/README.md`: row 04 becomes the brief's link and **"In progress (PR #NN)"**; add `docs/tasks/task-04-event-ingest.md` (this file) if it isn't in the repo yet.
  - `README.md`: the Status paragraph (task 4: `POST /v1/events` with secret redaction, idempotency, the `extract` job; the worker is still a placeholder, so queued jobs wait for task 5), a short "Try it" example under "Run it locally" (the `curl` in the steps below), and replace the "Steps for task 3c (Marcus)" section with **"Steps for task 4 (Marcus)"**:
    - No Railway change: no new variable, no migration, nothing in `.railway/railway.ts`.
    - **Merge the PR**, wait for the `api` deploy (pre-deploy logs `migrate: nothing to apply` and the same `db:verify` count as before).
    - From your machine, with your `claude-code` token: post the event below (it holds fake secrets; the key is split in the shell so no secret-shaped literal sits in the README), expect `201`, post it again and expect `200` with `"duplicate":true` and the same `event_id`:
      ```bash
      FAKE_KEY="sk-""test-abcdefghijklmnopqrstuvwx"   # split so no secret-shaped literal sits in the repo
      NOW="$(date +%Y-%m-%dT%H:%M:%S%z | sed -E 's/([0-9]{2})$/:\1/')"
      curl -s -X POST "$NACRE_URL/v1/events" -H "Authorization: Bearer $(cat ~/.nacre/token)" -H 'Content-Type: application/json' \
        -d "{\"client_event_id\":\"manual:try-1\",\"kind\":\"message\",\"role\":\"user\",\"observed_at\":\"$NOW\",\"content\":\"My preferred package manager is pnpm. password=hunter2hunter2 key=$FAKE_KEY\"}"
      ```
    - In a `psql` on the Railway database (for example `railway connect`): `SELECT event_id, redactions, clock_flags FROM events ORDER BY received_at DESC LIMIT 1;`, `SELECT body FROM event_content WHERE event_id = '<id>';` (markers, no secret), `SELECT kind, ref_id, status FROM jobs ORDER BY job_id DESC LIMIT 1;` (`extract`, `queued`), and the `event_append` row in `activity_log`.
    - In the `api` logs, find the request line: `ingest: "created"`, no content anywhere.
- **Spec:** leave `docs/slice-1-spec.md` alone. The numbers and rules this brief sets fill gaps the spec leaves open, and Marcus hasn't signed them off. In the PR description add a **"Spec updates to apply"** list: the limits (§6), the 413/422/429/403 behavior, the duplicate response and mismatch rule, `source_client = agent_id`, the two extra redaction kinds and the exact kind list, and the `future` tolerance gap. Marcus folds them into v0.2.16.

## Out of scope
- `POST /v1/hooks/*`, the hook script and spool, `remember`, `recall`, `GET /v1/provenance/:id` (tasks 10 and 11).
- Anything in the worker: extraction, skip logic, the cost guard, embeddings (task 5 onward); the `/healthz` queue depth.
- Enforcing `write_scopes` or `label_ceiling` (later slices); only the `write` right is checked.
- Event kinds other than `message`; `tainted`, `explicit_remember`, `refs_event_ids`; replica or device fields; encryption, purge or per-event keys (slice 8).
- A shared or persistent rate limiter, new variables, CORS, the web app, Railway, DNS.
- Any migration, grant or trigger change. Changing `src/api/auth.ts` or `activity.ts`.
- Editing the spec (see §10).

## Done when (list each check and its result in the PR description)
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test` (with `TEST_DATABASE_URL`) and `pnpm build` pass locally and in CI; paste the test count.
- [ ] **No schema change:** `git diff main --stat -- migrations` is empty, `.railway/railway.ts` is unchanged, and `pnpm db:verify` still passes with the same count.
- [ ] **Validation:** every row of §2, the `400` cases, strict unknown-key rejection, `invalid_characters` and `empty_content` all behave as written, and no `422` body contains a submitted value (tested).
- [ ] **Redaction:** every must-redact and must-not-redact fixture in §5's list passes; the idempotence, counting and time-guard tests pass; fixtures are built at runtime and no secret-shaped literal is committed.
- [ ] **A16 (CI part):** the stored body, `redactions` and `content_hash` are right, and no secret appears in the response, any table, or the request logs, including after a 422, 413, 429 and a forced 500.
- [ ] **A6:** a repeat gives `200` and the same `event_id` with one row in each table; ten parallel posts give one `201`; the same key from another agent makes a second event; a mismatched repeat stores nothing and logs `duplicate_mismatch`.
- [ ] **Attribution and fields:** `agent_id`, `token_id`, `source_client`, `trust_tier`, `scope_id`, `received_at` and `observed_at` (UTC) are set from the token and the clock; a client can't set them.
- [ ] **One transaction:** the rollback test passes (nothing left behind, the key reusable, no content in the error log). The `extract` job exists for user, assistant and `private` events.
- [ ] **Clock flags:** the cases in `events-unit.test.ts` pass, including the 60-second `future` tolerance.
- [ ] **Status codes:** the 401, 403, 400, 422, 413 and 429 tests above pass, including that an OAuth access token gets 401 (A17.5) and that a 401 or 403 never uses a rate-limit slot.
- [ ] **Activity:** exactly one `event_append` per new event and none for a duplicate, with the §5 `details` and nothing else.
- [ ] **Live check (Marcus, after deploy).** The PR lists the steps from the README section above with blank result lines.
- [ ] PR from `task-04-event-ingest` to `main`, titled **"Task 4: Event ingest (`POST /v1/events`)"**, with deviations, **Spec updates to apply**, and open questions per `docs/tasks/README.md`. Don't merge.

## Decided by Marcus (Oct 24, 2026; built as written, now in spec v0.2.16)
1. **Too-big events: reject or truncate?** *Decided: reject with `413` (100,000 characters of content, 512 KiB of body).* Events are stored unchanged except for secrets (§6.2); a silently cut event would have a hash that matches text the client never sent. The cost: the spec §8.3 hook script spools any failed post and retries it forever, so a too-big assistant reply would be retried on every session start. Task 11's script should drop a file on `413` and `422` (keep it for `408`, `429` and `5xx`). Truncating assistant turns only (they aren't mined, and context uses 1,000 characters of each) is the alternative.
2. **Same key, different content: `200` and ignore, or `409`?** *Decided: `200` with the original id, new content not stored, logged as `duplicate_mismatch`.* It is what A6 says, it keeps a replayed spool file harmless, and the hook's key falls back to a one-second timestamp when `prompt_id` is missing, so a collision can be a genuine second prompt. A `409` would surface client bugs, at the price of one more status the hook must treat as permanent.

## Conventions
Conventional Commits, small and readable. The docs changes are their own commit. One task per PR. No secrets in the repo, ever, and no secret-shaped literals in tests. Don't merge.
