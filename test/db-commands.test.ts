import { execFile } from 'node:child_process';
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { scramSha256Verifier } from '../src/shared/db/app-role.js';
import { createSql, type Sql } from '../src/shared/db/sql.js';
import { dropDatabase, scratchDatabaseName, withDatabase } from './helpers/db.js';

const adminUrl = inject('adminDatabaseUrl');

interface Run {
  code: number;
  output: string;
}

/** A tsx entry point (`src/cli/main.ts` or `src/audit/verify-cli.ts`), stdout and stderr together. */
function node(
  entry: string,
  args: string[],
  env: Record<string, string | undefined>,
): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', entry, ...args],
      { env: { ...process.env, ...env } },
      (err, stdout, stderr) => {
        resolve({
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          output: `${stdout}${stderr}`,
        });
      },
    );
  });
}

/** What `pnpm db:predeploy` runs (there from dist/, here from src/): migrate, app login, verify. */
async function predeploy(env: Record<string, string | undefined>): Promise<Run> {
  let output = '';
  for (const [entry, args] of [
    ['src/cli/main.ts', ['db', 'migrate']],
    ['src/cli/main.ts', ['db', 'app-login']],
    ['src/audit/verify-cli.ts', []],
  ] as const) {
    const run = await node(entry, [...args], env);
    output += run.output;
    if (run.code !== 0) return { code: run.code, output };
  }
  return { code: 0, output };
}

/** Recompute a stored SCRAM-SHA-256 verifier's StoredKey from a password: true if it matches. */
function verifierMatches(verifier: string, password: string): boolean {
  const m = /^SCRAM-SHA-256\$(\d+):([^$]+)\$([^:]+):(.+)$/.exec(verifier);
  if (!m?.[1] || !m[2] || !m[3]) return false;
  const salted = pbkdf2Sync(password, Buffer.from(m[2], 'base64'), Number(m[1]), 32, 'sha256');
  const storedKey = createHash('sha256')
    .update(createHmac('sha256', salted).update('Client Key').digest())
    .digest();
  return storedKey.toString('base64') === m[3];
}

describe.skipIf(!adminUrl)('nacre db commands: migrate, app-login and the pre-deploy chain', () => {
  const name = scratchDatabaseName('deploy');
  const url = adminUrl ? withDatabase(adminUrl, name) : '';
  const password = randomBytes(32).toString('hex');
  let admin: Sql;
  const outputs: string[] = [];
  const role = () =>
    admin<{ rolcanlogin: boolean; rolpassword: string | null }[]>`
      SELECT rolcanlogin, rolpassword FROM pg_authid WHERE rolname = 'nacre_app'`;

  beforeAll(() => {
    admin = createSql(adminUrl, { max: 1 });
  });
  afterAll(async () => {
    await admin?.end();
    if (adminUrl) await dropDatabase(adminUrl, name);
  });

  it('the SCRAM verifier matches what Postgres itself computes for the same password and salt', async () => {
    // Postgres hashes a plaintext password for a throwaway role; recompute with its salt.
    let pgVerifier = '';
    await admin
      .begin(async (tx) => {
        await tx`CREATE ROLE nacre_scram_probe`;
        await tx`SET LOCAL password_encryption = 'scram-sha-256'`;
        await tx.unsafe(`ALTER ROLE nacre_scram_probe PASSWORD '${password}'`);
        const [r] = await tx<{ rolpassword: string }[]>`
          SELECT rolpassword FROM pg_authid WHERE rolname = 'nacre_scram_probe'`;
        pgVerifier = r?.rolpassword ?? '';
        throw new Error('rollback');
      })
      .catch((err: Error) => {
        if (err.message !== 'rollback') throw err;
      });
    const m = /^SCRAM-SHA-256\$(\d+):([^$]+)\$/.exec(pgVerifier);
    expect(m).not.toBeNull();
    const ours = scramSha256Verifier(password, Buffer.from(m?.[2] ?? '', 'base64'), Number(m?.[1]));
    expect(ours).toBe(pgVerifier);
  });

  it('migrate on a fresh database writes exactly one system entry listing the versions; a second run writes none', async () => {
    const env = { MIGRATION_DATABASE_URL: url, NACRE_APP_DB_PASSWORD: '' };
    const first = await node('src/cli/main.ts', ['db', 'migrate'], env);
    const second = await node('src/cli/main.ts', ['db', 'migrate'], env);
    outputs.push(first.output, second.output);
    expect([first.code, second.code]).toEqual([0, 0]);
    expect(second.output).toContain('migrate: nothing to apply');

    const db = createSql(url, { max: 1 });
    try {
      const entries =
        await db`SELECT actor, target_kind, details FROM activity_log WHERE kind = 'system'`;
      expect(entries).toEqual([
        {
          actor: 'system',
          target_kind: 'schema',
          details: { step: 'migrate', applied: ['20261023000000', '20261023000100'] },
        },
      ]);
    } finally {
      await db.end();
    }
  });

  it('app-login with the variable unset leaves nacre_app untouched', async () => {
    const before = await role();
    const run = await node('src/cli/main.ts', ['db', 'app-login'], {
      MIGRATION_DATABASE_URL: url,
      NACRE_APP_DB_PASSWORD: '',
    });
    outputs.push(run.output);
    expect(run.code).toBe(0);
    expect(run.output).toContain('NACRE_APP_DB_PASSWORD is not set; nacre_app left unchanged');
    expect(await role()).toEqual(before);
  });

  it('pre-deploy with the password set: migrates, gives nacre_app LOGIN with that password, and every check passes', async () => {
    const run = await predeploy({ MIGRATION_DATABASE_URL: url, NACRE_APP_DB_PASSWORD: password });
    outputs.push(run.output);
    expect(run.code).toBe(0);
    expect(run.output).toContain('app-login: nacre_app has LOGIN');
    expect(run.output).toMatch(/\d+ passed, 0 failed/);
    const [r] = await role();
    expect(r?.rolcanlogin).toBe(true);
    expect(r?.rolpassword).toMatch(/^SCRAM-SHA-256\$4096:/);
    expect(verifierMatches(r?.rolpassword ?? '', password)).toBe(true);
    expect(verifierMatches(r?.rolpassword ?? '', `${password}x`)).toBe(false);
  });

  it('a second pre-deploy changes nothing but the login (a new salt) and still passes', async () => {
    const [before] = await role();
    const run = await predeploy({ MIGRATION_DATABASE_URL: url, NACRE_APP_DB_PASSWORD: password });
    outputs.push(run.output);
    expect(run.code).toBe(0);
    expect(run.output).toContain('migrate: nothing to apply');
    const [after] = await role();
    expect(after?.rolpassword).not.toBe(before?.rolpassword);
    expect(verifierMatches(after?.rolpassword ?? '', password)).toBe(true);
  });

  it('pre-deploy exits non-zero when events_append_only is disabled, so the deploy stops', async () => {
    const db = createSql(url, { max: 1 });
    try {
      await db`ALTER TABLE events DISABLE TRIGGER events_append_only`;
      const run = await predeploy({ MIGRATION_DATABASE_URL: url, NACRE_APP_DB_PASSWORD: password });
      outputs.push(run.output);
      expect(run.code).not.toBe(0);
      expect(run.output).toContain('FAIL  triggers: events_append_only on events');
    } finally {
      await db`ALTER TABLE events ENABLE TRIGGER events_append_only`;
      await db.end();
    }
  });

  it('the password never appears in any output', () => {
    expect(outputs.length).toBeGreaterThanOrEqual(6);
    for (const output of outputs) expect(output).not.toContain(password);
  });
});
