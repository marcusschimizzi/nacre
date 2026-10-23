# Task 02: schema, roles and append-only triggers

*Brief v1, Oct 23, 2026. Paste this whole file into Claude Code or Codex, run from an up-to-date clone of `github.com/marcusschimizzi/nacre` (`main` at or after `07973a9`, the task 01 merge). Marcus reviews the PR.*

## Context
Nacre v3 is Marcus's personal AI memory platform: **one memory shared by all his agents**. Task 01 left a TypeScript scaffold: Node 24 (`.node-version`), pnpm, Hono, `@modelcontextprotocol/server` v2 at `/mcp` with one `ping` tool, a placeholder worker, Vitest, Biome, one Dockerfile for both services, CI in `.github/workflows/ci.yml`, and Railway IaC in `.railway/railway.ts` (`api` and `worker` only). There is no database yet. This is **slice 1, task 2**: the spec §4 schema as dbmate migrations on **Postgres 18 + pgvector**, the `nacre_app` role and its grants, the append-only triggers, and the **A5** tests. Nothing else in slice 1 is in scope.

**Read first** (Marcus puts these files in the working tree; commit them under `docs/` in this PR, replacing the older copies):
- `docs/slice-1-spec.md` **v0.2.6** (the repo has v0.2.4): §4 in full (the DDL *is* the migration), §12.1–12.2, §13.1 (nightly self-audit), §14 A5, §15 (tasks 2, 3, 3b).
- `docs/design.md` v0.2.4: skim principle 1 ("never throw anything away").
- `docs/tasks/task-02-schema-roles-and-triggers.md` (this file) and `docs/tasks/README.md` (the workflow).

If this brief and the spec disagree, follow the spec and say so in the PR.

## What to do

