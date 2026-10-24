# Nacre

**One memory, shared by all of your AI agents.** Tell Claude Code a fact; get it back in Grok Bot with the exact quote it came from and a link to the original message.

Nacre keeps an append-only log of what your agents saw, turns it into claims whose quotes are checked in code, and serves the resulting beliefs to every agent over MCP, with provenance on every answer. Like mother-of-pearl, it is built in thin layers over time.

## Status

**v3, slice 1, task 5: the worker and extraction.** This is a ground-up reboot. What exists today:
- an `api` service (Hono) with a remote MCP endpoint at `/mcp` (Streamable HTTP, one `ping` tool) and `GET /healthz` (which checks the database);
- per-agent bearer tokens (`nacre_tok_<ulid>_<secret>`, stored as HMAC hashes) checked by one verifier for static and OAuth access tokens, an exact-match `Origin` check on `/mcp` and `/v1`, and the activity log (`token_create`, `token_revoke`, `token_use_denied`, `event_append`, `system`);
- `POST /v1/events` (static tokens with the `write` right; spec §5.1): it validates an event, strips pasted secrets (`[REDACTED:<kind>]`), hashes the redacted body, and writes the event, its content, an `event_append` entry and an `extract` job in one transaction. A repeated `client_event_id` returns the original event;
- a minimal OAuth 2.1 server for MCP clients that can't send a static header (Grok Bot first; spec §9.3): discovery metadata, dynamic client registration, `/oauth/authorize` with PKCE S256 and a small consent page (owner password, agent choice), and `/oauth/token` with refresh rotation and reuse detection;
- the `nacre` CLI: `token create|revoke|list` (revoking an OAuth token revokes its whole grant), `owner-password hash`, and the deploy steps `db migrate|app-login`;
- the full slice 1 schema (spec §4) as dbmate migrations on Postgres 18 + pgvector, the `nacre_app` role, and append-only guards enforced by triggers **and** grants, with a verifier (`pnpm db:verify`);
- a `worker` service that claims `extract` jobs (`FOR UPDATE SKIP LOCKED`, 5 attempts with backoff), skips assistant turns and private or restricted events, extracts claims with OpenAI `gpt-6-luna` (Responses API, strict JSON schema, prompt `extract-claims` v1), checks every quote in code, and writes `candidate` claims with evidence spans, or `held` claims with the reason, plus `extraction_runs`, `model_calls` and activity entries. It keeps to a $0.50/day budget (midnight to midnight America/Chicago) and idles without `OPENAI_API_KEY`. Nothing promotes claims to beliefs yet (task 8), and quotes are matched exactly until task 6's verifier is wired in;
- CI with a Postgres service; a Dockerfile and Railway Infrastructure as Code.

