import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { createSql } from '../../src/shared/db/sql.js';

const run = promisify(execFile);
const dbmateBin = resolve('node_modules/.bin/dbmate');

/** `url` with its database name swapped for `database`. */
export function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.href;
}

export function scratchDatabaseName(label: string): string {
  return `nacre_test_${label}_${randomBytes(4).toString('hex')}`;
}

/** Runs dbmate exactly as `pnpm db:*` does, against `url` (dbmate creates the database on `up`). */
export async function dbmate(url: string, command: 'up' | 'rollback' | 'status'): Promise<string> {
  const { stdout } = await run(
    dbmateBin,
    ['--url', url, '--migrations-dir', './migrations', '--no-dump-schema', '--wait', command],
    { env: { ...process.env, MIGRATION_DATABASE_URL: '' } },
  );
  return stdout;
}

export async function dropDatabase(adminUrl: string, database: string): Promise<void> {
  const sql = createSql(adminUrl, { max: 1 });
  try {
    await sql`DROP DATABASE IF EXISTS ${sql(database)} WITH (FORCE)`;
  } finally {
    await sql.end();
  }
}
