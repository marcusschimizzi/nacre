import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  type CheckResult,
  GUARD_TRIGGERS,
  runSchemaGuardChecks,
  TABLES,
  verifySchemaGuards,
} from '../src/audit/schema-guards.js';
import { createSql, type Sql, type TransactionSql } from '../src/shared/db/sql.js';
import { dbmate, dropDatabase, scratchDatabaseName, withDatabase } from './helpers/db.js';

const databaseUrl = inject('databaseUrl');
const adminUrl = inject('adminDatabaseUrl');

class Rollback extends Error {}

/** Runs the checks after `breakIt` in one transaction, then rolls both back. */
async function checksAfter(
  sql: Sql,
  breakIt: (tx: TransactionSql) => Promise<unknown>,
): Promise<CheckResult[]> {
  let results: CheckResult[] = [];
  await expect(
    sql.begin(async (tx) => {
      await breakIt(tx);
      results = await runSchemaGuardChecks(tx);
      throw new Rollback();
    }),
  ).rejects.toBeInstanceOf(Rollback);
  return results;
}

const failed = (results: CheckResult[]) => results.filter((r) => !r.ok).map((r) => r.name);

describe.skipIf(!databaseUrl)('database: migrations, roles and append-only guards (A5)', () => {
  let sql: Sql;
  beforeAll(() => {
    sql = createSql(databaseUrl, { max: 2 });
  });
  afterAll(() => sql?.end());

  it('migrations create the 18 §4 tables plus schema_migrations', async () => {
    const rows = await sql<{ relname: string }[]>`
      SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'`;
    expect(rows.map((r) => r.relname).sort()).toEqual([...TABLES, 'schema_migrations'].sort());
  });

  it('every schema guard check passes', async () => {
    const results = await verifySchemaGuards(sql);
    expect(failed(results)).toEqual([]);
    // One line per table grant and per trigger, plus the behavior checks.
    expect(results.length).toBeGreaterThanOrEqual(
      TABLES.length + Object.keys(GUARD_TRIGGERS).length + 40,
    );
  });

  it('leaves no rows behind', async () => {
    const counts = () =>
      sql<{ t: string; n: number }[]>`
        SELECT t, (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM %I', t), false, true, '')))[1]::text::int AS n
        FROM unnest(${sql.array([...TABLES])}::text[]) AS t`;
    const before = await counts();
    await verifySchemaGuards(sql);
    expect(await counts()).toEqual(before);
  });

  describe('the checks bite', () => {
    it('a dropped append-only trigger fails by name', async () => {
      const results = await checksAfter(sql, (tx) => tx`DROP TRIGGER events_append_only ON events`);
      expect(failed(results)).toEqual(
        expect.arrayContaining([
          'triggers: events_append_only on events',
          'owner: UPDATE events blocked by trigger (P0001)',
          'owner: DELETE events blocked by trigger (P0001)',
        ]),
      );
    });

    it('a stray DELETE grant fails by name', async () => {
      const results = await checksAfter(sql, (tx) => tx`GRANT DELETE ON claims TO nacre_app`);
      expect(failed(results)).toEqual(['grants: claims']);
    });

    it('a new table without grants fails by name', async () => {
      const results = await checksAfter(sql, (tx) => tx`CREATE TABLE a5_new_table (id int)`);
      expect(failed(results)).toEqual(['grants: a5_new_table']);
    });

    it('a disabled trigger fails by name', async () => {
      const results = await checksAfter(
        sql,
        (tx) => tx`ALTER TABLE claims DISABLE TRIGGER claims_status_only`,
      );
      expect(failed(results)).toEqual(
        expect.arrayContaining([
          'triggers: claims_status_only on claims',
          'owner: claims text edit blocked (P0001)',
        ]),
      );
    });
  });
});

describe.skipIf(!adminUrl)('database: down migrations', () => {
  const name = scratchDatabaseName('down');
  const url = adminUrl ? withDatabase(adminUrl, name) : '';
  afterAll(() => (adminUrl ? dropDatabase(adminUrl, name) : undefined));

  it('roll back to empty (keeping the cluster-wide role), then migrate up again', async () => {
    await dbmate(url, 'up');
    await dbmate(url, 'rollback');
    await dbmate(url, 'rollback');

    const sql = createSql(url, { max: 1 });
    try {
      const tables = await sql<{ relname: string }[]>`
        SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'`;
      expect(tables.map((t) => t.relname)).toEqual(['schema_migrations']);
      const leftovers = await sql`
        SELECT 1 FROM pg_proc WHERE proname LIKE 'nacre\_%' AND pronamespace = 'public'::regnamespace
        UNION ALL SELECT 1 FROM pg_extension WHERE extname = 'vector'`;
      expect(leftovers).toHaveLength(0);
      expect(await sql`SELECT 1 FROM pg_roles WHERE rolname = 'nacre_app'`).toHaveLength(1);
    } finally {
      await sql.end();
    }

    await dbmate(url, 'up');
    expect(await dbmate(url, 'status')).toContain('Pending: 0');
  });
});