The real tools (`remember`, `recall`, `get_provenance`), promotion to beliefs and the web app arrive over the rest of slice 1. v2 (the markdown knowledge-graph version) is preserved at the [`v2-final`](https://github.com/marcusschimizzi/nacre/tree/v2-final) tag and the [`v2`](https://github.com/marcusschimizzi/nacre/tree/v2) branch.

## Run it locally

Needs Node 24 (see `.node-version`), pnpm (pinned through `packageManager`; `corepack enable` picks the right version) and Docker for Postgres.

```bash
pnpm install
docker run -d --name nacre-pg -e POSTGRES_HOST_AUTH_METHOD=trust -p 54329:5432 pgvector/pgvector:pg18
cp .env.example .env     # then set TOKEN_PEPPER=$(openssl rand -base64 32) and NACRE_APP_DB_PASSWORD=$(openssl rand -hex 32)

pnpm db:migrate          # create nacre_dev, apply migrations/, log a `system` activity entry
pnpm nacre db app-login  # give nacre_app LOGIN (trust auth locally, so the password isn't checked)
pnpm dev                 # api on http://localhost:3000, connected as nacre_app
pnpm dev:worker          # the worker, in another terminal (idles without OPENAI_API_KEY)

curl localhost:3000/healthz                                            # {"status":"ok",…,"db":"ok"}
pnpm nacre token create --agent claude-code > ~/.nacre/token           # token on stdout only, shown once
NACRE_TOKEN="$(cat ~/.nacre/token)" pnpm mcp:smoke http://localhost:3000/mcp
pnpm nacre token list                                                  # ids, agents, dates; never secrets
pnpm nacre token revoke tok_…                                          # the next call gets 401
```

Connect Claude Code (see [`docs/spike-mcp.md`](docs/spike-mcp.md)):

```bash
export NACRE_TOKEN="$(cat ~/.nacre/token)"
claude mcp add --transport http nacre --scope user http://localhost:3000/mcp \
  --header 'Authorization: Bearer ${NACRE_TOKEN}'
claude mcp get nacre
```

OAuth clients (Grok Bot's custom connector, or the SDK's `OAuthClientProvider`) need only the URL: the 401 from `/mcp` points them at `/.well-known/oauth-protected-resource/mcp`, they register themselves, and the consent page at `/oauth/authorize` asks for the owner password. Set it up locally with `printf '%s\n' 'your password here' | pnpm nacre owner-password hash` (or run it without a pipe for a hidden prompt) and put the printed `$argon2id$…` line in `.env` as `OWNER_PASSWORD_HASH`, in single quotes. Without it the consent form answers 503 and everything else works.

```bash
curl -si -X POST localhost:3000/mcp | grep -i '^www-authenticate'   # Bearer realm="nacre", resource_metadata="…/.well-known/oauth-protected-resource/mcp"
curl -s localhost:3000/.well-known/oauth-authorization-server | jq -c '[.code_challenge_methods_supported,.token_endpoint_auth_methods_supported]'   # [["S256"],["none"]]
```

Try ingest (it holds fake secrets, which are stored as markers; the key is split so no secret-shaped literal sits in the repo):

```bash
FAKE_KEY="sk-""test-abcdefghijklmnopqrstuvwx"
NOW="$(date +%Y-%m-%dT%H:%M:%S%z | sed -E 's/([0-9]{2})$/:\1/')"
curl -s -X POST localhost:3000/v1/events -H "Authorization: Bearer $(cat ~/.nacre/token)" -H 'Content-Type: application/json' \
  -d "{\"client_event_id\":\"manual:try-1\",\"kind\":\"message\",\"role\":\"user\",\"observed_at\":\"$NOW\",\"content\":\"My preferred package manager is pnpm. password=hunter2hunter2 key=$FAKE_KEY\"}"
# 201 {"event_id":"evt_…","status":"accepted","job":"extract"}; the same again: 200 with "duplicate":true
```

Tokens go in the `Authorization` header only: a token in the query string gets 401 even next to a valid header, and a browser `Origin` that isn't `PUBLIC_API_URL` (or `ALLOWED_ORIGINS`) gets 403.

### Database

Postgres 18 with pgvector, in Docker. Trust auth, so there is no password to keep anywhere locally. The URLs live in `.env` (dbmate, the `db:` scripts, the `nacre` CLI and the test setup read it):

```bash
pnpm db:migrate     # `nacre db migrate`: dbmate up, plus a `system` activity entry when it applied something
pnpm db:status      # applied and pending migrations
pnpm db:rollback    # undo the latest migration
pnpm db:verify      # append-only and grant checks (A5); prints PASS/FAIL, leaves no rows
pnpm build && pnpm db:predeploy   # exactly what Railway runs before each api deploy: migrate, app-login, verify
```

If port 54329 is taken, map another one and use it in every URL. `pnpm test` creates, migrates and drops its own scratch database through `TEST_DATABASE_URL`, and connects as `nacre_app` like the api; without it the database tests are skipped locally (CI requires them). Details: [`migrations/README.md`](migrations/README.md).

Other scripts: `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, then `pnpm start:api` / `pnpm start:worker`.

## Steps for task 5 (Marcus)

The worker needs two variables before it can extract. Without them it still deploys: with no `DATABASE_URL` it fails its config check at start, and with no key it idles. Nothing is lost either way; jobs wait in the table.
1. **Before merging, set the worker's two secrets** in Railway's dashboard (Nacre project, `worker` service, Variables):
   - `DATABASE_URL` = `${{api.DATABASE_URL}}` (a reference: the same `nacre_app` URL the `api` uses).
   - `OPENAI_API_KEY` = your OpenAI key. **You** type it into the dashboard; don't paste it into a chat, a PR, an issue or a file. Optionally set a monthly spend limit on that key in OpenAI's dashboard.
2. **Apply the infrastructure file** from a checkout of this PR's branch (the file there declares the worker's four variables):

   ```bash
   git fetch origin && git switch task-05-worker-and-extractor
   railway config plan    # expect: worker gains DATABASE_URL, OPENAI_API_KEY (preserved), LLM_MODEL, DAILY_LLM_BUDGET_USD; nothing deleted
   railway config apply
   ```
3. **Merge.** The `api` pre-deploy applies the one new migration (`migrate: applied 20261024120000`, then `76 passed, 0 failed`). The worker waits for it, then starts. In the `worker` log expect `worker started` with `"openai":"configured"`, then `schema is current`, and no further `waiting for schema` lines.
4. **Live check, about $0.0004.** Run the smoke script inside the worker, where the key already is:

   ```bash
   railway ssh --service worker -- node dist/worker/smoke.js
   ```

   Expect a `model: gpt-6-luna…` line, the token counts, the cost, at least one claim such as `preferred_package_manager = pnpm (preference): exact`, and `PASS`. Then post one real event from your machine and note its `event_id`:

   ```bash
   NACRE_URL=https://api.nacre.so
   NOW="$(date +%Y-%m-%dT%H:%M:%S%z | sed -E 's/([0-9]{2})$/:\1/')"
   curl -s -X POST "$NACRE_URL/v1/events" -H "Authorization: Bearer $(cat ~/.nacre/token)" -H 'Content-Type: application/json' \
     -d "{\"client_event_id\":\"manual:task5-1\",\"kind\":\"message\",\"role\":\"user\",\"observed_at\":\"$NOW\",\"content\":\"For the record, my preferred package manager is pnpm. Can you update the README?\"}"
   # 201 {"event_id":"evt_…","status":"accepted","job":"extract"}
   ```
5. **Check the rows** a few seconds later, in `railway connect nacredb`, with the `event_id` in place of `<id>`:

   ```sql
   -- The run: one row, status ok, model_version set, about 2,500 / 300 tokens, cost about 0.0004.
   SELECT run_id, status, skip_reason, error, model_version, input_tokens, output_tokens, cost_usd
   FROM extraction_runs WHERE event_id = '<id>' ORDER BY started_at;
   -- The claims: candidate with checks {"quote":"exact",…}, or held with a reason.
   SELECT claim_id, status, status_reason, attribute, value, assertion_type, checks
   FROM claims WHERE event_id = '<id>';
   -- The evidence: faithful is true on every row.
   SELECT s.claim_id, s.span_start, s.span_end, s.match_kind, s.quote,
          substring(c.body FROM s.span_start + 1 FOR s.span_end - s.span_start) = s.quote AS faithful
   FROM evidence_spans s JOIN event_content c USING (event_id) WHERE s.event_id = '<id>';
   -- Today's spend (Chicago day) against the $0.50 budget.
   SELECT count(*) AS calls, coalesce(sum(cost_usd), 0) AS spent_usd FROM model_calls
   WHERE at >= date_trunc('day', now() AT TIME ZONE 'America/Chicago') AT TIME ZONE 'America/Chicago';
   ```

   The `worker` log has one `extract job finished` line for the event with ids, counts, tokens and cost, and no message text.
6. **If something is off:** `extraction disabled: OPENAI_API_KEY is not set` means the key is missing; `extractor_auth_failed` means OpenAI rejected it (jobs wait 5 minutes each time and keep their attempts). If the budget is hit, `activity_log` gets a `system` entry with `"step":"budget_stop"` and jobs resume after midnight Chicago time.

## Steps for task 4 (Marcus)

No Railway change: no new variable, no migration, nothing in `.railway/railway.ts`. **Merge the PR** and wait for the `api` deploy (pre-deploy logs `migrate: nothing to apply` and `75 passed, 0 failed`, as before). Then:
1. **Post an event** from your machine with your `claude-code` token. It holds fake secrets; the key is split so no secret-shaped literal sits in the repo. Expect `201`; run it again and expect `200` with `"duplicate":true` and the same `event_id`:

   ```bash
   NACRE_URL=https://api.nacre.so
   FAKE_KEY="sk-""test-abcdefghijklmnopqrstuvwx"   # split so no secret-shaped literal sits in the repo
   NOW="$(date +%Y-%m-%dT%H:%M:%S%z | sed -E 's/([0-9]{2})$/:\1/')"
   curl -s -X POST "$NACRE_URL/v1/events" -H "Authorization: Bearer $(cat ~/.nacre/token)" -H 'Content-Type: application/json' \
     -d "{\"client_event_id\":\"manual:try-1\",\"kind\":\"message\",\"role\":\"user\",\"observed_at\":\"$NOW\",\"content\":\"My preferred package manager is pnpm. password=hunter2hunter2 key=$FAKE_KEY\"}"
   ```
2. **Check the rows** in a `psql` on the Railway database (for example `railway connect nacredb`):
   - `SELECT event_id, redactions, clock_flags FROM events ORDER BY received_at DESC LIMIT 1;` shows `api_key` and `password`, each with count 1, and no clock flags.
   - `SELECT body FROM event_content WHERE event_id = '<id>';` shows the markers and no secret.
   - `SELECT kind, ref_id, status FROM jobs ORDER BY job_id DESC LIMIT 1;` shows `extract`, `queued`.
   - `SELECT kind, actor, details FROM activity_log WHERE target_id = '<id>';` shows one `event_append` from `claude-code`.
3. **Check the logs:** the `api` request line for the post has `"ingest":"created"` and the `event_id`, the second has `"ingest":"duplicate"`, and neither carries any content.

## Railway steps for task 3b (done, Oct 24, 2026)

Agents don't run these. **Set the variable before merging**, so the consent form works on the first deploy (without it the form answers 503; `/mcp` and Claude Code's static token are unaffected either way).
1. **`OWNER_PASSWORD_HASH` on `api`.** On your machine, run `pnpm nacre owner-password hash`: it asks for the owner password twice without echoing it (12 characters or more) and prints one `$argon2id$v=19$m=65536,t=3,p=4$…` line. In the dashboard (`api` → Variables), set `OWNER_PASSWORD_HASH` to that line exactly, as a raw value, not a reference. The password never leaves your machine; only the hash is stored.
2. **Nothing else changes.** `api.nacre.so` is live and `PUBLIC_API_URL=https://api.nacre.so` is set, so there is no other variable and no DNS step. `railway config plan` should show no change: `OWNER_PASSWORD_HASH` is `preserve()`, which keeps the value you set. Don't apply anything else.
3. **Merge the PR**, wait for the `api` deploy (pre-deploy still logs `migrate: nothing to apply`, the login line and `75 passed, 0 failed`; this task adds no migration), then:

   ```bash
   curl -si -X POST https://api.nacre.so/mcp | grep -iE '^HTTP|www-auth'
   # 401, Bearer realm="nacre", resource_metadata="https://api.nacre.so/.well-known/oauth-protected-resource/mcp"
   curl -s https://api.nacre.so/.well-known/oauth-protected-resource/mcp
   # {"resource":"https://api.nacre.so/mcp","authorization_servers":["https://api.nacre.so"],"bearer_methods_supported":["header"]}
   curl -s https://api.nacre.so/.well-known/oauth-authorization-server | jq -c '[.code_challenge_methods_supported,.token_endpoint_auth_methods_supported]'
   # [["S256"],["none"]]
   ```

   Don't test `POST /oauth/register` against prod by hand: every registration writes a permanent `oauth_client_register` row. Claude Code's `ping` should still work.
4. **Grok Bot** (A17.6; the PR lists these steps with a result line for each):
   1. In Grok Bot, add a **custom connector** with the URL `https://api.nacre.so/mcp` and nothing else.
   2. The consent page opens. Check the client name it registered and the redirect host. On a first connection "Create new agent" is preselected with the suggested id (expected `grok-bot`); keep it (if a `grok-bot` agent already exists, the page preselects it instead). Enter the owner password and Approve.
   3. Ask Grok Bot to call `ping`: it answers `pong` with `agent_id: "grok-bot"` (or the id you chose).
   4. `railway ssh --service api`, then `node dist/cli/main.js token list`: an `oauth_access` and an `oauth_refresh` row for that agent, with a `grt_…` grant. `node dist/cli/main.js token revoke <that token_id>` revokes the whole grant; ask Grok Bot to call `ping` again, and it fails with 401.
   5. From the api logs (`request` lines with `user_agent` `grok-connectors-manager/…`), note how it registered: `"oauth":"register:ok"` on `POST /oauth/register` is dynamic registration; `"client_id_is_url":true` on `/oauth/authorize` means it wanted CIMD (stop and report: spec §16 R11); also note its `Origin`, if any, and `mcp_protocol`.

## Railway steps for task 3 (done, Oct 24, 2026)

Agents don't run these. **Set the variables before merging:** merging deploys `api` from `main`, and the new code needs them.
1. **Variables on `api`** (dashboard → `api` → Variables). Type each secret once; nothing goes in a file.
   - `NACRE_APP_DB_PASSWORD`: `openssl rand -hex 32`. Hex, not base64, because it goes inside a URL.
   - `DATABASE_URL`: `postgresql://nacre_app:${{NACRE_APP_DB_PASSWORD}}@${{nacredb.RAILWAY_PRIVATE_DOMAIN}}:5432/${{nacredb.PGDATABASE}}`. Railway fills in the references, so the password is typed only once, and the host is `nacredb`'s private one.
   - `TOKEN_PEPPER`: `openssl rand -base64 32`. Changing it later invalidates every token.
   - `PUBLIC_API_URL`: `https://api.nacre.so`, with no path or trailing slash. The image runs with `NODE_ENV=production`, where an `http://` value stops the api at startup.
2. **Merge the PR.** The `api` deploy's pre-deploy log should show `migrate: nothing to apply; recorded 20261023000000, 20261023000100 (applied earlier); system activity entry written` (task 2's migrations predate the entry; later deploys say just `migrate: nothing to apply`), then `app-login: nacre_app has LOGIN with the password from NACRE_APP_DB_PASSWORD`, then `75 passed, 0 failed`. A wrong password or URL fails the health check instead (`/healthz` returns 503 with `"db":"error"`). The health check runs inside Railway, so it doesn't wait for DNS.
3. **`railway config plan`, then `railway config apply`.** Expect two changes on `api`: the custom domain `api.nacre.so` is created (port 8080), and the old shared dev-token variable from task 1, which nothing reads any more, is deleted (the one destructive line). The new variables are `preserve()`, so they show no change. `Postgres-PITR` must not appear.
4. **DNS for `api.nacre.so`.** `api` → Settings → Networking now lists the domain with the records to add at `nacre.so`'s DNS host: a `CNAME` for `api` and a `TXT` for Railway's ownership check. Add both, then wait until Railway shows the domain as verified with a certificate. If the DNS host is Cloudflare, leave the records "DNS only" until the certificate has been issued.
5. **Check:** `curl https://api.nacre.so/healthz` → `"db":"ok"`.
6. **Mint Claude Code's token** inside the running container, over the private network: `railway ssh --service api`, then `node dist/cli/main.js token create --agent claude-code`. Put the printed line in `~/.nacre/token`, replacing the old dev token (it no longer works).
7. **Claude Code:** `claude mcp add --transport http nacre --scope user https://api.nacre.so/mcp --header 'Authorization: Bearer ${NACRE_TOKEN}'` (remove the old entry first), then `claude mcp get nacre` and ask a session to call `ping`. It answers with `"agent_id":"claude-code"`.
8. **The A11 checks against prod:**

   ```bash
   curl -si -X POST https://api.nacre.so/mcp | grep -iE '^HTTP|www-auth'               # 401, Bearer realm="nacre"
   curl -si -X POST "https://api.nacre.so/mcp?access_token=$NACRE_TOKEN" \
     -H "Authorization: Bearer $NACRE_TOKEN" | head -1                                  # 401, and a token_in_url entry (a real token)
   curl -si -X POST https://api.nacre.so/mcp -H "Authorization: Bearer $NACRE_TOKEN" \
     -H 'Origin: https://evil.example' | head -1                                        # 403
   NACRE_TOKEN="$NACRE_TOKEN" pnpm mcp:smoke https://api.nacre.so/mcp                  # all ok
   ```

