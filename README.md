# Nacre

**One memory, shared by all of your AI agents.** Tell Claude Code a fact; get it back in Grok Bot with the exact quote it came from and a link to the original message.

Nacre keeps an append-only log of what your agents saw, turns it into claims whose quotes are checked in code, and serves the resulting beliefs to every agent over MCP, with provenance on every answer. Like mother-of-pearl, it is built in thin layers over time.

## Status

**v3, slice 1, task 3: tokens, auth, activity log and Origin check.** This is a ground-up reboot. What exists today:
- an `api` service (Hono) with a remote MCP endpoint at `/mcp` (Streamable HTTP, one `ping` tool) and `GET /healthz` (which checks the database);
- per-agent bearer tokens (`nacre_tok_<ulid>_<secret>`, stored as HMAC hashes) checked by one verifier for static and OAuth access tokens, an exact-match `Origin` check on `/mcp`, and the activity log (`token_create`, `token_revoke`, `token_use_denied`, `system`);
- the `nacre` CLI: `token create|revoke|list` and the deploy steps `db migrate|app-login`;
- the full slice 1 schema (spec §4) as dbmate migrations on Postgres 18 + pgvector, the `nacre_app` role, and append-only guards enforced by triggers **and** grants, with a verifier (`pnpm db:verify`);
- a placeholder `worker` service; CI with a Postgres service; a Dockerfile and Railway Infrastructure as Code.

The real tools (`remember`, `recall`, `get_provenance`), OAuth for Grok Bot (task 3b), extraction and the web app arrive over the rest of slice 1. v2 (the markdown knowledge-graph version) is preserved at the [`v2-final`](https://github.com/marcusschimizzi/nacre/tree/v2-final) tag and the [`v2`](https://github.com/marcusschimizzi/nacre/tree/v2) branch.

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

## Railway steps for task 3 (Marcus)

Agents don't run these. **Set the variables before merging:** merging deploys `api` from `main`, and the new code needs them.
1. **Variables on `api`** (dashboard → `api` → Variables). Type each secret once; nothing goes in a file.
   - `NACRE_APP_DB_PASSWORD`: `openssl rand -hex 32`. Hex, not base64, because it goes inside a URL.
   - `DATABASE_URL`: `postgresql://nacre_app:${{NACRE_APP_DB_PASSWORD}}@${{nacredb.RAILWAY_PRIVATE_DOMAIN}}:5432/${{nacredb.PGDATABASE}}`. Railway fills in the references, so the password is typed only once, and the host is `nacredb`'s private one.
   - `TOKEN_PEPPER`: `openssl rand -base64 32`. Changing it later invalidates every token.
   - `PUBLIC_API_URL`: `https://api.nacre.so`, with no path or trailing slash.
2. **Merge the PR.** The `api` deploy's pre-deploy log should show `migrate: nothing to apply`, then `app-login: nacre_app has LOGIN with the password from NACRE_APP_DB_PASSWORD`, then `75 passed, 0 failed`. A wrong password or URL fails the health check instead (`/healthz` returns 503 with `"db":"error"`). The health check runs inside Railway, so it doesn't wait for DNS.
3. **`railway config plan`, then `railway config apply`.** Expect two changes on `api`: the custom domain `api.nacre.so` is created (port 8080), and the old shared dev-token variable from task 1, which nothing reads any more, is deleted (the one destructive line). The new variables are `preserve()`, so they show no change. `Postgres-PITR` must not appear.
4. **DNS for `api.nacre.so`.** `api` → Settings → Networking now lists the domain with the records to add at `nacre.so`'s DNS host: a `CNAME` for `api` and a `TXT` for Railway's ownership check. Add both, then wait until Railway shows the domain as verified with a certificate. If the DNS host is Cloudflare, leave the records "DNS only" until the certificate has been issued.
5. **Check:** `curl https://api.nacre.so/healthz` → `"db":"ok"`.
6. **Mint Claude Code's token** inside the running container, over the private network: `railway ssh --service api`, then `node dist/cli/main.js token create --agent claude-code`. Put the printed line in `~/.nacre/token`, replacing the old dev token (it no longer works).
7. **Claude Code:** `claude mcp add --transport http nacre --scope user https://api.nacre.so/mcp --header 'Authorization: Bearer ${NACRE_TOKEN}'` (remove the old entry first), then `claude mcp get nacre` and ask a session to call `ping`. It answers with `"agent_id":"claude-code"`.
8. **The A11 checks against prod:**

   ```bash
   curl -si -X POST https://api.nacre.so/mcp | grep -iE '^HTTP|www-auth'               # 401, Bearer realm="nacre"
   curl -si -X POST "https://api.nacre.so/mcp?access_token=$NACRE_TOKEN" \
     -H "Authorization: Bearer $NACRE_TOKEN" | head -1                                  # 401
   curl -si -X POST https://api.nacre.so/mcp -H "Authorization: Bearer $NACRE_TOKEN" \
     -H 'Origin: https://evil.example' | head -1                                        # 403
   NACRE_TOKEN="$NACRE_TOKEN" pnpm mcp:smoke https://api.nacre.so/mcp                  # all ok
   ```

## Layout

| Path                  | What                                                                                                                              |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `src/api/`            | Hono app: `/mcp` (Origin check, token auth), `/healthz`; later `/v1/*` and the web app                                            |
| `src/cli/`            | The `nacre` CLI: tokens, and the deploy steps (`db migrate`, `db app-login`)                                                      |
| `src/worker/`         | Job worker (placeholder loop)                                                                                                     |
| `src/shared/`         | Config, logging, ids, tokens, the activity log, and the postgres.js client (`db/`)                                                |
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
