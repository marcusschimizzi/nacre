import { randomBytes } from 'node:crypto';
import { createApp } from '../../src/api/app.js';
import type { OAuthLimits } from '../../src/api/oauth/routes.js';
import { type RunningServer, startServer } from '../../src/api/server.js';
import type { EventLimits } from '../../src/api/v1/events.js';
import { createSql, type Sql } from '../../src/shared/db/sql.js';
import { createLogger } from '../../src/shared/logger.js';
import { hashOwnerPassword } from '../../src/shared/password.js';
import { createStaticToken, mintToken, type TokenKind } from '../../src/shared/tokens.js';

export const PUBLIC_API_URL = 'https://api.nacre.test';
export const MCP_RESOURCE = `${PUBLIC_API_URL}/mcp`;
/** `/mcp`'s 401 challenge (spec §9.3). */
export const CHALLENGE = `Bearer realm="nacre", resource_metadata="${PUBLIC_API_URL}/.well-known/oauth-protected-resource/mcp"`;

/** The consent form's owner password in tests, hashed with the cheapest argon2id parameters. */
export const OWNER_PASSWORD = 'test owner password';
const ownerPasswordHash = hashOwnerPassword(OWNER_PASSWORD, {
  memory: 8,
  passes: 1,
  parallelism: 1,
});

export interface TestAppOptions {
  /** Default: a hash of `OWNER_PASSWORD`. `null`: unset, as before the variable is configured. */
  ownerPasswordHash?: string | null;
  /** Default: the spec's limits. */
  oauthLimits?: Partial<OAuthLimits>;
  /** Origins allowed on /mcp and /v1; default `[PUBLIC_API_URL]`. */
  allowedOrigins?: string[];
  /** Default: 120 events a minute per agent. */
  eventLimits?: Partial<EventLimits>;
  /** The hub's clock; default the real one. */
  now?: () => Date;
}

export interface TestApp {
  base: URL;
  mcpUrl: URL;
  /** Every log line the api wrote. */
  logLines: string[];
  /** As nacre_app, like the api. */
  sql: Sql;
  pepper: string;
  close(): Promise<void>;
}

/** A real api on a free port, against the scratch database as nacre_app, with a fresh pepper. */
export async function startTestApp(
  appDatabaseUrl: string,
  options: TestAppOptions = {},
): Promise<TestApp> {
  const logLines: string[] = [];
  const log = createLogger('nacre-api-test', 'debug', { write: (line) => logLines.push(line) });
  const sql = createSql(appDatabaseUrl, { max: 4 });
  const pepper = randomBytes(32).toString('base64url');
  const hash =
    options.ownerPasswordHash === undefined ? await ownerPasswordHash : options.ownerPasswordHash;
  const app = createApp({
    sql,
    config: {
      TOKEN_PEPPER: pepper,
      PUBLIC_API_URL,
      allowedOrigins: options.allowedOrigins ?? [PUBLIC_API_URL],
      ...(hash ? { OWNER_PASSWORD_HASH: hash } : {}),
    },
    log,
    ...(options.oauthLimits ? { oauthLimits: options.oauthLimits } : {}),
    ...(options.eventLimits ? { eventLimits: options.eventLimits } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  const server: RunningServer = await startServer(app, 0, '127.0.0.1');
  const base = new URL(`http://127.0.0.1:${server.port}`);
  return {
    base,
    mcpUrl: new URL('/mcp', base),
    logLines,
    sql,
    pepper,
    close: async () => {
      await server.close();
      await sql.end();
    },
  };
}

/** A unique agent id, so test files sharing one database never collide. */
export const testAgent = (label: string): string =>
  `test-${label}-${randomBytes(3).toString('hex')}`;

export async function staticToken(app: TestApp, agentId: string, expiresAt: Date | null = null) {
  return createStaticToken(app.sql, app.pepper, { agentId, expiresAt });
}

export interface OAuthFixture {
  kind: Extract<TokenKind, 'oauth_access' | 'oauth_refresh'>;
  resource?: string;
  expiresAt?: Date;
}

/**
 * An OAuth token row, inserted directly (task 3b will issue these through /oauth/token). Needs the
 * agent to exist; creates a client for it.
 */
export async function oauthToken(
  app: TestApp,
  agentId: string,
  fixture: OAuthFixture,
): Promise<string> {
  const clientId = `cli_test_${randomBytes(6).toString('hex')}`;
  await app.sql`
    INSERT INTO oauth_clients (client_id, client_name, redirect_uris, metadata)
    VALUES (${clientId}, 'test client', ${['https://claude.ai/cb']}, ${app.sql.json({})})`;
  const minted = mintToken(app.pepper);
  await app.sql`
    INSERT INTO agent_tokens (token_id, agent_id, secret_hash, kind, oauth_client_id, grant_id,
                              resource, expires_at)
    VALUES (${minted.tokenId}, ${agentId}, ${minted.secretHash}, ${fixture.kind}, ${clientId},
            ${`grt_test_${randomBytes(6).toString('hex')}`}, ${fixture.resource ?? MCP_RESOURCE},
            ${fixture.expiresAt ?? new Date(Date.now() + 3_600_000)})`;
  return minted.token;
}
