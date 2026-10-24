import { type AuthInfo, createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { buildInfo } from '../shared/build-info.js';
import type { Logger } from '../shared/logger.js';
import type { AuthContext } from './env.js';

const pingOutput = z.object({
  pong: z.literal(true),
  server_time: z.string().describe('Server clock, ISO 8601 UTC'),
  agent_id: z.string().nullable().describe('The agent the calling token belongs to'),
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
    async (_args, ctx) => {
      const caller = ctx.http?.authInfo?.extra?.agentId;
      const result = {
        pong: true as const,
        server_time: new Date().toISOString(),
        agent_id: typeof caller === 'string' ? caller : null,
      };
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
 * Auth happens before this, in the token middleware; the caller reaches tools as `ctx.http.authInfo`.
 */
export function createMcpEndpoint(
  log: Logger,
): (request: Request, auth: AuthContext | undefined) => Promise<Response> {
  const handler = createMcpHandler(() => buildServer(), {
    legacy: 'stateless',
    onerror: (err) => log.warn({ err: { name: err.name, message: err.message } }, 'mcp error'),
  });
  return (request, auth) => handler.fetch(request, auth ? { authInfo: toAuthInfo(auth) } : {});
}

/**
 * The SDK's shape for a verified caller. `token` holds the public token id, never the secret, so a
 * tool that logs or echoes its auth info can't leak it.
 */
function toAuthInfo(auth: AuthContext): AuthInfo {
  return {
    token: auth.tokenId,
    clientId: auth.oauthClientId ?? auth.agentId,
    scopes: [],
    extra: {
      agentId: auth.agentId,
      tokenId: auth.tokenId,
      kind: auth.kind,
      readScopes: auth.readScopes,
      writeScopes: auth.writeScopes,
      labelCeiling: auth.labelCeiling,
      rights: auth.rights,
    },
  };
}