## Layout

| Path                  | What                                                                                                                               |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `src/api/`            | Hono app: `/mcp` (Origin check, token auth), `/healthz`, OAuth (`oauth/`: discovery, `/oauth/*`, consent page), `/v1` (`v1/`)      |
| `src/cli/`            | The `nacre` CLI: tokens, `owner-password hash`, and the deploy steps (`db migrate`, `db app-login`)                                |
| `src/worker/`         | Job worker: claims `extract` jobs, the `Extractor` and OpenAI adapter, prompt v1, quote checks, claims, the budget                 |
| `src/shared/`         | Config, logging, ids, tokens, OAuth, the owner password, the activity log, event ingest and redaction, prices, postgres.js (`db/`) |
| `src/audit/`          | Schema guard checks (A5 and grants), shared by tests, `pnpm db:verify`, the pre-deploy step and the nightly self-audit             |
| `migrations/`         | Hand-written dbmate `.sql` files: the §4 schema, then roles and grants                                                             |
| `test/`               | Vitest: MCP over real HTTP, auth and A11, ingest and redaction, the worker (fake extractor, OpenAI fixtures), CLI, database suite  |
| `.railway/railway.ts` | Railway Infrastructure as Code: `nacredb` (Postgres 18) and its PITR bucket, `api` (pre-deploy: migrate, login, checks), `worker`  |

## Docs

- [`docs/design.md`](docs/design.md): the overall design
- [`docs/slice-1-spec.md`](docs/slice-1-spec.md): the slice 1 build spec
- [`docs/tasks/`](docs/tasks/): task briefs and the workflow ([README](docs/tasks/README.md))
- [`docs/spike-mcp.md`](docs/spike-mcp.md): MCP protocol findings and client setup

## License

[Apache-2.0](LICENSE)
