# Nacre

**One memory, shared by all of your AI agents.** Tell Claude Code a fact; get it back in Grok Bot with the exact quote it came from and a link to the original message.

Nacre keeps an append-only log of what your agents saw, turns it into claims whose quotes are checked in code, and serves the resulting beliefs to every agent over MCP, with provenance on every answer. Like mother-of-pearl, it is built in thin layers over time.

## Status

**v3, slice 1, task 2: schema, roles and append-only triggers.** This is a ground-up reboot. What exists today:
- an `api` service (Hono) with a remote MCP endpoint at `/mcp` (Streamable HTTP, one `ping` tool, bearer-token auth) and `GET /healthz`;
- a placeholder `worker` service;
- the full slice 1 schema (spec §4) as dbmate migrations on Postgres 18 + pgvector, the `nacre_app` role, and append-only guards enforced by triggers **and** grants, with a verifier (`pnpm db:verify`);
- CI (with a Postgres service), a Dockerfile and Railway Infrastructure as Code (not deployed).

The real tools (`remember`, `recall`, `get_provenance`), tokens, extraction and the web app arrive over the rest of slice 1. v2 (the markdown knowledge-graph version) is preserved at the [`v2-final`](https://github.com/marcusschimizzi/nacre/tree/v2-final) tag and the [`v2`](https://github.com/marcusschimizzi/nacre/tree/v2) branch.

## Run it locally

Needs Node 24 (see `.node-version`) and pnpm, pinned through `packageManager` (`corepack enable` picks the right version).

```bash
pnpm install
cp .env.example .env          # then set NACRE_DEV_TOKEN, e.g. $(openssl rand -base64 32)
pnpm dev                      # api on http://localhost:3000
pnpm dev:worker               # placeholder worker, in another terminal

curl localhost:3000/healthz
```

Connect Claude Code to the local server (see [`docs/spike-mcp.md`](docs/spike-mcp.md)):

```bash
export NACRE_TOKEN=<the same value as NACRE_DEV_TOKEN>
claude mcp add --transport http nacre --scope user http://localhost:3000/mcp \
  --header 'Authorization: Bearer ${NACRE_TOKEN}'
claude mcp get nacre
```

### Database

Postgres 18 with pgvector, in Docker. Trust auth, so there is no password to keep anywhere:

```bash
docker run -d --name nacre-pg -e POSTGRES_HOST_AUTH_METHOD=trust -p 54329:5432 pgvector/pgvector:pg18

# in .env (dbmate, the db: scripts and the test setup read it):
MIGRATION_DATABASE_URL=postgres://postgres@localhost:54329/nacre_dev?sslmode=disable
TEST_DATABASE_URL=postgres://postgres@localhost:54329/postgres?sslmode=disable

pnpm db:migrate     # create the database if needed and apply migrations/ (dbmate)
pnpm db:status      # applied and pending migrations
pnpm db:rollback    # undo the latest migration
pnpm db:verify      # append-only and grant checks (A5); prints PASS/FAIL, leaves no rows
```

If port 54329 is taken, map another one and use it in both URLs. `pnpm test` creates, migrates and drops its own scratch database through `TEST_DATABASE_URL`; without it the database tests are skipped locally (CI requires them). Nothing connects as `nacre_app` yet: task 3 adds the runtime `DATABASE_URL`. On Railway, every `api` deploy runs the migrations and then these checks first (`pnpm db:predeploy`; see [`migrations/README.md`](migrations/README.md)).

Other scripts: `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, then `pnpm start:api` / `pnpm start:worker`.

## Layout

| Path                  | What                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------- |
| `src/api/`            | Hono app: `/mcp`, `/healthz`; later `/v1/*` and the web app                                       |
| `src/worker/`         | Job worker (placeholder loop)                                                                     |
| `src/shared/`         | Config, logging, build info, and the postgres.js client (`db/`)                                   |
| `src/audit/`          | Schema guard checks (A5 and grants), shared by tests, `pnpm db:verify` and the nightly self-audit |
| `migrations/`         | Hand-written dbmate `.sql` files: the §4 schema, then roles and grants                            |
| `test/`               | Vitest: MCP clients over real HTTP, and the database suite on a real Postgres                     |
| `.railway/railway.ts` | Railway Infrastructure as Code: Postgres 18, `api` (runs migrations before deploy), `worker`      |

## Docs

- [`docs/design.md`](docs/design.md): the overall design
- [`docs/slice-1-spec.md`](docs/slice-1-spec.md): the slice 1 build spec
- [`docs/tasks/`](docs/tasks/): task briefs and the workflow ([README](docs/tasks/README.md))
- [`docs/spike-mcp.md`](docs/spike-mcp.md): MCP protocol findings and client setup

## License

[Apache-2.0](LICENSE)
