import {
  Client,
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthTokens,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { verifyToken } from '../src/api/auth.js';
import { createSql, type Sql } from '../src/shared/db/sql.js';
import { parseToken, revokeToken } from '../src/shared/tokens.js';
import {
  MCP_RESOURCE,
  OWNER_PASSWORD,
  PUBLIC_API_URL,
  startTestApp,
  staticToken,
  type TestApp,
  testAgent,
} from './helpers/app.js';
import { dbmate, dropDatabase, scratchDatabaseName, withDatabase } from './helpers/db.js';
import {
  approve,
  at,
  authorize,
  authorizeQuery,
  codeFrom,
  connect,
  consentForm,
  localFetch,
  mcpStatus,
  NEW_AGENT,
  parseConsent,
  pkce,
  postConsent,
  REDIRECT_URI,
  register,
  registerClient,
  type TokenResponse,
  token,
} from './helpers/oauth.js';

const appDatabaseUrl = inject('appDatabaseUrl');
const ownerDatabaseUrl = inject('databaseUrl');
const adminUrl = inject('adminDatabaseUrl');

// Relaxed limits for the flow tests; the limits themselves are tested on fresh apps with the defaults.
const ROOMY = { registrationsPerHour: 1000, passwordFailures: 1000 };

/** Every secret a test saw, so the last test can check none reached a log line or activity row. */
const secrets: string[] = [OWNER_PASSWORD];

const requestLogs = (app: TestApp) =>
  app.logLines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((l) => l.msg === 'request');

async function ping(app: TestApp, accessToken: string): Promise<unknown> {
  const client = new Client(
    { name: 'oauth-test', version: '0' },
    { versionNegotiation: { mode: 'auto' } },
  );
  await client.connect(
    new StreamableHTTPClientTransport(app.mcpUrl, {
      requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
    }),
  );
  try {
    const result = await client.callTool({ name: 'ping', arguments: {} });
    return result.structuredContent;
  } finally {
    await client.close();
  }
}

/** An in-memory `OAuthClientProvider`, as an MCP client app would implement one. */
class TestProvider implements OAuthClientProvider {
  info: OAuthClientInformationMixed | undefined;
  saved: OAuthTokens | undefined;
  verifier = '';
  authorizationUrl: URL | undefined;
  constructor(private readonly name: string) {}
  get redirectUrl() {
    return REDIRECT_URI;
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.name,
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    };
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    this.info = info;
  }
  tokens() {
    return this.saved;
  }
  saveTokens(tokens: OAuthTokens) {
    this.saved = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }
  codeVerifier() {
    return this.verifier;
  }
}

