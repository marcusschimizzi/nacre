// Connect to a Nacre MCP endpoint with the official SDK in each protocol era, list tools and
// call `ping`. Usage: NACRE_TOKEN=… pnpm mcp:smoke [url]   (default http://localhost:3000/mcp)
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

type ClientOptions = ConstructorParameters<typeof Client>[1];

const url = new URL(process.argv[2] ?? process.env.NACRE_URL ?? 'http://localhost:3000/mcp');
const token = process.env.NACRE_TOKEN;
if (!token) {
  console.error('Set NACRE_TOKEN.');
  process.exit(2);
}

const modes: [string, ClientOptions][] = [
  ['2026-07-28 (pinned)', { versionNegotiation: { mode: { pin: '2026-07-28' } } }],
  ['auto', { versionNegotiation: { mode: 'auto' } }],
  ['legacy 2025-11-25', { supportedProtocolVersions: ['2025-11-25'] }],
  ['legacy 2025-06-18', { supportedProtocolVersions: ['2025-06-18'] }],
  ['legacy 2025-03-26', { supportedProtocolVersions: ['2025-03-26'] }],
];

let failed = false;
console.log(`MCP smoke test against ${url.href}`);
for (const [label, options] of modes) {
  const client = new Client({ name: 'nacre-smoke', version: '0.1.0' }, options);
  try {
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    const { tools } = await client.listTools();
    const result = await client.callTool({ name: 'ping', arguments: {} });
    console.log(
      `ok   ${label.padEnd(20)} negotiated=${client.getNegotiatedProtocolVersion()} ` +
        `era=${client.getProtocolEra()} tools=[${tools.map((t) => t.name).join(',')}] ` +
        `ping=${JSON.stringify(result.structuredContent)}`,
    );
  } catch (err) {
    failed = true;
    console.log(`FAIL ${label.padEnd(20)} ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await client.close().catch(() => {});
  }
}
process.exit(failed ? 1 : 0);
