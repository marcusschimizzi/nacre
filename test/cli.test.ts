import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createSql, type Sql } from '../src/shared/db/sql.js';
import { isArgon2idPhc, verifyOwnerPassword } from '../src/shared/password.js';
import { hashSecret, mintToken, parseToken } from '../src/shared/tokens.js';
import { testAgent } from './helpers/app.js';

const appDatabaseUrl = inject('appDatabaseUrl');
const TOKEN_LINE = /^nacre_tok_[0-9A-HJKMNP-TV-Z]{26}_[A-Za-z0-9_-]{43}$/;

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** The real CLI entry point, as `pnpm nacre …` runs it, connected as nacre_app. */
function nacre(
  args: string[],
  env: Record<string, string | undefined>,
  input?: string,
): Promise<Run> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      ['--import', 'tsx', 'src/cli/main.ts', ...args],
      { env: { ...process.env, ...env } },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        resolve({ code, stdout, stderr });
      },
    );
    child.stdin?.end(input ?? '');
  });
}

describe.skipIf(!appDatabaseUrl)('nacre token CLI (spec §8.1)', () => {
  const pepper = randomBytes(32).toString('base64url');
  const env = { DATABASE_URL: appDatabaseUrl, TOKEN_PEPPER: pepper };
  const agent = testAgent('cli');
  let sql: Sql;
  let created: Run;
  let token: string;
  let tokenId: string;
  let secret: string;
  const outputs: Run[] = [];

  beforeAll(async () => {
    sql = createSql(appDatabaseUrl, { max: 1 });
    created = await nacre(['token', 'create', '--agent', agent, '--note', 'cli test'], env);
    outputs.push(created);
    token = created.stdout.trim();
    const parsed = parseToken(token);
    tokenId = parsed?.tokenId ?? '';
    secret = parsed?.secret ?? '';
  });
  afterAll(() => sql?.end());

  it('create prints exactly one line, the token, on stdout', () => {
    expect(created.code).toBe(0);
    expect(created.stdout.endsWith('\n')).toBe(true);
    const lines = created.stdout.split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(TOKEN_LINE);
  });

  it('create explains itself on stderr: token id, agent, shown once', () => {
    expect(created.stderr).toContain(`token_id: ${tokenId}`);
    expect(created.stderr).toContain(`agent: ${agent} (created)`);
    expect(created.stderr).toMatch(/shown once/);
  });

  it('create made the agent, a static token with resource NULL and the §4 defaults, and a token_create entry', async () => {
    const [a] = await sql`SELECT display_name, client_kind FROM agents WHERE agent_id = ${agent}`;
    expect(a).toEqual({ display_name: agent, client_kind: 'cli' });
    const [t] = await sql`
      SELECT kind, resource, read_scopes, write_scopes, label_ceiling, rights, note, expires_at
      FROM agent_tokens WHERE token_id = ${tokenId}`;
    expect(t).toEqual({
      kind: 'static',
      resource: null,
      read_scopes: ['*'],
      write_scopes: ['*'],
      label_ceiling: 'restricted',
      rights: ['read', 'write'],
      note: 'cli test',
      expires_at: null,
    });
    const entries = await sql`
      SELECT actor, target_id, details FROM activity_log WHERE kind = 'token_create' AND token_id = ${tokenId}`;
    expect(entries).toEqual([
      {
        actor: 'owner',
        target_id: tokenId,
        details: { agent_id: agent, kind: 'static', agent_created: true },
      },
    ]);
  });

  it('stores only HMAC-SHA256(pepper, secret): 32 bytes, not sha256(secret)', async () => {
    const [row] = await sql<{ secret_hash: Buffer }[]>`
      SELECT secret_hash FROM agent_tokens WHERE token_id = ${tokenId}`;
    expect(row?.secret_hash).toHaveLength(32);
    expect(row?.secret_hash.equals(createHash('sha256').update(secret).digest())).toBe(false);
    expect(row?.secret_hash.equals(hashSecret(pepper, secret))).toBe(true);
  });

  it('a second token for the same agent reuses the agent', async () => {
    const again = await nacre(['token', 'create', '--agent', agent], env);
    outputs.push(again);
    expect(again.code).toBe(0);
    expect(again.stderr).toContain(`agent: ${agent}\n`);
  });

  it('list shows the token without secrets or hashes', async () => {
    const listed = await nacre(['token', 'list'], env);
    outputs.push(listed);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toMatch(
      /^token_id\s+agent\s+kind\s+grant\s+created\s+last_used\s+expires\s+revoked/,
    );
    const line = listed.stdout.split('\n').find((l) => l.startsWith(tokenId));
    expect(line).toMatch(new RegExp(`^${tokenId}\\s+${agent}\\s+static\\s+-\\s+\\d{4}-`));
  });

  it('revoke sets revoked_at once, logs token_revoke, and is a no-op the second time', async () => {
    const first = await nacre(['token', 'revoke', tokenId], env);
    const second = await nacre(['token', 'revoke', tokenId], env);
    const missing = await nacre(['token', 'revoke', 'tok_01JAXK5W3J8N4Q2R7T9V0Y1Z2A'], env);
    outputs.push(first, second, missing);
    expect([first.code, second.code, missing.code]).toEqual([0, 0, 1]);
    expect(first.stderr).toContain(`revoked ${tokenId}`);
    expect(second.stderr).toMatch(/already revoked; nothing changed/);
    expect(missing.stderr).toMatch(/no token/);
    const revokes =
      await sql`SELECT actor FROM activity_log WHERE kind = 'token_revoke' AND token_id = ${tokenId}`;
    expect(revokes).toEqual([{ actor: 'owner' }]);
    const listed = await nacre(['token', 'list'], env);
    expect(listed.stdout.split('\n').find((l) => l.startsWith(tokenId))).toMatch(
      /\d{4}-\d\d-\d\dT[\d:]+Z$/,
    );
  });

  it.each([
    ['no --agent', ['token', 'create'], env],
    ['a bad agent id', ['token', 'create', '--agent', 'Not An Id'], env],
    [
      'no TOKEN_PEPPER',
      ['token', 'create', '--agent', 'x'],
      { DATABASE_URL: appDatabaseUrl, TOKEN_PEPPER: '' },
    ],
    ['a bad token id', ['token', 'revoke', 'nacre_tok_x'], env],
    ['an unknown command', ['token', 'mint'], env],
  ])('%s → exit 2 with a usage message', async (_case, args, runEnv) => {
    const run = await nacre(args, runEnv);
    expect(run.code).toBe(2);
    expect(run.stdout).toBe('');
  });

  it('nothing leaks: the secret is on stdout of create only, never on stderr or in other output', () => {
    expect(secret).toHaveLength(43);
    for (const run of outputs) expect(run.stderr).not.toContain(secret);
    for (const run of outputs.slice(1)) expect(run.stdout).not.toContain(secret);
  });
});

