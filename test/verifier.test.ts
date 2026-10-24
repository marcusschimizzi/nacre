import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  type AuthRoute,
  denyReason,
  type TokenRow,
  type VerifyResult,
  verifyToken,
} from '../src/api/auth.js';
import { logActivity } from '../src/shared/activity.js';
import { createSql, type Sql } from '../src/shared/db/sql.js';
import { parseToken } from '../src/shared/tokens.js';
import {
  MCP_RESOURCE,
  oauthToken,
  startTestApp,
  staticToken,
  type TestApp,
  testAgent,
} from './helpers/app.js';

const appDatabaseUrl = inject('appDatabaseUrl');
const ownerDatabaseUrl = inject('databaseUrl');

describe.skipIf(!appDatabaseUrl)('verifyToken (spec §7, §9.3)', () => {
  let app: TestApp;
  let owner: Sql;
  const agent = testAgent('verify');
  let staticTok: string;

  beforeAll(async () => {
    app = await startTestApp(appDatabaseUrl);
    owner = createSql(ownerDatabaseUrl, { max: 1 });
    staticTok = (await staticToken(app, agent)).token;
  });
  afterAll(async () => {
    await app?.close();
    await owner?.end();
  });

  const verify = (token: string, route: AuthRoute = 'mcp', header = `Bearer ${token}`) =>
    verifyToken({ sql: app.sql, pepper: app.pepper, mcpResource: MCP_RESOURCE }, header, route);
  const denied = (result: VerifyResult) =>
    !result.ok && result.wellFormed ? result.reason : 'malformed';

  describe('header shape', () => {
    it.each([
      ['no header', undefined],
      ['empty', ''],
      ['other scheme', 'Basic dXNlcjpwYXNz'],
      ['not a nacre token', 'Bearer abc.def.ghi'],
      ['two tokens', 'Bearer a b'],
    ])('%s → malformed, nothing to attribute', async (_case, header) => {
      const result = await verifyToken(
        { sql: app.sql, pepper: app.pepper, mcpResource: MCP_RESOURCE },
        header,
        'mcp',
      );
      expect(result).toEqual({ ok: false, wellFormed: false });
    });
  });

  describe('static tokens', () => {
    it.each(['mcp', 'v1'] as const)('work on %s, with the caller on the result', async (route) => {
      const result = await verify(staticTok, route);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.auth).toMatchObject({
          agentId: agent,
          kind: 'static',
          oauthClientId: null,
          readScopes: ['*'],
          writeScopes: ['*'],
          labelCeiling: 'restricted',
          rights: ['read', 'write'],
        });
      }
    });

    it('update last_used_at on success, at most once a minute', async () => {
      const created = await staticToken(app, testAgent('touch'));
      const lastUsed = async () => {
        const [row] = await app.sql<{ last_used_at: Date | null }[]>`
          SELECT last_used_at FROM agent_tokens WHERE token_id = ${created.tokenId}`;
        return row?.last_used_at ?? null;
      };
      expect(await lastUsed()).toBeNull();

      expect((await verify(created.token)).ok).toBe(true);
      const first = await lastUsed();
      expect(first).toBeInstanceOf(Date);

      // Within the minute: no write.
      expect((await verify(created.token)).ok).toBe(true);
      expect(await lastUsed()).toEqual(first);

      // Older than a minute: the next success writes again.
      await app.sql`
        UPDATE agent_tokens SET last_used_at = now() - interval '2 minutes'
        WHERE token_id = ${created.tokenId}`;
      const stale = await lastUsed();
      expect((await verify(created.token)).ok).toBe(true);
      expect((await lastUsed())?.getTime()).toBeGreaterThan(stale?.getTime() ?? Infinity);
    });

    it('a failed last_used_at write is logged and the token still works', async () => {
      const created = await staticToken(app, testAgent('touchfail'));
      const warnings: string[] = [];
      // Every query goes to the real client except the UPDATE, which fails like a lost connection.
      const failingUpdate = ((strings: TemplateStringsArray, ...values: unknown[]) =>
        strings.join('').includes('UPDATE agent_tokens')
          ? Promise.reject(new Error('connection lost'))
          : app.sql(strings, ...(values as never[]))) as unknown as Sql;
      const result = await verifyToken(
        {
          sql: failingUpdate,
          pepper: app.pepper,
          mcpResource: MCP_RESOURCE,
          log: { warn: (_obj: unknown, msg: string) => warnings.push(msg) } as never,
        },
        `Bearer ${created.token}`,
        'mcp',
      );
      expect(result.ok).toBe(true);
      expect(warnings).toEqual(['last_used_at not updated']);
    });

    it('bad secret → bad_secret, with the row it names (the middleware logs it to the request log only)', async () => {
      const parsed = parseToken(staticTok);
      const wrong = `nacre_${parsed?.tokenId}_${'A'.repeat(43)}`;
      const result = await verify(wrong);
      expect(result).toMatchObject({
        ok: false,
        reason: 'bad_secret',
        tokenId: parsed?.tokenId,
        agentId: agent,
      });
    });

    it('unknown token id → unknown_token, with no token id to attribute', async () => {
      const result = await verify(`nacre_tok_01JAXK5W3J8N4Q2R7T9V0Y1Z2A_${'A'.repeat(43)}`);
      expect(result).toMatchObject({
        ok: false,
        reason: 'unknown_token',
        tokenId: null,
        agentId: null,
      });
    });

    it('expired → expired; a future expiry is fine', async () => {
      const a = testAgent('exp');
      const past = (await staticToken(app, a, new Date(Date.now() - 1000))).token;
      const future = (await staticToken(app, a, new Date(Date.now() + 3_600_000))).token;
      expect(denied(await verify(past))).toBe('expired');
      expect((await verify(future)).ok).toBe(true);
    });

    it('revoked → revoked', async () => {
      const a = testAgent('rev');
      const created = await staticToken(app, a);
      await app.sql`UPDATE agent_tokens SET revoked_at = now() WHERE token_id = ${created.tokenId}`;
      expect(denied(await verify(created.token))).toBe('revoked');
    });

    it('disabled agent → agent_disabled', async () => {
      const a = testAgent('dis');
      const created = await staticToken(app, a);
      // nacre_app can't update agents (spec §4 grants); disabling is an owner action.
      await owner`UPDATE agents SET disabled_at = now() WHERE agent_id = ${a}`;
      expect(denied(await verify(created.token))).toBe('agent_disabled');
    });
  });

  describe('OAuth tokens (rows inserted as fixtures; task 3b issues them)', () => {
    it('access token for the /mcp resource works on mcp', async () => {
      const token = await oauthToken(app, agent, { kind: 'oauth_access' });
      const result = await verify(token, 'mcp');
      expect(result.ok && result.auth.kind).toBe('oauth_access');
      expect(result.ok && result.auth.oauthClientId).toMatch(/^cli_test_/);
    });

    it('access token on v1 → wrong_route (A17.5)', async () => {
      const token = await oauthToken(app, agent, { kind: 'oauth_access' });
      expect(denied(await verify(token, 'v1'))).toBe('wrong_route');
    });

    it('access token for another resource → wrong_resource', async () => {
      const token = await oauthToken(app, agent, {
        kind: 'oauth_access',
        resource: 'https://elsewhere.example/mcp',
      });
      expect(denied(await verify(token, 'mcp'))).toBe('wrong_resource');
    });

    it('expired access token → expired (A17.4)', async () => {
      const token = await oauthToken(app, agent, {
        kind: 'oauth_access',
        expiresAt: new Date(Date.now() - 1000),
      });
      expect(denied(await verify(token, 'mcp'))).toBe('expired');
    });

    it('access token with no expiry → no_expiry (only static tokens may lack one)', () => {
      // The table's CHECK won't store such a row, so the rule is tested on the row shape directly.
      const row: TokenRow = {
        agent_id: agent,
        secret_hash: Buffer.alloc(32),
        kind: 'oauth_access',
        resource: MCP_RESOURCE,
        oauth_client_id: 'cli_test',
        read_scopes: ['*'],
        write_scopes: ['*'],
        label_ceiling: 'restricted',
        rights: ['read', 'write'],
        revoked: false,
        expired: false,
        has_expiry: false,
        agent_disabled: false,
        touch_due: false,
      };
      expect(denyReason(row, 'mcp', MCP_RESOURCE)).toBe('no_expiry');
      expect(denyReason({ ...row, has_expiry: true }, 'mcp', MCP_RESOURCE)).toBeNull();
      expect(denyReason({ ...row, kind: 'static', resource: null }, 'v1', MCP_RESOURCE)).toBeNull();
    });

    it.each(['mcp', 'v1'] as const)(
      'refresh token is never a bearer token (%s, A17.5)',
      async (route) => {
        const token = await oauthToken(app, agent, { kind: 'oauth_refresh' });
        expect(denied(await verify(token, route))).toBe('refresh_token_as_bearer');
      },
    );
  });

  describe('logActivity', () => {
    it('refuses to write anything token-shaped', async () => {
      await expect(
        logActivity(app.sql, { kind: 'system', actor: 'system', details: { oops: staticTok } }),
      ).rejects.toThrow(/token-shaped/);
      await expect(
        logActivity(app.sql, { kind: 'system', actor: 'system', reason: `Bearer ${staticTok}` }),
      ).rejects.toThrow(/token-shaped/);
    });
  });
});
