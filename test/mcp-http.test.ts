import { randomBytes } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Client as V1Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as V1Transport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/api/app.js';
import { type RunningServer, startServer } from '../src/api/server.js';
import { createLogger } from '../src/shared/logger.js';

const token = randomBytes(32).toString('base64url');
const logLines: string[] = [];

let server: RunningServer;
let mcpUrl: URL;

beforeAll(async () => {
  const log = createLogger('nacre-api-test', 'debug', { write: (line) => logLines.push(line) });
  server = await startServer(createApp({ token, log }), 0, '127.0.0.1');
  mcpUrl = new URL(`http://127.0.0.1:${server.port}/mcp`);
});

afterAll(async () => {
  await server.close();
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
  expect(result.structuredContent).toMatchObject({ pong: true });
  const serverTime = (result.structuredContent as { server_time: string }).server_time;
  expect(Number.isNaN(Date.parse(serverTime))).toBe(false);
}

describe('GET /healthz', () => {
  it('returns 200 without auth', async () => {
    const res = await fetch(new URL('/healthz', mcpUrl));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', service: 'nacre-api' });
  });
});

describe('/mcp auth', () => {
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
    expect(logLines.length).toBeGreaterThan(0);
    expect(logLines.join('')).not.toContain(token);
  });
});

describe('MCP over Streamable HTTP', () => {
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
