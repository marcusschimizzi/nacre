import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { buildInfo } from '../shared/build-info.js';
import type { Logger } from '../shared/logger.js';

const pingOutput = z.object({
  pong: z.literal(true),
  server_time: z.string().describe('Server clock, ISO 8601 UTC'),
});

function buildServer(): McpServer {
  const server = new McpServer({ name: 'nacre', version: buildInfo.version });

  server.registerTool(
    'ping',
    {
      title: 'Ping',
      description: 'Check that the Nacre memory server is reachable. Returns the server time.',
      inputSchema: z.object({}),
      outputSchema: pingOutput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const result = { pong: true as const, server_time: new Date().toISOString() };
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  );

  return server;
}

/**
 * One endpoint for both protocol eras (see docs/spike-mcp.md):
 * - 2026-07-28 requests carry their version in `_meta` and are served statelessly;
 * - 2025-era clients (`initialize` handshake) get a fresh server per request, no session id,
 *   and 405 on GET/DELETE, which both SDK client generations treat as "no SSE stream".
 * Auth happens before this, in the bearer middleware.
 */
export function createMcpEndpoint(log: Logger): (request: Request) => Promise<Response> {
  const handler = createMcpHandler(() => buildServer(), {
    legacy: 'stateless',
    onerror: (err) => log.warn({ err: { name: err.name, message: err.message } }, 'mcp error'),
  });
  return (request) => handler.fetch(request);
}
