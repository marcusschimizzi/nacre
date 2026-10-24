# Migrations

Hand-written [dbmate](https://github.com/amacneil/dbmate) `.sql` files (`-- migrate:up` / `-- migrate:down`), applied in filename order, each in its own transaction:

| File                                                | What                                                                                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `20261023000000_init.sql`                           | The spec §4 DDL, verbatim: `vector`, the guard functions, the 18 tables, indexes, append-only triggers and the `personal` scope |
| `20261023000100_roles.sql`                          | The `nacre_app` role (created `NOLOGIN`, no password) and its grants                                                            |
| `20261024120000_grant_schema_migrations_select.sql` | `SELECT` on `schema_migrations` for `nacre_app`, read-only, for the worker's startup wait (task 5)                              |

Scripts (all read `MIGRATION_DATABASE_URL`, an **owner** URL, from the environment or `.env`):
- `pnpm db:migrate`: `nacre db migrate`, which runs `dbmate up` and writes one `system` activity entry (actor `system`, `details.applied` = the versions) when it applied something, and none when nothing was pending.
- `pnpm db:status`, `pnpm db:rollback` (the latest migration only): plain dbmate.
- `pnpm db:verify`: the A5 and grant checks in `src/audit/schema-guards.ts`. One PASS/FAIL line each, exit 1 on any FAIL, no rows left behind.
- `pnpm db:predeploy`: what Railway runs, from the compiled `dist/` (run `pnpm build` first). `nacre db migrate`, then `nacre db app-login`, then the checks.

Rules for new migrations:
- Create one with `pnpm exec dbmate --migrations-dir ./migrations new <name>`. Never edit a migration that has been applied anywhere; add a new one.
- **Migrations run as the database owner.** There is no separate migrator role (decided Oct 23, 2026). `nacre_app` owns nothing and gets no `DELETE`, `TRUNCATE` or `CREATE`.
- **Only `api` migrates** (its Railway pre-deploy step). dbmate takes no lock on Postgres: two concurrent `up` runs leave the schema correct (each migration is one transaction), but the loser exits with an error, which would fail its deploy. So the worker must not run migrations too. **The worker waits instead** (`src/worker/schema-wait.ts`, task 5): at startup it reads `max(version)` from `schema_migrations` and starts its loop only once that is at least the newest file in its own image's `migrations/` (a database that is ahead is fine). Until then it retries with backoff (1 s doubling to 30 s), treating permission denied, a missing table and connection errors as "not yet", never exits on its own, and stops cleanly on `SIGTERM`.
- **`nacre_app` has `SELECT` on `schema_migrations` only for that wait** (migration `20261024120000`). The `grants: schema_migrations read-only` check keeps it read-only: `SELECT`, and none of `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `REFERENCES` or `TRIGGER`. The table-by-table grant matrix still leaves `schema_migrations` out.
- **A new table needs its grants in the same migration.** The grant-matrix check covers every table in `public`, so a table without `SELECT, INSERT` for `nacre_app`, or with an unplanned `UPDATE` or `DELETE`, fails CI. Add new `UPDATE` columns to `COLUMN_UPDATES` in `src/audit/schema-guards.ts` in the same PR; a new guard trigger goes in `GUARD_TRIGGERS`.
- `down` drops what `up` created. The `nacre_app` role is cluster-wide, so `down` revokes its grants but leaves the role.

## Railway

`.railway/railway.ts` declares the database (`nacredb`, Railway's `postgres-ssl:18` image with pgvector 0.8) and gives `api` the owner URL as `MIGRATION_DATABASE_URL`. Only Marcus applies it (done Oct 23, 2026: plan, apply, backups on). The database is **private**: nothing below needs public access, so leave its TCP proxy off.

**Every `api` deploy** runs `npm run db:predeploy` before the new version starts, inside Railway's private network and as the database owner:
1. `node dist/cli/main.js db migrate`: `dbmate up` applies any pending migrations (each in its own transaction), plus a `system` activity entry when something was applied. Merging a migration to `main` runs it.
2. `node dist/cli/main.js db app-login`: when `NACRE_APP_DB_PASSWORD` is set, `ALTER ROLE nacre_app WITH LOGIN PASSWORD` with a SCRAM-SHA-256 verifier computed in Node, the way psql's `\password` does. The password itself is never sent to Postgres or logged, and the role is set on every deploy, so rotating the variable rotates the login. When it is unset, the role is left alone (one line says so).
3. `node dist/audit/verify-cli.js` runs the A5 and grant checks: one `PASS`/`FAIL` line each in the deploy log, in a transaction that is rolled back. The only trace is that the `jobs` id sequence advances by one. It still passes with `LOGIN` on.

If any step fails, Railway doesn't proceed with the deploy, and the previous version keeps serving. Railway puts no time limit on pre-deploy commands by default: set **Pre-deploy Timeout** on `api` (Settings, once the command shows there) to about 300 seconds, so a hung run fails rather than holding the deploy.

**Run the checks on demand** inside the running `api` container, over the private network, with the URL it already has:

```bash
railway ssh --service api -- node dist/audit/verify-cli.js
```

(`railway ssh` needs an SSH key registered with Railway; the CLI offers to add one the first time.) For a psql shell, `railway connect nacredb` tunnels over SSH when the database has no public proxy.

**`nacre_app`'s login** comes from `NACRE_APP_DB_PASSWORD` in step 2, so nobody opens psql to set it. The api connects with `DATABASE_URL` as `nacre_app` (README, "Railway steps for task 3").
