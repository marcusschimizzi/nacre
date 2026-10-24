import { createHmac, randomBytes } from 'node:crypto';
import { logActivity } from './activity.js';
import type { Sql } from './db/sql.js';
import { newId, ULID_PATTERN } from './ids.js';

/**
 * Bearer tokens (spec §4, §7): `nacre_tok_<ulid>_<secret>`. The `tok_<ulid>` part is the public
 * token id (the `agent_tokens` row key, safe to log); the secret is 32 random bytes as base64url
 * (43 characters, which can include `_`). Only HMAC-SHA256(TOKEN_PEPPER, secret) is stored.
 * Static and OAuth tokens share the format and the verifier.
 */
const TOKEN = new RegExp(`^nacre_(tok_${ULID_PATTERN})_([A-Za-z0-9_-]{43})$`);
const SECRET_BYTES = 32;

export type TokenKind = 'static' | 'oauth_access' | 'oauth_refresh';

export interface ParsedToken {
  tokenId: string;
  secret: string;
}

/** Split a token by fixed positions (the secret may contain `_`); null if it isn't one. */
export function parseToken(token: string): ParsedToken | null {
  const m = TOKEN.exec(token);
  return m?.[1] && m[2] ? { tokenId: m[1], secret: m[2] } : null;
}

export const formatToken = (tokenId: string, secret: string): string =>
  `nacre_${tokenId}_${secret}`;

export const hashSecret = (pepper: string, secret: string): Buffer =>
  createHmac('sha256', pepper).update(secret, 'utf8').digest();

/** A fresh token id, secret and stored hash. The token string is shown once and never stored. */
export function mintToken(pepper: string): { tokenId: string; token: string; secretHash: Buffer } {
  const tokenId = newId('tok');
  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  return { tokenId, token: formatToken(tokenId, secret), secretHash: hashSecret(pepper, secret) };
}

export interface CreateStaticTokenInput {
  agentId: string;
  clientKind?: string;
  note?: string | null;
  expiresAt?: Date | null;
}

export interface CreatedToken {
  tokenId: string;
  token: string;
  agentId: string;
  agentCreated: boolean;
  agentDisabled: boolean;
}

/**
 * `nacre token create`: make the agent if it's missing, insert a static token with the §4 defaults
 * (full scope, `resource` NULL) and log `token_create`, all in one transaction.
 */
export async function createStaticToken(
  sql: Sql,
  pepper: string,
  input: CreateStaticTokenInput,
): Promise<CreatedToken> {
  const minted = mintToken(pepper);
  return sql.begin(async (tx) => {
    const inserted = await tx`
      INSERT INTO agents (agent_id, display_name, client_kind)
      VALUES (${input.agentId}, ${input.agentId}, ${input.clientKind ?? 'cli'})
      ON CONFLICT (agent_id) DO NOTHING
      RETURNING agent_id`;
    const [agent] = await tx<{ disabled: boolean }[]>`
      SELECT disabled_at IS NOT NULL AS disabled FROM agents WHERE agent_id = ${input.agentId}`;
    await tx`
      INSERT INTO agent_tokens (token_id, agent_id, secret_hash, kind, note, expires_at)
      VALUES (${minted.tokenId}, ${input.agentId}, ${minted.secretHash}, 'static',
              ${input.note ?? null}, ${input.expiresAt ?? null})`;
    await logActivity(tx, {
      kind: 'token_create',
      actor: 'owner',
      tokenId: minted.tokenId,
      targetKind: 'agent_token',
      targetId: minted.tokenId,
      details: { agent_id: input.agentId, kind: 'static', agent_created: inserted.length > 0 },
    });
    return {
      tokenId: minted.tokenId,
      token: minted.token,
      agentId: input.agentId,
      agentCreated: inserted.length > 0,
      agentDisabled: agent?.disabled ?? false,
    };
  });
}

export type RevokeResult = 'revoked' | 'already_revoked' | 'not_found';

/** `nacre token revoke`: set `revoked_at` once and log `token_revoke`. Grant-wide revoke is task 3b. */
export async function revokeToken(sql: Sql, tokenId: string): Promise<RevokeResult> {
  return sql.begin(async (tx) => {
    const [row] = await tx<{ agent_id: string; revoked: boolean }[]>`
      SELECT agent_id, revoked_at IS NOT NULL AS revoked FROM agent_tokens
      WHERE token_id = ${tokenId} FOR UPDATE`;
    if (!row) return 'not_found';
    if (row.revoked) return 'already_revoked';
    await tx`UPDATE agent_tokens SET revoked_at = now() WHERE token_id = ${tokenId}`;
    await logActivity(tx, {
      kind: 'token_revoke',
      actor: 'owner',
      tokenId,
      targetKind: 'agent_token',
      targetId: tokenId,
      details: { agent_id: row.agent_id },
    });
    return 'revoked';
  });
}

export interface TokenListing {
  token_id: string;
  agent_id: string;
  kind: TokenKind;
  created_at: Date;
  last_used_at: Date | null;
  expires_at: Date | null;
  revoked_at: Date | null;
}

/** `nacre token list`: never secrets or hashes. */
export const listTokens = (sql: Sql): Promise<TokenListing[]> =>
  sql<TokenListing[]>`
    SELECT token_id, agent_id, kind, created_at, last_used_at, expires_at, revoked_at
    FROM agent_tokens ORDER BY created_at`;
