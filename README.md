# Nacre

**One memory, shared by all of your AI agents.** Tell Claude Code a fact; get it back in Grok Bot with the exact quote it came from and a link to the original message.

Nacre keeps an append-only log of what your agents saw, turns it into claims whose quotes are checked in code, and serves the resulting beliefs to every agent over MCP, with provenance on every answer. Like mother-of-pearl, it is built in thin layers over time.

## Status

**v3, slice 1, task 3b: minimal OAuth 2.1 for MCP.** This is a ground-up reboot. What exists today:
- an `api` service (Hono) with a remote MCP endpoint at `/mcp` (Streamable HTTP, one `ping` tool) and `GET /healthz` (which checks the database);
- per-agent bearer tokens (`nacre_tok_<ulid>_<secret>`, stored as HMAC hashes) checked by one verifier for static and OAuth access tokens, an exact-match `Origin` check on `/mcp`, and the activity log (`token_create`, `token_revoke`, `token_use_denied`, `system`);
- a minimal OAuth 2.1 server for MCP clients that can't send a static header (Grok Bot first; spec §9.3): discovery metadata, dynamic client registration, `/oauth/authorize` with PKCE S256 and a small consent page (owner password, agent choice), and `/oauth/token` with refresh rotation and reuse detection;
- the `nacre` CLI: `token create|revoke|list` (revoking an OAuth token revokes its whole grant), `owner-password hash`, and the deploy steps `db migrate|app-login`;
- the full slice 1 schema (spec §4) as dbmate migrations on Postgres 18 + pgvector, the `nacre_app` role, and append-only guards enforced by triggers **and** grants, with a verifier (`pnpm db:verify`);
- a placeholder `worker` service; CI with a Postgres service; a Dockerfile and Railway Infrastructure as Code.

The real tools (`remember`, `recall`, `get_provenance`), extraction and the web app arrive over the rest of slice 1. v2 (the markdown knowledge-graph version) is preserved at the [`v2-final`](https://github.com/marcusschimizzi/nacre/tree/v2-final) tag and the [`v2`](https://github.com/marcusschimizzi/nacre/tree/v2) branch.

## Run it locally

Needs Node 24 (see `.node-version`), pnpm (pinned through `packageManager`; `corepack enable` picks the right version) and Docker for Postgres.

```bash
pnpm install
docker run -d --name nacre-pg -e POSTGRES_HOST_AUTH_METHOD=trust -p 54329:5432 pgvector/pgvector:pg18
cp .env.example .env     # then set TOKEN_PEPPER=$(openssl rand -base64 32) and NACRE_APP_DB_PASSWORD=$(openssl rand -hex 32)

pnpm db:migrate          # create nacre_dev, apply migrations/, log a `system` activity entry
pnpm nacre db app-login  # give nacre_app LOGIN (trust auth locally, so the password isn't checked)
pnpm dev                 # api on http://localhost:3000, connected as nacre_app
pnpm dev:worker          # placeholder worker, in another terminal

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

## Steps for task 3c (Marcus)

No Railway change: no new variable, no migration, nothing in `.railway/railway.ts`. **Merge the PR**, wait for the `api` deploy (pre-deploy logs `migrate: nothing to apply` and `75 passed, 0 failed`), then:
1. **Cursor:** reconnect it. On the consent page choose `grok-bot`, enter the owner password, Approve, and ask it to call `ping` (`agent_id: "grok-bot"`).
2. **Reconnect:** `railway ssh --service api`, `node dist/cli/main.js token list`, and `node dist/cli/main.js token revoke <Cursor's oauth_access token_id>`. Then reconnect Cursor: the page preselects `grok-bot` and says "Last used by this client."
3. **grok.com:** reconnect it. The consent page opens, so `grok.com` is on the redirect allow-list.
4. **After an hour of use:** the `api` logs show `"oauth":"token:refresh"` for each client, and their `tools/call` request lines carry `mcp_method`.

A new OAuth client whose `https` redirect host isn't on `OAUTH_REDIRECT_HOSTS` (`src/shared/oauth.ts`) gets `400 invalid_redirect_uri` at registration. Adding a host is a reviewed code change. Loopback redirects (any port) are always allowed.

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

| Path                  | What                                                                                                                              |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `src/api/`            | Hono app: `/mcp` (Origin check, token auth), `/healthz`, OAuth (`oauth/`: discovery, `/oauth/*`, the consent page); later `/v1/*` |
| `src/cli/`            | The `nacre` CLI: tokens, `owner-password hash`, and the deploy steps (`db migrate`, `db app-login`)                               |
| `src/worker/`         | Job worker (placeholder loop)                                                                                                     |
| `src/shared/`         | Config, logging, ids, tokens, OAuth grants and codes, the owner password, the activity log, and the postgres.js client (`db/`)    |
| `src/audit/`          | Schema guard checks (A5 and grants), shared by tests, `pnpm db:verify`, the pre-deploy step and the nightly self-audit            |
| `migrations/`         | Hand-written dbmate `.sql` files: the §4 schema, then roles and grants                                                            |
| `test/`               | Vitest: MCP clients over real HTTP, auth and A11, the CLI, and the database suite on a real Postgres                              |
| `.railway/railway.ts` | Railway Infrastructure as Code: `nacredb` (Postgres 18) and its PITR bucket, `api` (pre-deploy: migrate, login, checks), `worker` |

## Docs

- [`docs/design.md`](docs/design.md): the overall design
- [`docs/slice-1-spec.md`](docs/slice-1-spec.md): the slice 1 build spec
- [`docs/tasks/`](docs/tasks/): task briefs and the workflow ([README](docs/tasks/README.md))
- [`docs/spike-mcp.md`](docs/spike-mcp.md): MCP protocol findings and client setup

## License

[Apache-2.0](LICENSE)
