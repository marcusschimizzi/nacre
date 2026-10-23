# Migrations

Hand-written [dbmate](https://github.com/amacneil/dbmate) `.sql` files (`-- migrate:up` / `-- migrate:down`), applied in filename order, each in its own transaction:

| File                       | What                                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `20261023000000_init.sql`  | The spec §4 DDL, verbatim: `vector`, the guard functions, the 18 tables, indexes, append-only triggers and the `personal` scope |
| `20261023000100_roles.sql` | The `nacre_app` role (created `NOLOGIN`, no password) and its grants                                                            |

Scripts (all read `MIGRATION_DATABASE_URL`, an **owner** URL, from the environment or `.env`): `pnpm db:migrate`, `pnpm db:status`, `pnpm db:rollback` (the latest migration only), and `pnpm db:verify` (the A5 and grant checks in `src/audit/schema-guards.ts`; one PASS/FAIL line each, exit 1 on any FAIL, no rows left behind).

Rules for new migrations:
- Create one with `pnpm exec dbmate --migrations-dir ./migrations new <name>`. Never edit a migration that has been applied anywhere; add a new one.
- **Migrations run as the database owner.** There is no separate migrator role (decided Oct 23, 2026). `nacre_app` owns nothing and gets no `DELETE`, `TRUNCATE` or `CREATE`.
- **Only `api` migrates** (its Railway pre-deploy step). dbmate takes no lock on Postgres: two concurrent `up` runs leave the schema correct (each migration is one transaction), but the loser exits with an error, which would fail its deploy. So the worker must not run migrations too. **Task 5, when the worker first uses the database:** at startup the worker waits, with backoff, until `max(version)` in `schema_migrations` matches the newest file in the image's `migrations/`.
- **A new table needs its grants in the same migration.** The grant-matrix check covers every table in `public`, so a table without `SELECT, INSERT` for `nacre_app`, or with an unplanned `UPDATE` or `DELETE`, fails CI. Add new `UPDATE` columns to `COLUMN_UPDATES` in `src/audit/schema-guards.ts` in the same PR; a new guard trigger goes in `GUARD_TRIGGERS`.
- `down` drops what `up` created. The `nacre_app` role is cluster-wide, so `down` revokes its grants but leaves the role.

## Railway steps (Marcus)

Agents never run these. `.railway/railway.ts` declares the database (`nacredb`, Railway's `postgres-ssl:18` image with pgvector 0.8) and gives `api` the owner URL as `MIGRATION_DATABASE_URL` plus a pre-deploy step, `npm run db:migrate`.
1. **Plan.** `railway link` (the "Nacre" project), then `railway config plan`. Check that it creates `nacredb`, updates `api` and `worker`, and deletes **only** what the §12.1 reset removes (the old Postgres and the empty bucket). If it would delete anything else, stop.
2. **Apply.** `railway config apply`. When `api` next deploys from `main`, its pre-deploy log shows `Applied: 20261023000000_init.sql` and `Applied: 20261023000100_roles.sql`. A failed migration stops that deploy, and the previous version keeps running; dbmate runs each migration in a transaction, so nothing is left half-applied.
3. **Backups.** Turn on Railway's backups for `nacredb` (and point-in-time recovery if the plan has it), per spec §12.1.
4. **Check the version and extension.** Open psql as the admin user (`railway connect nacredb`) and run:

   ```sql
   SELECT current_setting('server_version_num')::int >= 180000 AS pg18, extversion
   FROM pg_extension WHERE extname = 'vector';   -- expect: t | 0.8.x
   ```

   If the migrations haven't run yet, `CREATE EXTENSION IF NOT EXISTS vector;` must succeed first.
5. **Give `nacre_app` a login**, in the same psql session. The password is typed at the prompt, never written to a file or shell history:

   ```sql
   ALTER ROLE nacre_app LOGIN;
   \password nacre_app
   ```

   Keep the password for task 3, which adds the runtime `DATABASE_URL` (as `nacre_app`) to `api` and `worker` as a Railway variable.
6. **Verify.** From a checkout of `main`, run the same checks CI runs, against the deployed database. The URL comes from Railway's variables and is never printed:

   ```bash
   railway run --service nacredb -- sh -c 'MIGRATION_DATABASE_URL="$DATABASE_PUBLIC_URL" pnpm db:verify'
   ```

   Expect every line `PASS` and exit code 0. If the connection is refused over SSL, append `?sslmode=require` to the URL inside the quotes.

From then on, **merging a migration to `main` runs it** on the next `api` deploy.