describe('nacre owner-password hash (spec §12.1)', () => {
  const password = 'a long owner password';

  it('piped: prints only the argon2id PHC string, which verifies', async () => {
    const run = await nacre(['owner-password', 'hash'], {}, `${password}\n`);
    expect(run.code).toBe(0);
    const lines = run.stdout.split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    const phc = lines[0] ?? '';
    expect(phc).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=4\$/);
    expect(isArgon2idPhc(phc)).toBe(true);
    expect(await verifyOwnerPassword(phc, password)).toBe(true);
    expect(run.stderr).not.toContain(password);
    expect(run.stderr).not.toContain(phc);
  });

  it('refuses a password under 12 characters, printing nothing', async () => {
    const run = await nacre(['owner-password', 'hash'], {}, 'elevenchars\n');
    expect(run.code).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.stderr).toMatch(/at least 12 characters/);
    expect(run.stderr).not.toContain('elevenchars');
  });
});

describe.skipIf(!appDatabaseUrl)('nacre token revoke with an OAuth token (spec §9.3)', () => {
  const pepper = randomBytes(32).toString('base64url');
  const env = { DATABASE_URL: appDatabaseUrl, TOKEN_PEPPER: pepper };
  let sql: Sql;
  beforeAll(() => {
    sql = createSql(appDatabaseUrl, { max: 1 });
  });
  afterAll(() => sql?.end());

  it('revokes every token in the grant, logs one token_revoke with the count, and list shows the grant', async () => {
    const agent = testAgent('grant');
    await nacre(['token', 'create', '--agent', agent], env);
    // Two OAuth rows in one grant, as /oauth/token issues them.
    const clientId = `cli_test_${randomBytes(6).toString('hex')}`;
    const grantId = `grt_test_${randomBytes(6).toString('hex')}`;
    await sql`
      INSERT INTO oauth_clients (client_id, client_name, redirect_uris, metadata)
      VALUES (${clientId}, 'cli test', ${['https://client.example/cb']}, ${sql.json({})})`;
    const [access, refresh] = [mintToken(pepper), mintToken(pepper)];
    for (const [t, kind] of [
      [access, 'oauth_access'],
      [refresh, 'oauth_refresh'],
    ] as const) {
      await sql`
        INSERT INTO agent_tokens (token_id, agent_id, secret_hash, kind, oauth_client_id, grant_id,
                                  resource, expires_at)
        VALUES (${t.tokenId}, ${agent}, ${t.secretHash}, ${kind}, ${clientId}, ${grantId},
                'https://api.nacre.test/mcp', now() + interval '1 hour')`;
    }
    const first = { token_id: access.tokenId };

    const listed = await nacre(['token', 'list'], env);
    expect(listed.stdout.split('\n').find((l) => l.startsWith(first.token_id))).toContain(grantId);

    const run = await nacre(['token', 'revoke', first.token_id], env);
    expect(run.code).toBe(0);
    expect(run.stderr).toContain(`revoked grant ${grantId}: 2 token(s)`);
    const live = await sql`
      SELECT 1 FROM agent_tokens WHERE grant_id = ${grantId} AND revoked_at IS NULL`;
    expect(live).toHaveLength(0);
    // The agent's static token is untouched.
    expect(
      await sql`SELECT 1 FROM agent_tokens WHERE agent_id = ${agent} AND kind = 'static' AND revoked_at IS NULL`,
    ).toHaveLength(1);
    const entries = await sql`
      SELECT target_kind, target_id, details FROM activity_log
      WHERE kind = 'token_revoke' AND token_id = ${first.token_id}`;
    expect(entries).toEqual([
      {
        target_kind: 'oauth_grant',
        target_id: grantId,
        details: { agent_id: agent, grant_id: grantId, revoked_count: 2 },
      },
    ]);
    const again = await nacre(['token', 'revoke', refresh.tokenId], env);
    expect(again.stderr).toMatch(/already revoked; nothing changed/);
  });
});