describe.skipIf(!appDatabaseUrl)('A17: OAuth for MCP clients (spec §9.3)', () => {
  let app: TestApp;
  let owner: Sql;

  beforeAll(async () => {
    app = await startTestApp(appDatabaseUrl, { oauthLimits: ROOMY });
    owner = createSql(ownerDatabaseUrl, { max: 1 });
  });
  afterAll(async () => {
    await app?.close();
    await owner?.end();
  });

  const consentRows = (clientId: string) =>
    app.sql<{ details: Record<string, unknown> }[]>`
      SELECT details FROM activity_log WHERE kind = 'oauth_consent' AND target_id = ${clientId}`;
  const codeCount = async (clientId: string) =>
    Number(
      (
        await app.sql<
          { n: string }[]
        >`SELECT count(*) AS n FROM oauth_auth_codes WHERE client_id = ${clientId}`
      )[0]?.n,
    );
  const agentRow = async (agentId: string) =>
    (
      await app.sql<{ client_kind: string; display_name: string }[]>`
        SELECT client_kind, display_name FROM agents WHERE agent_id = ${agentId}`
    )[0];

  describe('discovery', () => {
    it.each(['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource'])(
      '%s: the resource, its server, header only, no scopes, CORS *',
      async (path) => {
        const res = await fetch(at(app, path));
        expect(res.status).toBe(200);
        expect(res.headers.get('access-control-allow-origin')).toBe('*');
        expect(await res.json()).toEqual({
          resource: MCP_RESOURCE,
          authorization_servers: [PUBLIC_API_URL],
          bearer_methods_supported: ['header'],
        });
      },
    );

    it('server metadata has exactly the §9.3 fields; no OpenID document', async () => {
      const res = await fetch(at(app, '/.well-known/oauth-authorization-server'));
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      expect(await res.json()).toEqual({
        issuer: PUBLIC_API_URL,
        authorization_endpoint: `${PUBLIC_API_URL}/oauth/authorize`,
        token_endpoint: `${PUBLIC_API_URL}/oauth/token`,
        registration_endpoint: `${PUBLIC_API_URL}/oauth/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        authorization_response_iss_parameter_supported: true,
      });
      expect((await fetch(at(app, '/.well-known/openid-configuration'))).status).toBe(404);
    });

    it('CORS is on the discovery GETs only', async () => {
      const res = await register(app, { redirect_uris: [REDIRECT_URI] });
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    });
  });

  describe('A17.1: the SDK client, from the 401 to ping', () => {
    it('discovers, registers, gets consent, exchanges the code and calls ping', async () => {
      const provider = new TestProvider('SDK Test Client');
      const fetchLocal = localFetch(app);
      const transport = () =>
        new StreamableHTTPClientTransport(new URL(MCP_RESOURCE), {
          authProvider: provider,
          fetch: fetchLocal,
        });
      const client = () =>
        new Client({ name: 'a17', version: '0' }, { versionNegotiation: { mode: 'auto' } });

      // 1. No token: the 401 sends the SDK through discovery and registration to the consent page.
      const first = transport();
      await expect(client().connect(first)).rejects.toThrow();
      const authUrl = provider.authorizationUrl;
      expect(authUrl?.origin).toBe(PUBLIC_API_URL);
      expect(authUrl?.pathname).toBe('/oauth/authorize');
      expect(authUrl?.searchParams.get('code_challenge_method')).toBe('S256');
      expect(authUrl?.searchParams.get('resource')).toBe(MCP_RESOURCE);
      expect(provider.info?.client_id).toMatch(/^cli_/);

      // 2. The owner approves on the consent page (a browser would post this form).
      const page = await fetchLocal(authUrl ?? '', { redirect: 'manual' });
      expect(page.status).toBe(200);
      const form = parseConsent(await page.text());
      expect(form.selected).toEqual([NEW_AGENT]);
      expect(form.newAgentId).toBe('sdk-test-client');
      const approved = await approve(app, form);
      expect(approved.status).toBe(303);
      const callback = new URL(approved.headers.get('location') ?? '');
      expect(`${callback.origin}${callback.pathname}`).toBe(REDIRECT_URI);
      expect(callback.searchParams.get('iss')).toBe(PUBLIC_API_URL);
      secrets.push(callback.searchParams.get('code') ?? '', provider.verifier);

      // 3. The client finishes (checking `iss`), then connects with its token.
      await first.finishAuth(callback.searchParams);
      expect(provider.saved?.token_type).toBe('Bearer');
      expect(provider.saved?.expires_in).toBe(3600);
      expect(provider.saved?.scope).toBeUndefined();
      secrets.push(provider.saved?.access_token ?? '', provider.saved?.refresh_token ?? '');
      const connected = client();
      await connected.connect(transport());
      const result = await connected.callTool({ name: 'ping', arguments: {} });
      expect(result.structuredContent).toMatchObject({ pong: true, agent_id: 'sdk-test-client' });
      await connected.close();

      expect(requestLogs(app).map((l) => l.oauth)).toEqual(
        expect.arrayContaining([
          'register:ok',
          'authorize:consent_shown',
          'consent:approve:agent_created',
          'token:code',
        ]),
      );
    });
  });

  describe('A17.1a: the agent choice (no hardcoded agent)', () => {
    let fixture: string;
    let alpha: { clientId: string; tokens: TokenResponse };

    beforeAll(async () => {
      fixture = testAgent('beta-fixture');
      await staticToken(app, fixture);
    });

    it('Alpha: "Create new agent" preselected with the suggested id; approving creates it', async () => {
      const clientId = await registerClient(app, 'Test Client Alpha');
      const { verifier, challenge } = pkce();
      const form = await consentForm(app, clientId, challenge);
      expect(form.selected).toEqual([NEW_AGENT]);
      expect(form.newAgentId).toBe('test-client-alpha');
      // Only real, enabled agents are offered, plus create-new last.
      const enabled = (
        await app.sql<{ agent_id: string }[]>`SELECT agent_id FROM agents WHERE disabled_at IS NULL`
      ).map((r) => r.agent_id);
      expect(form.options.at(-1)).toBe(NEW_AGENT);
      for (const option of form.options.slice(0, -1)) expect(enabled).toContain(option);

      const approved = await approve(app, form);
      expect(approved.status).toBe(303);
      expect(await agentRow('test-client-alpha')).toEqual({
        client_kind: 'mcp-oauth',
        display_name: 'Test Client Alpha',
      });
      const [entry] = await consentRows(clientId);
      expect(entry?.details).toMatchObject({
        decision: 'approve',
        agent_id: 'test-client-alpha',
        agent_created: true,
      });
      const res = await token(app, {
        grant_type: 'authorization_code',
        client_id: clientId,
        code: codeFrom(approved),
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      });
      expect(res.status).toBe(200);
      alpha = { clientId, tokens: (await res.json()) as TokenResponse };
      expect(await ping(app, alpha.tokens.access_token)).toMatchObject({
        agent_id: 'test-client-alpha',
      });
    });

    it('Beta picks an existing agent: no agent row is created, and the token acts as that agent', async () => {
      const beta = await connect(app, 'Beta Notes', { agent: fixture });
      expect(beta.form.selected).toEqual([NEW_AGENT]);
      expect(beta.form.newAgentId).toBe('beta-notes');
      expect(await agentRow('beta-notes')).toBeUndefined();
      expect(await ping(app, beta.tokens.access_token)).toMatchObject({ agent_id: fixture });

      const access = parseToken(beta.tokens.access_token)?.tokenId;
      const rows = await app.sql<
        { kind: string; agent_id: string; oauth_client_id: string; grant_id: string }[]
      >`
        SELECT kind, agent_id, oauth_client_id, grant_id FROM agent_tokens
        WHERE grant_id = (SELECT grant_id FROM agent_tokens WHERE token_id = ${access ?? ''})
        ORDER BY kind`;
      expect(rows.map((r) => [r.kind, r.agent_id, r.oauth_client_id])).toEqual([
        ['oauth_access', fixture, beta.clientId],
        ['oauth_refresh', fixture, beta.clientId],
      ]);
      const [code] = await app.sql<{ agent_id: string; grant_id: string }[]>`
        SELECT agent_id, grant_id FROM oauth_auth_codes WHERE client_id = ${beta.clientId}`;
      expect(code).toEqual({ agent_id: fixture, grant_id: rows[0]?.grant_id });
      const [entry] = await consentRows(beta.clientId);
      expect(entry?.details.agent_created).toBeUndefined();
    });

    it('(a) a second client with the same name preselects the existing agent and reuses it', async () => {
      const again = await connect(app, 'Test Client Alpha');
      expect(again.form.selected).toEqual(['test-client-alpha']);
      expect(again.form.newAgentId).toBe('test-client-alpha-2');
      expect(await agentRow('test-client-alpha-2')).toBeUndefined();
      expect(await ping(app, again.tokens.access_token)).toMatchObject({
        agent_id: 'test-client-alpha',
      });
      const [entry] = await consentRows(again.clientId);
      expect(entry?.details).toMatchObject({ agent_id: 'test-client-alpha' });
      expect(entry?.details.agent_created).toBeUndefined();
    });

    it('(b) revoked, then reconnected under the same name: the existing agent is reused', async () => {
      const access = parseToken(alpha.tokens.access_token)?.tokenId ?? '';
      const revoked = await revokeToken(app.sql, access);
      expect(revoked).toMatchObject({ status: 'revoked', revoked: 2 });
      expect(await mcpStatus(app, alpha.tokens.access_token)).toBe(401);

      const count = async () =>
        Number(
          (
            await app.sql<
              { n: string }[]
            >`SELECT count(*) AS n FROM agents WHERE agent_id LIKE 'test-client-alpha%'`
          )[0]?.n,
        );
      const before = await count();
      const back = await connect(app, 'Test Client Alpha');
      expect(back.form.selected).toEqual(['test-client-alpha']);
      expect(await count()).toBe(before);
      expect(await ping(app, back.tokens.access_token)).toMatchObject({
        agent_id: 'test-client-alpha',
      });
      const [entry] = await consentRows(back.clientId);
      expect(entry?.details.agent_created).toBeUndefined();
    });

    it('(c) the owner overrides the preselection: create-new with -2, or another existing agent', async () => {
      const created = await connect(app, 'Test Client Alpha', {
        agent: NEW_AGENT,
        newAgentId: 'test-client-alpha-2',
      });
      expect(created.form.selected).toEqual(['test-client-alpha']);
      expect(await agentRow('test-client-alpha-2')).toMatchObject({ client_kind: 'mcp-oauth' });
      expect((await consentRows(created.clientId))[0]?.details).toMatchObject({
        agent_id: 'test-client-alpha-2',
        agent_created: true,
      });
      expect(await ping(app, created.tokens.access_token)).toMatchObject({
        agent_id: 'test-client-alpha-2',
      });

      const reused = await connect(app, 'Test Client Alpha', { agent: fixture });
      expect(await ping(app, reused.tokens.access_token)).toMatchObject({ agent_id: fixture });
    });

    it('(d) a disabled agent with the slug is not preselected, not offered, and is skipped by the prefill', async () => {
      const disabled = 'test-client-delta';
      await staticToken(app, disabled);
      await owner`UPDATE agents SET disabled_at = now() WHERE agent_id = ${disabled}`;
      const clientId = await registerClient(app, 'Test Client Delta');
      const form = await consentForm(app, clientId, pkce().challenge);
      expect(form.selected).toEqual([NEW_AGENT]);
      expect(form.options).not.toContain(disabled);
      expect(form.newAgentId).toBe('test-client-delta-2');
    });

    it('(e) a name that matches nothing preselects "Create new agent"; no name reads "(unnamed client)"', async () => {
      const named = await consentForm(
        app,
        await registerClient(app, 'Nothing Matches Me'),
        pkce().challenge,
      );
      expect(named.selected).toEqual([NEW_AGENT]);
      const unnamed = await consentForm(
        app,
        await registerClient(app, undefined),
        pkce().challenge,
      );
      expect(unnamed.html).toContain('(unnamed client)');
      expect(unnamed.newAgentId).toMatch(/^agent(-\d+)?$/);
    });
  });

  describe('consent page safety', () => {
    it('escapes a hostile client name everywhere, and shows the redirect host', async () => {
      const hostile = `<script>alert(1)</script>"'&`;
      const clientId = await registerClient(app, hostile);
      const form = await consentForm(app, clientId, pkce().challenge);
      expect(form.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(form.html).not.toContain(hostile);
      expect(form.html).not.toContain('<script');
      expect(form.html).toContain('client.example');
      // Approving stores the name as the new agent's display name; it stays escaped in the select.
      expect((await approve(app, form)).status).toBe(303);
      const other = await consentForm(
        app,
        await registerClient(app, 'Plain Name'),
        pkce().challenge,
      );
      expect(other.options).toContain(form.newAgentId);
      expect(other.html).not.toContain(hostile);
      expect(other.html).not.toContain('<script');
    });

    it('sends the §9.3 headers, and no cookie', async () => {
      const clientId = await registerClient(app, 'Header Check');
      const res = await authorize(app, authorizeQuery(clientId, pkce().challenge));
      expect(res.headers.get('content-security-policy')).toBe(
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
      );
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('referrer-policy')).toBe('same-origin');
      expect(res.headers.get('set-cookie')).toBeNull();
      expect(await res.text()).not.toMatch(/<script/i);
    });

    const badIds = [
      'Bad Slug',
      '-x',
      'x-',
      'a',
      'a--b',
      'Ünï',
      '../x',
      'x_y',
      '',
      'a'.repeat(33),
      'owner',
      'worker',
      'system',
    ];

    it.each(badIds.map((id) => [JSON.stringify(id), id]))(
      'create-new with %s → 422, no agent, no code',
      async (_label, id) => {
        const clientId = await registerClient(app, 'Invalid Ids');
        const form = await consentForm(app, clientId, pkce().challenge);
        const res = await approve(app, form, { agent: NEW_AGENT, newAgentId: id });
        expect(res.status).toBe(422);
        expect(res.headers.get('location')).toBeNull();
        const page = parseConsent(await res.text());
        expect(page.newAgentId).toBe(id); // kept for the owner to fix
        expect(page.html).not.toContain(OWNER_PASSWORD);
        expect(await codeCount(clientId)).toBe(0);
        expect(await app.sql`SELECT 1 FROM agents WHERE agent_id = ${id}`).toHaveLength(0);
      },
    );

    it('create-new with an existing id, or a forged select value (unknown or disabled agent) → 422', async () => {
      const existing = testAgent('exists');
      await staticToken(app, existing);
      const disabled = testAgent('off');
      await staticToken(app, disabled);
      await owner`UPDATE agents SET disabled_at = now() WHERE agent_id = ${disabled}`;
      const clientId = await registerClient(app, 'Forgery');
      const form = await consentForm(app, clientId, pkce().challenge);
      for (const choice of [
        { agent: NEW_AGENT, newAgentId: existing },
        { agent: 'no-such-agent-here' },
        { agent: disabled },
      ]) {
        const res = await approve(app, form, choice);
        expect(res.status).toBe(422);
        expect(res.headers.get('location')).toBeNull();
      }
      expect(await codeCount(clientId)).toBe(0);
      expect(
        await app.sql`SELECT 1 FROM agents WHERE agent_id = 'no-such-agent-here'`,
      ).toHaveLength(0);
    });

    it('a changed signed request is refused without redirecting', async () => {
      const clientId = await registerClient(app, 'Tamper');
      const form = await consentForm(app, clientId, pkce().challenge);
      const [payload, sig] = form.request.split('.');
      const body = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString()) as Record<
        string,
        unknown
      >;
      body.redirectUri = 'https://evil.example/cb';
      const forged = `${Buffer.from(JSON.stringify(body)).toString('base64url')}.${sig}`;
      const res = await approve(app, { ...form, request: forged });
      expect(res.status).toBe(400);
      expect(res.headers.get('location')).toBeNull();
      expect(await codeCount(clientId)).toBe(0);
    });

    it('Deny: 303 with access_denied, state and iss; logged; no code', async () => {
      const clientId = await registerClient(app, 'Deny Me');
      const form = await consentForm(app, clientId, pkce().challenge);
      const res = await postConsent(app, {
        request: form.request,
        agent: NEW_AGENT,
        new_agent_id: form.newAgentId,
        password: OWNER_PASSWORD,
        decision: 'deny',
      });
      expect(res.status).toBe(303);
      const back = new URL(res.headers.get('location') ?? '');
      expect(Object.fromEntries(back.searchParams)).toEqual({
        error: 'access_denied',
        state: 'st-123',
        iss: PUBLIC_API_URL,
      });
      expect((await consentRows(clientId))[0]?.details).toMatchObject({ decision: 'deny' });
      expect(await codeCount(clientId)).toBe(0);
      expect(await agentRow('deny-me')).toBeUndefined();
    });
  });

  describe('A17.2: authorization request and code checks', () => {
    const redirectParams = (res: Response) =>
      Object.fromEntries(new URL(res.headers.get('location') ?? '').searchParams);

    it.each([
      ['PKCE plain', { code_challenge_method: 'plain' }, 'invalid_request'],
      ['no challenge method', { code_challenge_method: null }, 'invalid_request'],
      ['no challenge', { code_challenge: null }, 'invalid_request'],
      ['a malformed challenge', { code_challenge: 'short' }, 'invalid_request'],
      ['response_type=token', { response_type: 'token' }, 'unsupported_response_type'],
      ['another resource', { resource: 'https://api.nacre.test/v1' }, 'invalid_target'],
    ])('%s → redirect with %o', async (_case, overrides, error) => {
      const clientId = await registerClient(app, 'Bad Requests');
      const res = await authorize(app, authorizeQuery(clientId, pkce().challenge, overrides));
      expect(res.status).toBe(302);
      expect(redirectParams(res)).toEqual({ error, state: 'st-123', iss: PUBLIC_API_URL });
    });

    it('no resource defaults to /mcp', async () => {
      const clientId = await registerClient(app, 'Default Resource');
      const res = await authorize(
        app,
        authorizeQuery(clientId, pkce().challenge, { resource: null }),
      );
      expect(res.status).toBe(200);
    });

    it.each([
      ['an unregistered redirect URI', { redirect_uri: 'https://client.example/other' }],
      ['a redirect URI differing only by a slash', { redirect_uri: `${REDIRECT_URI}/` }],
      ['no redirect URI', { redirect_uri: null }],
    ])('%s → an error page and no Location', async (_case, overrides) => {
      const clientId = await registerClient(app, 'Redirects');
      const res = await authorize(app, authorizeQuery(clientId, pkce().challenge, overrides));
      expect(res.status).toBe(400);
      expect(res.headers.get('location')).toBeNull();
      expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    });

    it('an unknown client → an error page; a URL-shaped client_id is flagged in the request log', async () => {
      const res = await authorize(
        app,
        authorizeQuery('https://client.example/metadata.json', pkce().challenge),
      );
      expect(res.status).toBe(400);
      expect(res.headers.get('location')).toBeNull();
      const line = requestLogs(app).find((l) => l.request_id === res.headers.get('x-request-id'));
      expect(line).toMatchObject({ oauth: 'authorize:unknown_client', client_id_is_url: true });
    });

    it('a disabled client, or an unapproved one older than 24 hours, is unknown', async () => {
      const disabled = await registerClient(app, 'Disabled');
      await app.sql`UPDATE oauth_clients SET disabled_at = now() WHERE client_id = ${disabled}`;
      const stale = await registerClient(app, 'Stale');
      await owner`UPDATE oauth_clients SET created_at = now() - interval '25 hours' WHERE client_id = ${stale}`;
      for (const clientId of [disabled, stale]) {
        const res = await authorize(app, authorizeQuery(clientId, pkce().challenge));
        expect(res.status).toBe(400);
        expect(res.headers.get('location')).toBeNull();
      }
    });

    async function codeFor(clientName: string) {
      const clientId = await registerClient(app, clientName);
      const { verifier, challenge } = pkce();
      const approved = await approve(app, await consentForm(app, clientId, challenge));
      const code = codeFrom(approved);
      secrets.push(code, verifier);
      const exchange = (overrides: Record<string, string> = {}) =>
        token(app, {
          grant_type: 'authorization_code',
          client_id: clientId,
          code,
          redirect_uri: REDIRECT_URI,
          code_verifier: verifier,
          ...overrides,
        });
      return { clientId, exchange };
    }

    it('a wrong verifier → invalid_grant, and burns the code', async () => {
      const { exchange } = await codeFor('Wrong Verifier');
      const res = await exchange({ code_verifier: pkce().verifier });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_grant' });
      expect((await exchange()).status).toBe(400);
    });

    it('a mismatched redirect_uri or resource at the token endpoint fails', async () => {
      const a = await codeFor('Token Redirect');
      expect(await (await a.exchange({ redirect_uri: `${REDIRECT_URI}/x` })).json()).toEqual({
        error: 'invalid_grant',
      });
      const b = await codeFor('Token Resource');
      expect(
        await (await b.exchange({ resource: 'https://elsewhere.example/mcp' })).json(),
      ).toEqual({
        error: 'invalid_target',
      });
    });

    it('a reused code → invalid_grant, the grant is revoked and oauth_refresh_reuse is logged', async () => {
      const { exchange } = await codeFor('Reuse Code');
      const first = await exchange();
      expect(first.status).toBe(200);
      const tokens = (await first.json()) as TokenResponse;
      secrets.push(tokens.access_token, tokens.refresh_token);
      expect(await mcpStatus(app, tokens.access_token)).toBe(200);

      const again = await exchange();
      expect(again.status).toBe(400);
      expect(await again.json()).toEqual({ error: 'invalid_grant' });
      expect(await mcpStatus(app, tokens.access_token)).toBe(401);
      const grant = (
        await app.sql<{ grant_id: string }[]>`
          SELECT grant_id FROM agent_tokens WHERE token_id = ${parseToken(tokens.access_token)?.tokenId ?? ''}`
      )[0]?.grant_id;
      const [reuse] = await app.sql<{ details: Record<string, unknown> }[]>`
        SELECT details FROM activity_log WHERE kind = 'oauth_refresh_reuse' AND target_id = ${grant ?? ''}`;
      expect(reuse?.details).toMatchObject({ what: 'code', grant_id: grant, revoked_count: 2 });
    });

    it('two concurrent exchanges of one code: one wins, the other is reuse', async () => {
      const { exchange } = await codeFor('Race Code');
      const results = await Promise.all([exchange(), exchange()]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
      const winner = (await results.find((r) => r.status === 200)?.json()) as TokenResponse;
      secrets.push(winner.access_token, winner.refresh_token);
      expect(await mcpStatus(app, winner.access_token)).toBe(401);
    });
  });

  describe('A17.3: the consent POST', () => {
    it.each([
      ['no Origin', null],
      ['a foreign Origin', 'https://evil.example'],
      ['the app origin', 'https://app.nacre.test'],
      ['Origin: null', 'null'],
    ])('%s → 403, nothing approved', async (_case, origin) => {
      const clientId = await registerClient(app, 'Origins');
      const form = await consentForm(app, clientId, pkce().challenge);
      const res = await postConsent(
        app,
        {
          request: form.request,
          agent: NEW_AGENT,
          new_agent_id: form.newAgentId,
          password: OWNER_PASSWORD,
          decision: 'approve',
        },
        origin,
      );
      expect(res.status).toBe(403);
      expect(await codeCount(clientId)).toBe(0);
      expect(await agentRow(form.newAgentId)).toBeUndefined();
    });

    it('the app origin is refused even when /mcp allows it', async () => {
      const appOrigin = 'https://app.nacre.test';
      const both = await startTestApp(appDatabaseUrl, {
        allowedOrigins: [PUBLIC_API_URL, appOrigin],
        oauthLimits: ROOMY,
      });
      try {
        const mcp = await fetch(both.mcpUrl, { method: 'POST', headers: { origin: appOrigin } });
        expect(mcp.status).toBe(401); // past the Origin check, stopped by auth
        const clientId = await registerClient(both, 'App Origin');
        const form = await consentForm(both, clientId, pkce().challenge);
        const res = await postConsent(
          both,
          {
            request: form.request,
            agent: NEW_AGENT,
            new_agent_id: form.newAgentId,
            password: OWNER_PASSWORD,
            decision: 'approve',
          },
          appOrigin,
        );
        expect(res.status).toBe(403);
      } finally {
        await both.close();
      }
    });
  });

  describe('A17.4 and A17.5: tokens', () => {
    it('an expired access token gets 401', async () => {
      const { tokens } = await connect(app, 'Expiry');
      secrets.push(tokens.access_token, tokens.refresh_token);
      await owner`
        UPDATE agent_tokens SET expires_at = now() - interval '1 second'
        WHERE token_id = ${parseToken(tokens.access_token)?.tokenId ?? ''}`;
      expect(await mcpStatus(app, tokens.access_token)).toBe(401);
    });

    it('refresh rotates; the old refresh token coming back revokes the grant and is logged', async () => {
      const { clientId, tokens } = await connect(app, 'Rotation');
      secrets.push(tokens.access_token, tokens.refresh_token);
      const refresh = (refreshToken: string) =>
        token(app, {
          grant_type: 'refresh_token',
          client_id: clientId,
          refresh_token: refreshToken,
        });

      const res = await refresh(tokens.refresh_token);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('pragma')).toBe('no-cache');
      const next = (await res.json()) as TokenResponse;
      secrets.push(next.access_token, next.refresh_token);
      expect(next).toMatchObject({ token_type: 'Bearer', expires_in: 3600 });
      expect(next.refresh_token).not.toBe(tokens.refresh_token);
      expect(await mcpStatus(app, next.access_token)).toBe(200);
      // The new refresh token keeps the grant's expiry (30 days from consent, not from each refresh).
      const expiries = await app.sql<{ expires_at: Date }[]>`
        SELECT expires_at FROM agent_tokens
        WHERE token_id IN (${parseToken(tokens.refresh_token)?.tokenId ?? ''}, ${parseToken(next.refresh_token)?.tokenId ?? ''})`;
      expect(new Set(expiries.map((e) => e.expires_at.getTime())).size).toBe(1);

      const reused = await refresh(tokens.refresh_token);
      expect(reused.status).toBe(400);
      expect(await reused.json()).toEqual({ error: 'invalid_grant' });
      expect(await mcpStatus(app, next.access_token)).toBe(401);
      expect((await refresh(next.refresh_token)).status).toBe(400);
      const oldId = parseToken(tokens.refresh_token)?.tokenId;
      const [entry] = await app.sql<{ details: Record<string, unknown>; token_id: string }[]>`
        SELECT details, token_id FROM activity_log WHERE kind = 'oauth_refresh_reuse' AND token_id = ${oldId ?? ''}`;
      expect(entry?.details).toMatchObject({ what: 'refresh', token_id: oldId, revoked_count: 4 });
    });

    it('two concurrent refreshes with one token: exactly one wins, and the grant is revoked', async () => {
      const { clientId, tokens } = await connect(app, 'Refresh Race');
      secrets.push(tokens.access_token, tokens.refresh_token);
      const both = await Promise.all(
        [1, 2].map(() =>
          token(app, {
            grant_type: 'refresh_token',
            client_id: clientId,
            refresh_token: tokens.refresh_token,
          }),
        ),
      );
      expect(both.map((r) => r.status).sort()).toEqual([200, 400]);
      const winner = (await both.find((r) => r.status === 200)?.json()) as TokenResponse;
      secrets.push(winner.access_token, winner.refresh_token);
      expect(await mcpStatus(app, winner.access_token)).toBe(401);
    });

    it('a refresh token from another client, or an access token as a refresh token, fails', async () => {
      const a = await connect(app, 'Client A');
      const b = await connect(app, 'Client B');
      secrets.push(
        a.tokens.access_token,
        a.tokens.refresh_token,
        b.tokens.access_token,
        b.tokens.refresh_token,
      );
      const wrongClient = await token(app, {
        grant_type: 'refresh_token',
        client_id: b.clientId,
        refresh_token: a.tokens.refresh_token,
      });
      expect(await wrongClient.json()).toEqual({ error: 'invalid_grant' });
      const accessAsRefresh = await token(app, {
        grant_type: 'refresh_token',
        client_id: a.clientId,
        refresh_token: a.tokens.access_token,
      });
      expect(await accessAsRefresh.json()).toEqual({ error: 'invalid_grant' });
      // Neither counted as reuse: A's grant still works.
      expect(await mcpStatus(app, a.tokens.access_token)).toBe(200);
    });

    it('a disabled agent gets no tokens: the code exchange and a refresh both fail', async () => {
      const agent = testAgent('dis-oauth');
      await staticToken(app, agent);
      const refreshing = await connect(app, 'Disabled Later', { agent });
      secrets.push(refreshing.tokens.access_token, refreshing.tokens.refresh_token);
      const clientId = await registerClient(app, 'Disabled Before Exchange');
      const { verifier, challenge } = pkce();
      const approved = await approve(app, await consentForm(app, clientId, challenge), { agent });
      await owner`UPDATE agents SET disabled_at = now() WHERE agent_id = ${agent}`;
      const exchanged = await token(app, {
        grant_type: 'authorization_code',
        client_id: clientId,
        code: codeFrom(approved),
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      });
      expect(await exchanged.json()).toEqual({ error: 'invalid_grant' });
      const refreshed = await token(app, {
        grant_type: 'refresh_token',
        client_id: refreshing.clientId,
        refresh_token: refreshing.tokens.refresh_token,
      });
      expect(await refreshed.json()).toEqual({ error: 'invalid_grant' });
    });

    it('A17.5: an OAuth access token is refused on /v1; a refresh token is refused on /mcp', async () => {
      const { tokens } = await connect(app, 'Routes');
      secrets.push(tokens.access_token, tokens.refresh_token);
      const verify = (t: string, route: 'mcp' | 'v1') =>
        verifyToken(
          { sql: app.sql, pepper: app.pepper, mcpResource: MCP_RESOURCE },
          `Bearer ${t}`,
          route,
        );
      expect(await verify(tokens.access_token, 'v1')).toMatchObject({
        ok: false,
        reason: 'wrong_route',
      });
      expect(await mcpStatus(app, tokens.refresh_token)).toBe(401);
    });

    it('token endpoint refusals are plain OAuth errors', async () => {
      const clientId = await registerClient(app, 'Token Errors');
      const cases: [Record<string, string>, number, string][] = [
        [{ grant_type: 'client_credentials', client_id: clientId }, 400, 'unsupported_grant_type'],
        [{ grant_type: 'password', client_id: clientId }, 400, 'unsupported_grant_type'],
        [{ client_id: clientId }, 400, 'invalid_request'],
        [{ grant_type: 'refresh_token' }, 401, 'invalid_client'],
        [{ grant_type: 'refresh_token', client_id: 'cli_nope' }, 401, 'invalid_client'],
        [
          { grant_type: 'refresh_token', client_id: clientId, client_secret: 'x' },
          401,
          'invalid_client',
        ],
        [
          { grant_type: 'refresh_token', client_id: clientId, refresh_token: 'nope' },
          400,
          'invalid_grant',
        ],
        [
          {
            grant_type: 'authorization_code',
            client_id: clientId,
            code: 'x',
            redirect_uri: REDIRECT_URI,
            code_verifier: 'short',
          },
          400,
          'invalid_request',
        ],
        [
          {
            grant_type: 'authorization_code',
            client_id: clientId,
            code: 'x',
            redirect_uri: REDIRECT_URI,
            code_verifier: pkce().verifier,
          },
          400,
          'invalid_grant',
        ],
      ];
      for (const [form, status, error] of cases) {
        const res = await token(app, form);
        expect([res.status, await res.json()]).toEqual([status, { error }]);
        expect(res.headers.get('cache-control')).toBe('no-store');
      }
      const json = await fetch(at(app, '/oauth/token'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(await json.json()).toEqual({ error: 'invalid_request' });
    });
  });

  describe('registration', () => {
    it('a public client gets 201, a cli_ id and no secret; the request is kept as received', async () => {
      const body = {
        client_name: 'Kept',
        redirect_uris: [
          'http://127.0.0.1:8123/cb',
          'http://[::1]:9/cb',
          'http://localhost/cb',
          'https://claude.ai/api/mcp/auth_callback',
        ],
        token_endpoint_auth_method: 'none',
        logo_uri: 'https://client.example/logo.png',
        something_unknown: { nested: true },
      };
      const res = await register(app, body);
      expect(res.status).toBe(201);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json.client_id).toMatch(/^cli_[0-9A-Z]{26}$/);
      expect(typeof json.client_id_issued_at).toBe('number');
      expect(json).not.toHaveProperty('client_secret');
      expect(json).toMatchObject({
        client_name: 'Kept',
        redirect_uris: body.redirect_uris,
        token_endpoint_auth_method: 'none',
      });
      const [row] = await app.sql<{ metadata: unknown; approved_at: Date | null }[]>`
        SELECT metadata, approved_at FROM oauth_clients WHERE client_id = ${json.client_id as string}`;
      expect(row).toEqual({ metadata: body, approved_at: null });
      const [entry] = await app.sql<{ actor: string; details: unknown }[]>`
        SELECT actor, details FROM activity_log WHERE kind = 'oauth_client_register' AND target_id = ${json.client_id as string}`;
      expect(entry).toEqual({
        actor: 'system',
        details: { redirect_hosts: ['127.0.0.1:8123', '[::1]:9', 'localhost', 'claude.ai'] },
      });
    });

    it.each([
      ['http on a public host', ['http://evil.example/cb']],
      ['a fragment', ['https://client.example/cb#frag']],
      ['an empty fragment', ['https://client.example/cb#']],
      ['userinfo', ['https://user@client.example/cb']],
      ['empty userinfo', ['https://@client.example/cb']],
      ['a custom scheme', ['cursor://anysphere.cursor-retrieval/oauth/callback']],
      ['not a URL', ['not a url']],
      ['none', []],
      ['six', Array.from({ length: 6 }, (_, i) => `https://client.example/${i}`)],
      ['not a list', 'https://client.example/cb'],
    ])('%s → 400 invalid_redirect_uri', async (_case, redirectUris) => {
      const res = await register(app, { redirect_uris: redirectUris });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_redirect_uri' });
    });

    it.each([
      ['a confidential client', { token_endpoint_auth_method: 'client_secret_basic' }],
      ['a long name', { client_name: 'x'.repeat(129) }],
      ['a non-string name', { client_name: 42 }],
    ])('%s → 400 invalid_client_metadata', async (_case, extra) => {
      const res = await register(app, { redirect_uris: [REDIRECT_URI], ...extra });
      expect(await res.json()).toEqual({ error: 'invalid_client_metadata' });
    });

    it('a body over the cap → 413 invalid_client_metadata', async () => {
      const res = await register(app, { redirect_uris: [REDIRECT_URI], pad: 'x'.repeat(9000) });
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ error: 'invalid_client_metadata' });
    });
  });

  it('nothing leaks: no log line or activity row holds the password, a code, a verifier or a token', async () => {
    const logs = app.logLines.join('\n');
    const activity = JSON.stringify(
      await app.sql`SELECT * FROM activity_log WHERE kind LIKE 'oauth%' OR kind LIKE 'token%'`,
    );
    const real = secrets.filter((s) => s.length >= 16);
    expect(real.length).toBeGreaterThan(20);
    for (const secret of real) {
      expect(logs).not.toContain(secret);
      expect(activity).not.toContain(secret);
    }
  });
});

