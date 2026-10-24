import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { logActivity } from '../shared/activity.js';
import { setAppLogin } from '../shared/db/app-role.js';
import { createSql, type Sql } from '../shared/db/sql.js';

// Resolved from this file, so the same paths work from src/cli (tsx) and dist/cli (the image).
const DBMATE = fileURLToPath(new URL('../../node_modules/.bin/dbmate', import.meta.url));
const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));

/**
 * `nacre db migrate`: `dbmate up`, then one `system` activity entry listing what it applied (spec
 * §13.2), or none when nothing was pending. Runs as the database owner (MIGRATION_DATABASE_URL).
 */
export async function migrate(ownerUrl: string): Promise<string[]> {
  await dbmate(ownerUrl, 'wait');
  const before = await appliedVersions(ownerUrl);
  await dbmate(ownerUrl, 'up');
  const sql = createSql(ownerUrl, { max: 1 });
  try {
    const after = await versions(sql);
    const applied = after.filter((v) => !before.has(v));
    if (applied.length) {
      await logActivity(sql, {
        kind: 'system',
        actor: 'system',
        targetKind: 'schema',
        reason: 'migrate',
        details: { step: 'migrate', applied },
      });
      console.log(`migrate: applied ${applied.join(', ')}; system activity entry written`);
    } else {
      console.log('migrate: nothing to apply');
    }
    return applied;
  } finally {
    await sql.end();
  }
}

/**
 * `nacre db app-login`: when NACRE_APP_DB_PASSWORD is set, give nacre_app LOGIN with it (every
 * deploy, so rotating the variable rotates the password); otherwise leave the role alone.
 */
export async function appLogin(ownerUrl: string, password: string | undefined): Promise<void> {
  if (!password) {
    console.log('app-login: NACRE_APP_DB_PASSWORD is not set; nacre_app left unchanged');
    return;
  }
  const sql = createSql(ownerUrl, { max: 1 });
  try {
    await setAppLogin(sql, password);
    console.log('app-login: nacre_app has LOGIN with the password from NACRE_APP_DB_PASSWORD');
  } finally {
    await sql.end();
  }
}

function dbmate(url: string, command: 'wait' | 'up'): Promise<void> {
  const args = [
    '--env',
    'MIGRATION_DATABASE_URL',
    '--migrations-dir',
    MIGRATIONS_DIR,
    '--no-dump-schema',
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(DBMATE, [...args, ...(command === 'up' ? ['--wait', 'up'] : ['wait'])], {
      env: { ...process.env, MIGRATION_DATABASE_URL: url },
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`dbmate ${command} exited ${code}`)),
    );
  });
}

async function appliedVersions(url: string): Promise<Set<string>> {
  const sql = createSql(url, { max: 1 });
  try {
    return new Set(await versions(sql));
  } catch (err) {
    // A database dbmate hasn't created yet, or one without schema_migrations: nothing applied.
    const code = (err as { code?: string }).code;
    if (code === '3D000' || code === '42P01') return new Set();
    throw err;
  } finally {
    await sql.end();
  }
}

async function versions(sql: Sql): Promise<string[]> {
  const rows = await sql<
    { version: string }[]
  >`SELECT version FROM schema_migrations ORDER BY version`;
  return rows.map((r) => r.version);
}
