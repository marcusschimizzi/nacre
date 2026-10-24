import { timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { logActivity } from '../shared/activity.js';
import type { Sql } from '../shared/db/sql.js';
import type { Logger } from '../shared/logger.js';
import { hashSecret, parseToken, type TokenKind } from '../shared/tokens.js';
import type { AppEnv, AuthContext } from './env.js';

const BEARER = /^Bearer +(\S+) *$/i;

/**
 * The shape of the Authorization header, never its value: lets the request log show whether a
 * client sent a usable bearer token, sent nothing, or mangled it (e.g. "Bearer Bearer …").
 */
export type AuthShape = 'none' | 'bearer' | 'bearer-malformed' | 'other';

export function authShape(header: string | undefined): AuthShape {
  if (!header) return 'none';
  if (BEARER.test(header)) return 'bearer';
  return /^Bearer\b/i.test(header) ? 'bearer-malformed' : 'other';
}

/** `mcp`: the MCP endpoint (static and OAuth access tokens). `v1`: the REST API (static only). */
export type AuthRoute = 'mcp' | 'v1';

export type DenyReason =
  | 'unknown_token'
  | 'bad_secret'
  | 'revoked'
  | 'expired'
  | 'agent_disabled'
  | 'refresh_token_as_bearer'
  | 'wrong_route'
  | 'wrong_resource'
  | 'token_in_url';

export type VerifyResult =
  | { ok: true; auth: AuthContext }
  /** Missing or malformed header: nothing to attribute, so no activity entry. */
  | { ok: false; wellFormed: false }
  /** A well-formed token was rejected; `agentId` and `tokenId` are set only if its row exists. */
  | {
      ok: false;
      wellFormed: true;
      reason: DenyReason;
      tokenId: string | null;
      agentId: string | null;
    };

export interface VerifierDeps {
  sql: Sql;
  pepper: string;
  /** `PUBLIC_API_URL + '/mcp'`: the only resource OAuth access tokens are valid for. */
  mcpResource: string;
}

interface TokenRow {
  agent_id: string;
  secret_hash: Buffer;
  kind: TokenKind;
  resource: string | null;
  oauth_client_id: string | null;
  read_scopes: string[];
  write_scopes: string[];
  label_ceiling: string;
  rights: string[];
  revoked: boolean;
  expired: boolean;
  agent_disabled: boolean;
}

// Compared against when no row exists, so a miss costs the same HMAC and compare as a hit.
const NO_HASH = Buffer.alloc(32);

/**
 * The one token verifier (spec §7, §9.3) for static and OAuth access tokens. The SDK's
 * `requireBearerAuth` isn't used: it rejects tokens without an expiry, and static tokens have none.
 */
export async function verifyToken(
  deps: VerifierDeps,
  header: string | undefined,
  route: AuthRoute,
): Promise<VerifyResult> {
  const presented = BEARER.exec(header ?? '')?.[1];
  const parsed = presented === undefined ? null : parseToken(presented);
  if (!parsed) return { ok: false, wellFormed: false };

  const row = await lookup(deps.sql, parsed.tokenId);
  const matches = timingSafeEqual(
    hashSecret(deps.pepper, parsed.secret),
    row?.secret_hash ?? NO_HASH,
  );
  const deny = (reason: DenyReason): VerifyResult => ({
    ok: false,
    wellFormed: true,
    reason,
    tokenId: row ? parsed.tokenId : null,
    agentId: row?.agent_id ?? null,
  });

  if (!row) return deny('unknown_token');
  if (!matches) return deny('bad_secret');
  if (row.kind === 'oauth_refresh') return deny('refresh_token_as_bearer');
  if (row.revoked) return deny('revoked');
  if (row.expired) return deny('expired');
  if (row.agent_disabled) return deny('agent_disabled');
  if (row.kind === 'oauth_access') {
    if (route !== 'mcp') return deny('wrong_route');
    if (row.resource !== deps.mcpResource) return deny('wrong_resource');
  }

  await deps.sql`UPDATE agent_tokens SET last_used_at = now() WHERE token_id = ${parsed.tokenId}`;
  return {
    ok: true,
    auth: {
      agentId: row.agent_id,
      tokenId: parsed.tokenId,
      kind: row.kind,
      oauthClientId: row.oauth_client_id,
      readScopes: row.read_scopes,
      writeScopes: row.write_scopes,
      labelCeiling: row.label_ceiling,
      rights: row.rights,
    },
  };
}

async function lookup(sql: Sql, tokenId: string): Promise<TokenRow | undefined> {
  const [row] = await sql<TokenRow[]>`
    SELECT t.agent_id, t.secret_hash, t.kind, t.resource, t.oauth_client_id, t.read_scopes,
           t.write_scopes, t.label_ceiling, t.rights,
           t.revoked_at IS NOT NULL AS revoked,
           t.expires_at IS NOT NULL AND t.expires_at <= now() AS expired,
           a.disabled_at IS NOT NULL AS agent_disabled
    FROM agent_tokens t JOIN agents a USING (agent_id)
    WHERE t.token_id = ${tokenId}`;
  return row;
}

/**
 * The 401 challenge, built in one place. Task 3b adds `resource_metadata` here for `/mcp` (§9.3);
 * `/v1/*` keeps the plain challenge.
 */
export function bearerChallenge(_route: AuthRoute): string {
  return 'Bearer realm="nacre"';
}

export function unauthorized(c: Context<AppEnv>, route: AuthRoute): Response {
  c.header('WWW-Authenticate', bearerChallenge(route));
  return c.json({ error: 'unauthorized' }, 401);
}

const URL_TOKEN_PARAMS = new Set(['access_token', 'token']);
const TOKEN_LIKE = /nacre_tok_/i;

/** A token-carrying query string (spec §7: never accepted, even next to a valid header). */
function urlToken(c: Context<AppEnv>): { found: boolean; token?: string } {
  for (const [key, values] of Object.entries(c.req.queries())) {
    const tokenValue = values.find((v) => TOKEN_LIKE.test(v));
    if (tokenValue !== undefined) return { found: true, token: tokenValue };
    if (URL_TOKEN_PARAMS.has(key.toLowerCase())) return { found: true, token: values[0] };
  }
  return { found: false };
}

export interface TokenAuthOptions extends VerifierDeps {
  route: AuthRoute;
  log: Logger;
}

/**
 * Hono middleware: verify the bearer token, reject tokens in the URL, log `token_use_denied` for
 * rejected well-formed tokens, and put the caller on the context. Every failure is the same 401.
 */
export function tokenAuth(options: TokenAuthOptions): MiddlewareHandler<AppEnv> {
  const { route, log } = options;

  const denied = async (
    c: Context<AppEnv>,
    reason: DenyReason,
    tokenId: string | null,
    agentId: string | null,
  ) => {
    try {
      await logActivity(options.sql, {
        kind: 'token_use_denied',
        actor: agentId ?? 'unknown',
        tokenId,
        requestId: c.get('requestId'),
        targetKind: 'route',
        targetId: route,
        details: { reason },
      });
    } catch (err) {
      // A logging failure must never turn a 401 into a 500.
      log.warn(
        { err: { name: (err as Error).name, message: (err as Error).message } },
        'token_use_denied not logged',
      );
    }
  };

  return async (c, next) => {
    const inUrl = urlToken(c);
    if (inUrl.found) {
      const parsed = inUrl.token ? parseToken(inUrl.token) : null;
      if (parsed) {
        const row = await lookup(options.sql, parsed.tokenId);
        await denied(c, 'token_in_url', row ? parsed.tokenId : null, row?.agent_id ?? null);
      }
      return unauthorized(c, route);
    }

    const result = await verifyToken(options, c.req.header('authorization'), route);
    if (!result.ok) {
      if (result.wellFormed) await denied(c, result.reason, result.tokenId, result.agentId);
      return unauthorized(c, route);
    }
    c.set('auth', result.auth);
    await next();
  };
}
