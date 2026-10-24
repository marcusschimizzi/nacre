import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Client as V1Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as V1Transport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { startTestApp, staticToken, type TestApp, testAgent } from './helpers/app.js';

// The api now checks tokens against the database, so these run only with TEST_DATABASE_URL.
const appDatabaseUrl = inject('appDatabaseUrl');
const skip = !appDatabaseUrl;

let app: TestApp;
let mcpUrl: URL;
let token: string;
const agentId = testAgent('mcp');

beforeAll(async () => {
  if (skip) return;
  app = await startTestApp(appDatabaseUrl);
  mcpUrl = app.mcpUrl;
  token = (await staticToken(app, agentId)).token;
});

afterAll(async () => {
  await app?.close();
});

const authHeaders = (value = token) => ({ Authorization: `Bearer ${value}` });

type ClientOptions = ConstructorParameters<typeof Client>[1];

async function connectV2(options: ClientOptions, headers: Record<string, string> = authHeaders()) {
  const client = new Client({ name: 'nacre-test', version: '0.0.0' }, options);
  await client.connect(new StreamableHTTPClientTransport(mcpUrl, { requestInit: { headers } }));
  return client;
}

// The slice of the client API both SDK generations share.
interface PingClient {
  listTools(): Promise<{ tools: { name: string }[] }>;
  // v1 also types a pre-2024 `{ toolResult }` shape, so read fields off a plain record.
  callTool(request: {
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<Record<string, unknown>>;
}

async function expectPing(client: PingClient) {
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name)).toContain('ping');

  const result = await client.callTool({ name: 'ping', arguments: {} });
  expect(result.isError).toBeFalsy();
  expect(result.structuredContent).toMatchObject({ pong: true, agent_id: agentId });
  const serverTime = (result.structuredContent as { server_time: string }).server_time;
  expect(Number.isNaN(Date.parse(serverTime))).toBe(false);
}

describe.skipIf(skip)('GET /healthz', () => {
  it('returns 200 without auth, with the database reachable', async () => {
    const res = await fetch(new URL('/healthz', mcpUrl));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', service: 'nacre-api', db: 'ok' });
  });
});

describe.skipIf(skip)('/mcp auth', () => {
  const initialize = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'raw', version: '0' },
    },
  };

  const post = (headers: Record<string, string>) =>
    fetch(mcpUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify(initialize),
    });

  it.each([
    ['no Authorization header', {}],
    ['a wrong token', authHeaders('not-the-token')],
    ['an empty bearer token', { Authorization: 'Bearer ' }],
    ['a different scheme', { Authorization: `Basic ${token}` }],
  ])('rejects %s with 401 and WWW-Authenticate: Bearer', async (_case, headers) => {
    const res = await post(headers);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/^Bearer\b/);
  });

  it('rejects an SDK client with a wrong token', async () => {
    await expect(connectV2({}, authHeaders('wrong'))).rejects.toThrow();
  });

  it('accepts the right token, and stays stateless (no Mcp-Session-Id)', async () => {
    const res = await post(authHeaders());
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeNull();
  });

  it('answers GET (the old SSE stream) with 405', async () => {
    const res = await fetch(mcpUrl, {
      headers: { accept: 'text/event-stream', ...authHeaders() },
    });
    expect(res.status).toBe(405);
  });

  it('never logs the token', () => {
    expect(app.logLines.length).toBeGreaterThan(0);
    expect(app.logLines.join('')).not.toContain(token);
  });

  it('logs the shape of the Authorization header, so a client that drops it is visible', () => {
    const shapes = app.logLines
      .map((line) => JSON.parse(line) as { msg?: string; path?: string; auth?: string })
      .filter((entry) => entry.msg === 'request' && entry.path === '/mcp')
      .map((entry) => entry.auth);
    expect(shapes).toEqual(expect.arrayContaining(['none', 'bearer', 'bearer-malformed', 'other']));
  });
});

describe.skipIf(skip)('MCP over Streamable HTTP', () => {
  it('2026-07-28 (stateless, no initialize): lists and calls ping', async () => {
    const client = await connectV2({ versionNegotiation: { mode: { pin: '2026-07-28' } } });
    expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
    expect(client.getProtocolEra()).toBe('modern');
    await expectPing(client);
    await client.close();
  });

  it('auto negotiation picks 2026-07-28', async () => {
    const client = await connectV2({ versionNegotiation: { mode: 'auto' } });
    expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
    await client.close();
  });

  it.each(['2025-11-25', '2025-06-18', '2025-03-26'])(
    '%s (initialize handshake): initializes, lists and calls ping',
    async (version) => {
      const client = await connectV2({ supportedProtocolVersions: [version] });
      expect(client.getNegotiatedProtocolVersion()).toBe(version);
      expect(client.getProtocolEra()).toBe('legacy');
      expect(client.getServerVersion()?.name).toBe('nacre');
      await expectPing(client);
      await client.close();
    },
  );

  it('v1 SDK client (@modelcontextprotocol/sdk 1.x): initializes, lists and calls ping', async () => {
    const client = new V1Client({ name: 'nacre-test-v1', version: '0.0.0' });
    await client.connect(new V1Transport(mcpUrl, { requestInit: { headers: authHeaders() } }));
    expect(client.getServerVersion()?.name).toBe('nacre');
    await expectPing(client);
    await client.close();
  });
});