describe.skipIf(!appDatabaseUrl)('A17.3 and registration: the spec limits, on fresh apps', () => {
  it('wrong passwords: 403 with no code; after 5, even the right password gets 429', async () => {
    const app = await startTestApp(appDatabaseUrl, { oauthLimits: { registrationsPerHour: 1000 } });
    try {
      const clientId = await registerClient(app, 'Passwords');
      const form = await consentForm(app, clientId, pkce().challenge);
      for (let i = 0; i < 5; i++) {
        const res = await approve(app, form, { password: `wrong password ${i}` });
        expect(res.status).toBe(403);
        expect(await res.text()).toContain('Wrong owner password.');
      }
      const limited = await approve(app, form);
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(
        await app.sql`SELECT 1 FROM oauth_auth_codes WHERE client_id = ${clientId}`,
      ).toHaveLength(0);
      // Request log only: wrong passwords write no activity row.
      expect(
        await app.sql`SELECT 1 FROM activity_log WHERE kind = 'oauth_consent' AND target_id = ${clientId}`,
      ).toHaveLength(0);
      expect(requestLogs(app).filter((l) => l.oauth === 'consent:bad_password')).toHaveLength(5);
    } finally {
      await app.close();
    }
  });

  it('parallel wrong passwords cannot outrun the limit: of 12 at once, 5 are checked and 7 get 429', async () => {
    const app = await startTestApp(appDatabaseUrl, { oauthLimits: { registrationsPerHour: 1000 } });
    try {
      const clientId = await registerClient(app, 'Parallel Passwords');
      const form = await consentForm(app, clientId, pkce().challenge);
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          approve(app, form, { password: `wrong password ${i}` }),
        ),
      );
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([...Array(5).fill(403), ...Array(7).fill(429)]);
      expect(requestLogs(app).filter((l) => l.oauth === 'consent:bad_password')).toHaveLength(5);
    } finally {
      await app.close();
    }
  });

  it('a right password gives its slot back: 4 wrong, then 3 right, then the 5th wrong is still 403', async () => {
    const app = await startTestApp(appDatabaseUrl, { oauthLimits: { registrationsPerHour: 1000 } });
    try {
      const clientId = await registerClient(app, 'Refund');
      const form = await consentForm(app, clientId, pkce().challenge);
      for (let i = 0; i < 4; i++)
        expect((await approve(app, form, { password: `nope ${i}` })).status).toBe(403);
      const deny = () =>
        postConsent(app, {
          request: form.request,
          agent: NEW_AGENT,
          new_agent_id: form.newAgentId,
          password: OWNER_PASSWORD,
          decision: 'deny',
        });
      for (let i = 0; i < 3; i++) expect((await deny()).status).toBe(303);
      expect((await approve(app, form, { password: 'nope 4' })).status).toBe(403);
      expect((await approve(app, form)).status).toBe(429);
    } finally {
      await app.close();
    }
  });

  it('registration: 10 an hour, then 429 with Retry-After', async () => {
    const app = await startTestApp(appDatabaseUrl);
    try {
      for (let i = 0; i < 10; i++) {
        expect((await register(app, { redirect_uris: [REDIRECT_URI] })).status).toBe(201);
      }
      const res = await register(app, { redirect_uris: [REDIRECT_URI] });
      expect(res.status).toBe(429);
      expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(3500);
    } finally {
      await app.close();
    }
  });

  it('OWNER_PASSWORD_HASH unset: the consent POST is 503, and static tokens still work on /mcp', async () => {
    const app = await startTestApp(appDatabaseUrl, { ownerPasswordHash: null });
    try {
      const clientId = await registerClient(app, 'No Hash');
      const form = await consentForm(app, clientId, pkce().challenge);
      expect((await approve(app, form)).status).toBe(503);
      const { token: staticTok } = await staticToken(app, testAgent('nohash'));
      expect(await mcpStatus(app, staticTok)).toBe(200);
    } finally {
      await app.close();
    }
  });
});

describe.skipIf(!adminUrl)('A17.1a with an empty agents table', () => {
  const name = scratchDatabaseName('oauth_empty');
  let app: TestApp;

  beforeAll(async () => {
    const url = withDatabase(adminUrl, name);
    await dbmate(url, 'up');
    const appUrl = new URL(url);
    appUrl.username = 'nacre_app';
    app = await startTestApp(appUrl.href);
  });
  afterAll(async () => {
    await app?.close();
    await dropDatabase(adminUrl, name);
  });

  it('renders with only "Create new agent", and the flow works', async () => {
    expect(await app.sql`SELECT 1 FROM agents`).toHaveLength(0);
    const { form, tokens } = await connect(app, 'Grok Bot');
    expect(form.options).toEqual([NEW_AGENT]);
    expect(form.selected).toEqual([NEW_AGENT]);
    expect(form.newAgentId).toBe('grok-bot');
    expect(await ping(app, tokens.access_token)).toMatchObject({ agent_id: 'grok-bot' });
  });
});