### 1. Migrations (spec §4, §12.2)
- Add **dbmate** (the `dbmate` npm package, so the binary comes from the lockfile) and **postgres.js** (`postgres`). Put the client in `src/shared/db/` (a small `createSql(url)` and nothing more). Don't wire it into api or worker startup; task 3 does that.
- Write the **whole §4 DDL** as plain dbmate `.sql` files in `migrations/` (`-- migrate:up` / `-- migrate:down`): extension, guard functions, all 18 tables, indexes, triggers and the `personal` seed row. Transcribe it as written; any change you need (a bug, a PG18 difference) goes in the PR under "Deviations". Splitting into an init file and a roles file is fine.
- **Ownership of the token and OAuth schema.** §15 gives task 2 "Migrations (§4)", and `events.token_id` and `activity_log.token_id` reference `agent_tokens`, so **this task creates `agent_tokens` with all its OAuth columns, `oauth_clients` and `oauth_auth_codes`, exactly as in §4.** Task 3 owns the token format, the CLI and the verifier; task 3b owns the OAuth endpoints. Neither adds core tables.
- `down` drops what `up` created, except the cluster-wide role (say so in a comment).
- Scripts: `db:migrate` (`dbmate up`), `db:rollback`, `db:status`, all with `--migrations-dir ./migrations --no-dump-schema --wait` and reading **`MIGRATION_DATABASE_URL`** (dbmate's `--env` flag). Copy `migrations/` into the runtime image so a deploy can run them without network installs.

### 2. Roles and grants (§4 "Roles")
- Create **`nacre_app`** idempotently (`DO $$ … IF NOT EXISTS … CREATE ROLE nacre_app NOLOGIN`). **No password anywhere in the repo.** Marcus gives it `LOGIN` and a password on Railway himself (step 4).
- Grant exactly what §4 lists: `SELECT, INSERT` on every §4 table; `UPDATE` on `extraction_runs` and `jobs`; column-level `UPDATE` only on `agent_tokens (last_used_at, revoked_at, rotated_at)`, `oauth_clients (approved_at, disabled_at)`, `oauth_auth_codes (used_at)`, `claims (status, status_reason)` and `belief_versions (expired_at)`; `USAGE` on the `jobs` sequence. **No `DELETE` and no `TRUNCATE` on any table** (TRUNCATE skips row triggers). No `CREATE` on the schema; `nacre_app` owns nothing.
- `claims` gets `status_reason` too because the §4 trigger allows it; the spec's role comment says only `status`. Note it in the PR.
- **Migrations run as the database owner** (Railway's admin user locally and in prod). Don't create a separate `nacre_migrator` login role in this task: list that as a deviation and an open question. Slice 8's `nacre_purge` is out of scope.

### 3. A5 tests, and a reusable verifier
- Tests run against a **real local Postgres 18 + pgvector** (`pgvector/pgvector:pg18`), reached through **`TEST_DATABASE_URL`** (an admin URL). Locally: `docker run -d --name nacre-pg -e POSTGRES_HOST_AUTH_METHOD=trust -p 54329:5432 pgvector/pgvector:pg18`. In CI: a `services:` container with the same image and a health check. A Vitest `globalSetup` creates a fresh database, runs `dbmate up` once and drops it afterwards. If `TEST_DATABASE_URL` is unset, DB tests **skip with a clear message locally and fail when `CI` is set**. (Spec §12.2 suggests Testcontainers; a plain service container is simpler and is what Marcus chose. Note it.)
- Write the A5 checks once, as a function that takes an admin connection, inserts minimal fixtures and runs every check **inside a transaction that always rolls back** (savepoints per expected failure). Use it in the Vitest suite and in **`pnpm db:verify`** (reads `MIGRATION_DATABASE_URL`, prints one PASS/FAIL line per check, exits non-zero on any FAIL), so Marcus can run the same checks on Railway. It must leave no rows behind.
- Checks, each asserting the **SQLSTATE**, not just "it threw":
  - **As `nacre_app` (`SET ROLE`), the grant layer:** `UPDATE` and `DELETE` on `events`, `event_content`, `evidence_spans`, `activity_log`, `belief_version_claims` and `model_calls` fail with `42501`. `TRUNCATE` on any table fails with `42501`. `UPDATE belief_versions SET expired_at = now()` succeeds once, and a second close fails with `P0001` (the trigger). Any other `belief_versions` column fails with `42501`. `UPDATE claims SET status = …` succeeds; `UPDATE claims SET text = …` fails with `42501`. `INSERT` into `jobs` works (sequence grant). `ALTER TABLE events DISABLE TRIGGER ALL` fails.
  - **As the owner, the trigger layer** (proves the triggers work even without the grants): the same `UPDATE`/`DELETE` on the append-only tables fail with `P0001` and the §4 message (`table events is append-only (UPDATE blocked)`); a claim `text` edit fails, a `status` change succeeds; a second `expired_at` close and any other `belief_versions` edit fail; `DELETE` on `extraction_runs` fails.
  - **Constraints and extension:** a duplicate `(agent_id, client_event_id)` fails with `23505`; `server_version_num` ≥ 180000; `vector` is installed at 0.8 or later, and a 1,536-dim insert plus an `ORDER BY embedding <=> …` query works.
  - **Grant matrix:** for every table in `public` except `schema_migrations`, `nacre_app` has `SELECT` and `INSERT`, never `DELETE` or `TRUNCATE`, and `UPDATE` exactly as in step 2. Every append-only trigger from §4 exists and is enabled. This makes a future table without grants, or a stray `DELETE` grant, fail CI.

### 4. Railway, declared but not applied
- **Declare Postgres in `.railway/railway.ts`** so `railway config apply` never proposes deleting the database. Aim for Postgres 18 with pgvector: Railway's `postgres-ssl:18` image ships pgvector 0.8 (spec §12.1). If the `postgres()` helper can't pin the major version, use the SDK's `database(name, 'postgres', { image: … })`, or keep `postgres()` and say in a comment that Marcus checks the version at apply time.
- On the `api` service: `MIGRATION_DATABASE_URL` referencing the database's own `DATABASE_URL` (`db.env.DATABASE_URL`), and a `preDeployCommand` that runs the migrations. Don't add the runtime `DATABASE_URL` for `nacre_app` yet: it needs the password Marcus sets, and task 3 is the first code to use it. Update the file's header warning to match.
- Add to `migrations/README.md` a short **"Railway steps (Marcus)"** section: run `railway config plan` and check that it deletes nothing he wants; apply; check the version and `CREATE EXTENSION vector`; give `nacre_app` `LOGIN` and a password with `\password`, never in a file; run `pnpm db:verify` against the deployed database. Point out that once the IaC is applied and `api` deploys from `main`, merging a migration runs it.
- Update `.env.example` (`MIGRATION_DATABASE_URL`, `TEST_DATABASE_URL`, `DATABASE_URL` for later, with placeholder values only) and the README's run-locally section.

## Out of scope
- **Running anything against Railway**: no `railway config plan`, `apply`, `up`, deploy, variable change or reset. Marcus does every Railway step himself. Also no DNS.
- Token creation, the auth middleware, the activity-log helper and the §13.2 `system` entry for migrations (task 3); OAuth endpoints (task 3b); ingest, the worker, recall and everything later.
- Seeding `agents` rows (task 3 creates agents with their tokens; tests insert their own fixtures).
- Any secret in the repo, including history and test fixtures. Local Postgres uses `trust` auth, so there's no password to commit.

## Done when (list each check and its result in the PR description)
- [ ] With the local container up and `TEST_DATABASE_URL` set: `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build` pass. CI passes with the Postgres service container, and the A5 tests ran there and were not skipped (link the run, paste the test count).
- [ ] Fresh database: `pnpm db:migrate` applies every migration; a second run applies nothing; `pnpm db:rollback && pnpm db:migrate` works. `psql "$MIGRATION_DATABASE_URL" -c '\dt'` lists the 18 §4 tables plus `schema_migrations`.
- [ ] `psql … -Atc "SELECT current_setting('server_version_num')::int >= 180000, extversion FROM pg_extension WHERE extname = 'vector'"` prints `t|0.8.x`.
- [ ] Grants, pasted: `SELECT table_name, string_agg(privilege_type, ',' ORDER BY privilege_type) FROM information_schema.role_table_grants WHERE grantee = 'nacre_app' GROUP BY 1 ORDER BY 1;` shows `INSERT,SELECT` for every table, `INSERT,SELECT,UPDATE` for `extraction_runs` and `jobs` only, and no `DELETE` or `TRUNCATE` anywhere. Column-level `UPDATE` grants (from `information_schema.column_privileges`, leaving out those two tables) are exactly the nine columns in step 2.
- [ ] `pnpm db:verify` against the local database prints PASS for every check, exits 0, and leaves every table's row count unchanged (show `SELECT count(*) FROM events` before and after).
- [ ] **The tests bite:** in a scratch database, `DROP TRIGGER events_append_only ON events` makes `pnpm db:verify` exit non-zero and name that check; `GRANT DELETE ON claims TO nacre_app` does the same. Paste both outputs.
- [ ] `.railway/railway.ts` declares Postgres and the `api` pre-deploy migration, typechecks, and was **not applied**. `migrations/README.md` has the Railway steps.
- [ ] No secrets: `git grep -niE 'password|postgres(ql)?://[^@[:space:]]*:[^@[:space:]]*@'` shows only placeholders, docs and `\password`; no migration contains a password.
- [ ] `docs/` holds spec v0.2.6, design v0.2.4, the tasks README and this brief.
- [ ] PR opened from `task-02-schema-roles-and-triggers` to `main`, titled **"Task 02: schema, roles and append-only triggers"**, with a description that follows `docs/tasks/README.md`.

## Conventions
- Commits: Conventional Commits (`docs:`, `feat(db):`, `test(db):`, `ci:`, `chore(railway):`), small and readable. The docs refresh is its own commit.
- PR: one task per PR. In the description, name the task, summarize the change, list every acceptance check with pass or fail plus evidence, add "Deviations from the brief/spec" (at least: no `nacre_migrator` role, `status_reason` grant, service container instead of Testcontainers, anything changed in the §4 DDL), and end with "Open questions for Marcus". Don't merge; Marcus reviews.
