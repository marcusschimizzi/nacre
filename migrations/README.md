# Migrations

Hand-written [dbmate](https://github.com/amacneil/dbmate) `.sql` files (`-- migrate:up` / `-- migrate:down`), applied in filename order, each in its own transaction:

| File                       | What                                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `20261023000000_init.sql`  | The spec §4 DDL, verbatim: `vector`, the guard functions, the 18 tables, indexes, append-only triggers and the `personal` scope |
| `20261023000100_roles.sql` | The `nacre_app` role (created `NOLOGIN`, no password) and its grants                                                            |

Scripts (all read `MIGRATION_DATABASE_URL`, an **owner** URL, from the environment or `.env`): `pnpm db:migrate`, `pnpm db:status`, `pnpm db:rollback` (the latest migration only), `pnpm db:verify` (the A5 and grant checks in `src/audit/schema-guards.ts`; one PASS/FAIL line each, exit 1 on any FAIL, no rows left behind), and `pnpm db:predeploy` (migrate, then the compiled checks: what Railway runs; needs `pnpm build` first).

Rules for new migrations:
- Create one with `pnpm exec dbmate --migrations-dir ./migrations new <name>`. Never edit a migration that has been applied anywhere; add a new one.
- **Migrations run as the database owner.** There is no separate migrator role (decided Oct 23, 2026). `nacre_app` owns nothing and gets no `DELETE`, `TRUNCATE` or `CREATE`.
- **Only `api` migrates** (its Railway pre-deploy step). dbmate takes no lock on Postgres: two concurrent `up` runs leave the schema correct (each migration is one transaction), but the loser exits with an error, which would fail its deploy. So the worker must not run migrations too. **Task 5, when the worker first uses the database:** at startup the worker waits, with backoff, until `max(version)` in `schema_migrations` matches the newest file in the image's `migrations/`.
- **A new table needs its grants in the same migration.** The grant-matrix check covers every table in `public`, so a table without `SELECT, INSERT` for `nacre_app`, or with an unplanned `UPDATE` or `DELETE`, fails CI. Add new `UPDATE` columns to `COLUMN_UPDATES` in `src/audit/schema-guards.ts` in the same PR; a new guard trigger goes in `GUARD_TRIGGERS`.
- `down` drops what `up` created. The `nacre_app` role is cluster-wide, so `down` revokes its grants but leaves the role.

## Railway

`.railway/railway.ts` declares the database (`nacredb`, Railway's `postgres-ssl:18` image with pgvector 0.8) and gives `api` the owner URL as `MIGRATION_DATABASE_URL`. Only Marcus applies it (done Oct 23, 2026: plan, apply, backups on). The database is **private**: nothing below needs public access, so leave its TCP proxy off.

**Every `api` deploy** runs `npm run db:predeploy` before the new version starts, inside Railway's private network and as the database owner:
1. `dbmate up` applies any pending migrations (each in its own transaction). Merging a migration to `main` runs it.
2. `node dist/audit/verify-cli.js` runs the A5 and grant checks: one `PASS`/`FAIL` line each in the deploy log, in a transaction that is rolled back. The only trace is that the `jobs` id sequence advances by one.

If either step fails, Railway doesn't proceed with the deploy, and the previous version keeps serving. Railway puts no time limit on pre-deploy commands by default: set **Pre-deploy Timeout** on `api` (Settings, once the command shows there) to about 300 seconds, so a hung run fails rather than holding the deploy.

**Run the checks on demand** inside the running `api` container, over the private network, with the URL it already has:

```bash
railway ssh --service api -- node dist/audit/verify-cli.js
```

(`railway ssh` needs an SSH key registered with Railway; the CLI offers to add one the first time.) For a psql shell, `railway connect nacredb` tunnels over SSH when the database has no public proxy.

**Not yet:** `nacre_app` stays `NOLOGIN` until task 3, which is the first code that connects as it. Task 3 can set its password from a Railway variable in this same pre-deploy step, so nobody needs to open psql.
