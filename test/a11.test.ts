import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { parseToken, revokeToken } from '../src/shared/tokens.js';
import {
  PUBLIC_API_URL,
  startTestApp,
  staticToken,
  type TestApp,
  testAgent,
} from './helpers/app.js';

const appDatabaseUrl = inject('appDatabaseUrl');

const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'a11', version: '0' },
  },
});

describe.skipIf(!appDatabaseUrl)('A11: tokens, the token-in-URL rule and Origin on /mcp', () => {
  let app: TestApp;
  const agent = testAgent('a11');
  let token: string;
  let tokenId: string;
  const seenTokens: string[] = [];

  beforeAll(async () => {
    app = await startTestApp(appDatabaseUrl);
    const created = await staticToken(app, agent);
    token = created.token;
    tokenId = created.tokenId;
    seenTokens.push(token);
  });
  afterAll(() => app?.close());

  const post = (headers: Record<string, string>, query = '') =>
    fetch(new URL(`/mcp${query}`, app.base), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: INITIALIZE,
    });
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  const requestLog = (res: Response) =>
    app.logLines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((l) => l.msg === 'request' && l.request_id === res.headers.get('x-request-id'));
  const deniedRows = (res: Response) =>
    app.sql<{ actor: string; token_id: string | null; details: { reason: string } }[]>`
      SELECT actor, token_id, details FROM activity_log
      WHERE kind = 'token_use_denied' AND request_id = ${res.headers.get('x-request-id')}`;

  it('no token → 401 with WWW-Authenticate: Bearer realm="nacre", and no activity entry', async () => {
    const res = await post({});
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer realm="nacre"');
    expect(await res.json()).toEqual({ error: 'unauthorized' });
    expect(await deniedRows(res)).toHaveLength(0);
  });

  it('a malformed header → 401 and no activity entry (discovery probes must not flood the log)', async () => {
    const res = await post({ Authorization: 'Bearer not-a-nacre-token' });
    expect(res.status).toBe(401);
    expect(await deniedRows(res)).toHaveLength(0);
  });

  it('a well-formed token with an unknown id → 401, request log only (anyone can mint these)', async () => {
    const unknown = `nacre_tok_01JAXK5W3J8N4Q2R7T9V0Y1Z2A_${'A'.repeat(43)}`;
    seenTokens.push(unknown);
    for (const res of [
      await post(bearer(unknown)),
      await post({}, `?access_token=${encodeURIComponent(unknown)}`),
    ]) {
      expect(res.status).toBe(401);
      expect(await deniedRows(res)).toHaveLength(0);
      expect((await requestLog(res))?.auth_denied).toMatch(/^(unknown_token|token_in_url)$/);
    }
    const unattributed = await app.sql`
      SELECT 1 FROM activity_log WHERE kind = 'token_use_denied' AND token_id IS NULL`;
    expect(unattributed).toHaveLength(0);
  });

  it('a created token → ping works and reports the agent', async () => {
    const client = new Client(
      { name: 'a11', version: '0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    await client.connect(
      new StreamableHTTPClientTransport(app.mcpUrl, { requestInit: { headers: bearer(token) } }),
    );
    const result = await client.callTool({ name: 'ping', arguments: {} });
    expect(result.structuredContent).toMatchObject({ pong: true, agent_id: agent });
    await client.close();
  });

  it('?access_token=<valid token> → 401 even with a valid header, logged as token_in_url', async () => {
    const res = await post(bearer(token), `?access_token=${encodeURIComponent(token)}`);
    expect(res.status).toBe(401);
    expect(await deniedRows(res)).toEqual([
      { actor: agent, token_id: tokenId, details: { reason: 'token_in_url' } },
    ]);
  });

  it('<real id, wrong secret> in the header → 401, request log only (ids are not secret)', async () => {
    const wrongSecret = `nacre_${tokenId}_${'C'.repeat(43)}`;
    seenTokens.push(wrongSecret);
    const res = await post(bearer(wrongSecret));
    expect(res.status).toBe(401);
    expect(await deniedRows(res)).toHaveLength(0);
    expect((await requestLog(res))?.auth_denied).toBe('bad_secret');
  });

  it('?access_token=<real id, wrong secret> → 401, not attributed (ids are not secret)', async () => {
    const wrongSecret = `nacre_${tokenId}_${'B'.repeat(43)}`;
    seenTokens.push(wrongSecret);
    const res = await post({}, `?access_token=${encodeURIComponent(wrongSecret)}`);
    expect(res.status).toBe(401);
    expect(await deniedRows(res)).toHaveLength(0);
    expect((await requestLog(res))?.auth_denied).toBe('token_in_url');
  });

  it.each([
    ['?token=anything', '?token=anything'],
    ['a token-looking value under another name', '?q=nacre_tok_whatever'],
  ])('%s → 401', async (_case, query) => {
    expect((await post(bearer(token), query)).status).toBe(401);
  });

  it('Origin: https://evil.example with a valid token → 403, before auth', async () => {
    expect((await post({ ...bearer(token), Origin: 'https://evil.example' })).status).toBe(403);
    expect((await post({ Origin: 'https://evil.example' })).status).toBe(403); // not 401: Origin first
    expect((await post({ ...bearer(token), Origin: 'null' })).status).toBe(403);
  });

  it('Origin equal to PUBLIC_API_URL, or none → passes', async () => {
    expect((await post({ ...bearer(token), Origin: PUBLIC_API_URL })).status).toBe(200);
    expect((await post(bearer(token))).status).toBe(200);
  });

  it('after revoke, the same token → 401 and exactly one token_use_denied entry', async () => {
    expect(await revokeToken(app.sql, tokenId)).toBe('revoked');
    const res = await post(bearer(token));
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer realm="nacre"');
    expect(await deniedRows(res)).toEqual([
      { actor: agent, token_id: tokenId, details: { reason: 'revoked' } },
    ]);
    expect(await requestLog(res)).toMatchObject({ status: 401, auth_denied: 'revoked' });
  });

  it('nothing leaks: no log line or activity entry holds the token or its secret', async () => {
    const secret = parseToken(token)?.secret ?? '';
    expect(secret).toHaveLength(43);
    const logs = app.logLines.join('\n');
    const activity = JSON.stringify(
      await app.sql`SELECT * FROM activity_log WHERE token_id = ${tokenId} OR actor = ${agent}`,
    );
    for (const haystack of [logs, activity]) {
      expect(haystack).not.toContain(secret);
      for (const t of seenTokens) expect(haystack).not.toContain(t);
    }
    // The request log does carry who called, by public id.
    expect(logs).toContain(`"token_id":"${tokenId}"`);
    expect(logs).toContain(`"agent_id":"${agent}"`);
  });
});
