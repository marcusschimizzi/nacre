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
 *
 * dbmate commits before the entry is written, so a failed insert would lose it. The entry also
 * lists, as `unrecorded`, applied versions that no earlier entry names, so the next run fills the
 * gap (and the first run after task 3 records the task 2 migrations, applied before this existed).
 */
export async function migrate(ownerUrl: string): Promise<string[]> {
  await dbmate(ownerUrl, 'wait');
  const before = await appliedVersions(ownerUrl);
  await dbmate(ownerUrl, 'up');
  const sql = createSql(ownerUrl, { max: 1 });
  try {
    const after = await versions(sql);
    const applied = after.filter((v) => !before.has(v));
    const recorded = await recordedVersions(sql);
    const unrecorded = after.filter((v) => before.has(v) && !recorded.has(v));
    if (applied.length || unrecorded.length) {
      await logActivity(sql, {
        kind: 'system',
        actor: 'system',
        targetKind: 'schema',
        reason: 'migrate',
        details: { step: 'migrate', applied, ...(unrecorded.length ? { unrecorded } : {}) },
      });
    }
    const parts = [applied.length ? `applied ${applied.join(', ')}` : 'nothing to apply'];
    if (unrecorded.length) parts.push(`recorded ${unrecorded.join(', ')} (applied earlier)`);
    if (applied.length || unrecorded.length) parts.push('system activity entry written');
    console.log(`migrate: ${parts.join('; ')}`);
    return applied;
  } finally {
    await sql.end();
  }
}

/** Versions named by earlier `migrate` entries, as `applied` or `unrecorded`. */
async function recordedVersions(sql: Sql): Promise<Set<string>> {
  const rows = await sql<{ version: string }[]>`
    SELECT jsonb_array_elements_text(details->'applied' || COALESCE(details->'unrecorded', '[]'))
           AS version
    FROM activity_log
    WHERE kind = 'system' AND details->>'step' = 'migrate'`;
  return new Set(rows.map((r) => r.version));
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
