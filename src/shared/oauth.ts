import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { logActivity } from './activity.js';
import type { Sql, TransactionSql } from './db/sql.js';
import { newId } from './ids.js';
import { hashSecret, lockGrant, mintToken, parseToken, revokeGrantTokens } from './tokens.js';

/**
 * Minimal OAuth 2.1 for `/mcp` (spec §9.3): the grant, code and token logic behind `/oauth/*`,
 * kept out of the routes so the CLI and tests share it. One owner, one resource, no scopes.
 */

export const ACCESS_TOKEN_SECONDS = 3600;
/** A refresh token rotated this recently is a lost race, not a replay (task 3c; Copal's value). */
export const REUSE_GRACE_SECONDS = 10;
export const CONSENT_TTL_MS = 10 * 60_000;
export const REDIRECT_URIS_MAX = 5;
const REDIRECT_URI_MAX_LENGTH = 2000;
export const CLIENT_NAME_MAX_LENGTH = 128;
const DISPLAY_NAME_MAX_LENGTH = 80;

// ---------- Agent ids (spec §4) ----------

/** Activity-log actors, so never agent ids. */
const RESERVED_AGENT_IDS = new Set(['owner', 'worker', 'system']);
const AGENT_ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const AGENT_ID_MAX = 32;

export const isValidAgentId = (id: string): boolean =>
  id.length >= 2 && id.length <= AGENT_ID_MAX && AGENT_ID.test(id) && !RESERVED_AGENT_IDS.has(id);

export interface AgentChoiceRow {
  agentId: string;
  enabled: boolean;
}

export interface AgentSuggestion {
  /** The client name as an agent id, before any `-2`. */
  slug: string;
  /** The enabled agent whose id equals `slug`: the consent page preselects it. */
  matchedAgentId: string | null;
  /** What the "create new agent" field is prefilled with: `slug`, or `slug-2`, … if taken. */
  newAgentId: string;
}

const trimDashes = (s: string): string => s.replace(/^-+|-+$/g, '');

function slugify(name: string): string {
  const base = trimDashes(
    name
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-'),
  );
  let slug = trimDashes(base.slice(0, AGENT_ID_MAX));
  if (!slug) return 'agent';
  // Too short to be an id ("X") counts like not starting with a letter.
  if (!/^[a-z]/.test(slug) || slug.length < 2)
    slug = trimDashes(`agent-${slug}`.slice(0, AGENT_ID_MAX));
  return slug;
}

/**
 * The consent page's agent suggestion (spec §9.3, Decided Oct 24): match an existing enabled agent
 * by the client name's slug, else offer a new id that collides with nothing, disabled agents and
 * reserved names included. A suggestion only: nothing is chosen without the owner's Approve.
 */
export function suggestAgentId(
  clientName: string | null,
  agents: readonly AgentChoiceRow[],
): AgentSuggestion {
  const slug = slugify(clientName ?? '');
  const taken = new Set(agents.map((a) => a.agentId));
  const free = (id: string) => !taken.has(id) && isValidAgentId(id);
  const matched = agents.find((a) => a.enabled && a.agentId === slug && isValidAgentId(slug));
  let newAgentId = slug;
  for (let n = 2; !free(newAgentId); n++) {
    const suffix = `-${n}`;
    newAgentId = `${trimDashes(slug.slice(0, AGENT_ID_MAX - suffix.length))}${suffix}`;
  }
  return { slug, matchedAgentId: matched?.agentId ?? null, newAgentId };
}

// ---------- Redirect URIs (RFC 7591, RFC 8252) ----------

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);

/**
 * The only hosts an `https` redirect URI may name (task 3c, Marcus's decision after the live
 * test): exact, no subdomains, default port only. Adding one is a reviewed code change.
 */
export const OAUTH_REDIRECT_HOSTS: ReadonlySet<string> = new Set([
  'grok.com', // Grok's connectors: /connectors-oauth-exchange-code/
  'www.cursor.com', // Cursor: /agents/mcp/oauth/callback
  'claude.ai', // Claude's connectors: /api/mcp/auth_callback
  'claude.com', // Claude's connectors, newer domain
]);

/**
 * `https` on an allow-listed host, or `http` on a loopback host (any port, RFC 8252); no fragment,
 * no userinfo. Matched exactly later.
 */
export function isAllowedRedirectUri(uri: string): boolean {
  if (uri.length > REDIRECT_URI_MAX_LENGTH || uri.includes('#')) return false;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  // `@` in the authority is userinfo, even when empty (`https://@host/`).
  if (url.username || url.password || /^[a-z][a-z0-9+.-]*:\/\/[^/?]*@/i.test(uri)) return false;
  if (url.protocol === 'https:') return url.port === '' && OAUTH_REDIRECT_HOSTS.has(url.hostname);
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
}

export const isLoopbackRedirect = (uri: string): boolean =>
  LOOPBACK_HOSTS.has(new URL(uri).hostname);

// ---------- PKCE (RFC 7636), S256 only ----------

/** An S256 challenge is base64url(SHA-256(...)): exactly 43 characters. */
export const isValidCodeChallenge = (challenge: string): boolean =>
  /^[A-Za-z0-9_-]{43}$/.test(challenge);

export const isValidCodeVerifier = (verifier: string): boolean =>
  /^[A-Za-z0-9._~-]{43,128}$/.test(verifier);

export const s256 = (verifier: string): string =>
  createHash('sha256').update(verifier, 'ascii').digest('base64url');

export function pkceMatches(verifier: string, challenge: string): boolean {
  const expected = Buffer.from(s256(verifier));
  const given = Buffer.from(challenge);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

// ---------- The consent form's signed request (spec §9.3) ----------

/** What `GET /oauth/authorize` validated, carried through the consent form. */
export interface ConsentRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  state: string | null;
}

const consentKey = (pepper: string): Buffer =>
  createHmac('sha256', pepper).update('nacre-consent-v1').digest();

const mac = (pepper: string, payload: string): Buffer =>
  createHmac('sha256', consentKey(pepper)).update(payload).digest();

/** `<base64url JSON>.<base64url HMAC>`, valid for 10 minutes. */
export function signConsentRequest(
  pepper: string,
  request: ConsentRequest,
  now: number = Date.now(),
): string {
  const payload = Buffer.from(
    JSON.stringify({ v: 1, ...request, exp: now + CONSENT_TTL_MS }),
  ).toString('base64url');
  return `${payload}.${mac(pepper, payload).toString('base64url')}`;
}

/** Null when the signature is wrong (checked in constant time), the shape is off, or it expired. */
export function verifyConsentRequest(
  pepper: string,
  signed: string,
  now: number = Date.now(),
): ConsentRequest | null {
  const [payload, sig, extra] = signed.split('.');
  if (!payload || !sig || extra !== undefined) return null;
  const given = Buffer.from(sig, 'base64url');
  const expected = mac(pepper, payload);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let body: unknown;
  try {
    body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  const str = (k: string) => typeof b[k] === 'string';
  if (
    b.v !== 1 ||
    typeof b.exp !== 'number' ||
    b.exp <= now ||
    !str('clientId') ||
    !str('redirectUri') ||
    !str('codeChallenge') ||
    !str('resource') ||
    !(b.state === null || str('state'))
  ) {
    return null;
  }
  return {
    clientId: b.clientId as string,
    redirectUri: b.redirectUri as string,
    codeChallenge: b.codeChallenge as string,
    resource: b.resource as string,
    state: b.state as string | null,
  };
}

// ---------- Clients ----------

export interface RegisterClientInput {
  clientName: string | null;
  redirectUris: string[];
  /** The registration request as received (spec §4 `oauth_clients.metadata`). */
  metadata: Record<string, unknown>;
  requestId?: string | undefined;
}

/** Insert the client and log `oauth_client_register` together. */
export async function registerClient(
  sql: Sql,
  input: RegisterClientInput,
): Promise<{ clientId: string; issuedAt: Date }> {
  const clientId = newId('cli');
  return sql.begin(async (tx) => {
    const [row] = await tx<{ created_at: Date }[]>`
      INSERT INTO oauth_clients (client_id, client_name, redirect_uris, metadata)
      VALUES (${clientId}, ${input.clientName}, ${input.redirectUris},
              ${tx.json(input.metadata as Parameters<typeof tx.json>[0])})
      RETURNING created_at`;
    // Never the client name: it is untrusted text, kept in oauth_clients.
    await logActivity(tx, {
      kind: 'oauth_client_register',
      actor: 'system',
      requestId: input.requestId ?? null,
      targetKind: 'oauth_client',
      targetId: clientId,
      details: { redirect_hosts: [...new Set(input.redirectUris.map((u) => new URL(u).host))] },
    });
    return { clientId, issuedAt: row?.created_at ?? new Date() };
  });
}

export interface ClientRow {
  client_id: string;
  client_name: string | null;
  redirect_uris: string[];
}

/**
 * A client that may take part in a flow: not disabled, and approved once or registered in the
 * last 24 hours (unapproved clients expire, spec §9.3; nothing is deleted, nacre_app can't).
 */
export async function findUsableClient(sql: Sql, clientId: string): Promise<ClientRow | null> {
  const [row] = await sql<ClientRow[]>`
    SELECT client_id, client_name, redirect_uris FROM oauth_clients
    WHERE client_id = ${clientId} AND disabled_at IS NULL
      AND (approved_at IS NOT NULL OR created_at > now() - interval '24 hours')`;
  return row ?? null;
}

export interface ConsentAgent {
  agent_id: string;
  display_name: string;
  enabled: boolean;
}

/** Every agent, for the consent page's select (enabled ones) and the suggestion (all of them). */
export const listAgents = (sql: Sql): Promise<ConsentAgent[]> =>
  sql<ConsentAgent[]>`
    SELECT agent_id, display_name, disabled_at IS NULL AS enabled FROM agents ORDER BY agent_id`;

/**
 * The enabled agent this client was last approved for (task 3c), so a reconnect lands on it even
 * when the owner named it something other than the slug. First this `client_id`'s consents, then
 * those of an approved client with the same name and the same redirect URIs (one that registered
 * again). Codes are written only on approval, so each row is one approved consent.
 */
export async function lastApprovedAgent(sql: Sql, client: ClientRow): Promise<string | null> {
  const [row] = await sql<{ agent_id: string }[]>`
    SELECT c.agent_id
    FROM oauth_auth_codes c
    JOIN oauth_clients k USING (client_id)
    JOIN agents a ON a.agent_id = c.agent_id AND a.disabled_at IS NULL
    WHERE c.client_id = ${client.client_id}
       OR (k.approved_at IS NOT NULL AND k.disabled_at IS NULL
           AND k.client_name IS NOT DISTINCT FROM ${client.client_name}
           AND k.redirect_uris @> ${client.redirect_uris}::text[]
           AND k.redirect_uris <@ ${client.redirect_uris}::text[])
    ORDER BY c.client_id = ${client.client_id} DESC, c.created_at DESC
    LIMIT 1`;
  return row?.agent_id ?? null;
}

// ---------- Consent ----------

export type AgentChoice =
  | { kind: 'existing'; agentId: string }
  | { kind: 'new'; agentId: string; displayName: string };

export type ApproveResult =
  | { ok: true; code: string; grantId: string; agentId: string; agentCreated: boolean }
  /** `agent_exists`: create-new with a taken id. `agent_unavailable`: not an enabled agent. */
  | { ok: false; reason: 'agent_exists' | 'agent_unavailable' };

/** The display name for an agent created on consent: the client name, cut, or the id. */
export function agentDisplayName(clientName: string | null, agentId: string): string {
  const name = (clientName ?? '').trim().slice(0, DISPLAY_NAME_MAX_LENGTH).trim();
  return name || agentId;
}

const host = (uri: string): string => new URL(uri).host;

/**
 * Approve (spec §9.3): create the chosen new agent, mark the client approved, insert a 5-minute
 * single-use code bound to the request and agent, and log `oauth_consent`, in one transaction, so
 * a failed approval creates nothing. The code is returned once; only its HMAC is stored.
 */
export async function approveConsent(
  sql: Sql,
  pepper: string,
  input: { request: ConsentRequest; agent: AgentChoice; requestId?: string | undefined },
): Promise<ApproveResult> {
  const { request, agent } = input;
  const code = randomBytes(32).toString('base64url');
  const grantId = newId('grt');
  return sql.begin(async (tx): Promise<ApproveResult> => {
    if (agent.kind === 'new') {
      const created = await tx`
        INSERT INTO agents (agent_id, display_name, client_kind)
        VALUES (${agent.agentId}, ${agent.displayName}, 'mcp-oauth')
        ON CONFLICT (agent_id) DO NOTHING RETURNING agent_id`;
      if (created.length === 0) return { ok: false, reason: 'agent_exists' };
    } else {
      const [found] = await tx`
        SELECT 1 FROM agents WHERE agent_id = ${agent.agentId} AND disabled_at IS NULL`;
      if (!found) return { ok: false, reason: 'agent_unavailable' };
    }
    await tx`
      UPDATE oauth_clients SET approved_at = now()
      WHERE client_id = ${request.clientId} AND approved_at IS NULL`;
    await tx`
      INSERT INTO oauth_auth_codes (code_hash, client_id, agent_id, grant_id, redirect_uri,
                                    code_challenge, resource, expires_at)
      VALUES (${hashSecret(pepper, code)}, ${request.clientId}, ${agent.agentId}, ${grantId},
              ${request.redirectUri}, ${request.codeChallenge}, ${request.resource},
              now() + interval '5 minutes')`;
    await logActivity(tx, {
      kind: 'oauth_consent',
      actor: 'owner',
      requestId: input.requestId ?? null,
      targetKind: 'oauth_client',
      targetId: request.clientId,
      details: {
        decision: 'approve',
        client_id: request.clientId,
        agent_id: agent.agentId,
        grant_id: grantId,
        redirect_host: host(request.redirectUri),
        ...(agent.kind === 'new' ? { agent_created: true } : {}),
      },
    });
    return {
      ok: true,
      code,
      grantId,
      agentId: agent.agentId,
      agentCreated: agent.kind === 'new',
    };
  });
}

export async function recordDenial(
  sql: Sql,
  input: { request: ConsentRequest; requestId?: string | undefined },
): Promise<void> {
  await logActivity(sql, {
    kind: 'oauth_consent',
    actor: 'owner',
    requestId: input.requestId ?? null,
    targetKind: 'oauth_client',
    targetId: input.request.clientId,
    details: {
      decision: 'deny',
      client_id: input.request.clientId,
      redirect_host: host(input.request.redirectUri),
    },
  });
}

// ---------- Tokens (spec §9.3 token endpoint) ----------

export interface IssuedTokens {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
}

/**
 * `invalid_grant` / `invalid_target` are the RFC 6749 / 8707 errors; `outcome` is the request
 * log's detail (e.g. `code_reuse`), never sent to the client.
 */
export type TokenResult =
  | { ok: true; tokens: IssuedTokens; agentId: string; grantId: string }
  | { ok: false; error: 'invalid_grant' | 'invalid_target'; outcome: string };

const fail = (error: 'invalid_grant' | 'invalid_target', outcome: string): TokenResult => ({
  ok: false,
  error,
  outcome,
});

interface PairInput {
  agentId: string;
  clientId: string;
  grantId: string;
  resource: string;
  /** Null: a new grant, 30 days from now. Else the rotated token's expiry (the grant's). */
  refreshExpiresAt: Date | null;
  via: 'authorization_code' | 'refresh_token';
  rotatedFrom?: string;
  requestId?: string | undefined;
}

/** Insert an access and a refresh token in one grant and log one `token_create`. */
async function issuePair(tx: TransactionSql, pepper: string, p: PairInput): Promise<IssuedTokens> {
  const access = mintToken(pepper);
  const refresh = mintToken(pepper);
  const [r] = await tx<{ expires_at: Date }[]>`
    INSERT INTO agent_tokens (token_id, agent_id, secret_hash, kind, oauth_client_id, grant_id,
                              resource, expires_at)
    VALUES (${refresh.tokenId}, ${p.agentId}, ${refresh.secretHash}, 'oauth_refresh', ${p.clientId},
            ${p.grantId}, ${p.resource},
            COALESCE(${p.refreshExpiresAt}::timestamptz, now() + interval '30 days'))
    RETURNING expires_at`;
  // An access token never outlives its grant's refresh token.
  const [a] = await tx<{ expires_in: number }[]>`
    INSERT INTO agent_tokens (token_id, agent_id, secret_hash, kind, oauth_client_id, grant_id,
                              resource, expires_at)
    VALUES (${access.tokenId}, ${p.agentId}, ${access.secretHash}, 'oauth_access', ${p.clientId},
            ${p.grantId}, ${p.resource},
            LEAST(now() + make_interval(secs => ${ACCESS_TOKEN_SECONDS}), ${r?.expires_at ?? null}::timestamptz))
    RETURNING ceil(extract(epoch FROM expires_at - now()))::int AS expires_in`;
  await logActivity(tx, {
    kind: 'token_create',
    actor: p.agentId,
    tokenId: access.tokenId,
    requestId: p.requestId ?? null,
    targetKind: 'agent_token',
    targetId: access.tokenId,
    details: {
      agent_id: p.agentId,
      kind: 'oauth_access',
      client_id: p.clientId,
      grant_id: p.grantId,
      refresh_token_id: refresh.tokenId,
      via: p.via,
      ...(p.rotatedFrom ? { rotated_from: p.rotatedFrom } : {}),
    },
  });
  return {
    access_token: access.token,
    token_type: 'Bearer',
    expires_in: a?.expires_in ?? ACCESS_TOKEN_SECONDS,
    refresh_token: refresh.token,
  };
}

/** A used code or a rotated refresh token came back: revoke the grant and say so (spec §9.3). */
async function revokeForReuse(
  tx: TransactionSql,
  what: 'code' | 'refresh',
  r: {
    grantId: string;
    agentId: string;
    clientId: string;
    tokenId?: string;
    requestId?: string | undefined;
  },
): Promise<void> {
  const revoked = await revokeGrantTokens(tx, r.grantId);
  await logActivity(tx, {
    kind: 'oauth_refresh_reuse',
    actor: r.agentId,
    tokenId: r.tokenId ?? null,
    requestId: r.requestId ?? null,
    targetKind: 'oauth_grant',
    targetId: r.grantId,
    details: {
      what,
      grant_id: r.grantId,
      client_id: r.clientId,
      revoked_count: revoked,
      ...(r.tokenId ? { token_id: r.tokenId } : {}),
    },
  });
}

export interface CodeExchangeInput {
  clientId: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
  /** Optional on the request; must equal the code's when sent. */
  resource: string | undefined;
  requestId?: string | undefined;
}

interface CodeRow {
  client_id: string;
  agent_id: string;
  grant_id: string;
  redirect_uri: string;
  code_challenge: string;
  resource: string;
  agent_enabled: boolean;
}

/**
 * The `authorization_code` grant. The code is consumed atomically first; a mismatch afterwards
 * still burns it (the transaction commits the consumption and returns the error). A used code
 * coming back revokes the grant.
 */
export async function exchangeCode(
  sql: Sql,
  pepper: string,
  input: CodeExchangeInput,
): Promise<TokenResult> {
  const codeHash = hashSecret(pepper, input.code);
  return sql.begin(async (tx): Promise<TokenResult> => {
    const [row] = await tx<CodeRow[]>`
      UPDATE oauth_auth_codes c SET used_at = now()
      FROM agents a
      WHERE c.code_hash = ${codeHash} AND c.used_at IS NULL AND c.expires_at > now()
        AND a.agent_id = c.agent_id
      RETURNING c.client_id, c.agent_id, c.grant_id, c.redirect_uri, c.code_challenge, c.resource,
                a.disabled_at IS NULL AS agent_enabled`;
    if (!row) {
      const [seen] = await tx<
        { used: boolean; grant_id: string; agent_id: string; client_id: string }[]
      >`
        SELECT used_at IS NOT NULL AS used, grant_id, agent_id, client_id
        FROM oauth_auth_codes WHERE code_hash = ${codeHash}`;
      if (!seen?.used) return fail('invalid_grant', seen ? 'code_expired' : 'code_unknown');
      await lockGrant(tx, seen.grant_id);
      await revokeForReuse(tx, 'code', {
        grantId: seen.grant_id,
        agentId: seen.agent_id,
        clientId: seen.client_id,
        requestId: input.requestId,
      });
      return fail('invalid_grant', 'code_reuse');
    }
    if (row.client_id !== input.clientId) return fail('invalid_grant', 'code_wrong_client');
    if (row.redirect_uri !== input.redirectUri)
      return fail('invalid_grant', 'code_wrong_redirect_uri');
    if (!pkceMatches(input.codeVerifier, row.code_challenge))
      return fail('invalid_grant', 'pkce_mismatch');
    if (input.resource !== undefined && input.resource !== row.resource) {
      return fail('invalid_target', 'code_wrong_resource');
    }
    if (!row.agent_enabled) return fail('invalid_grant', 'agent_disabled');
    await lockGrant(tx, row.grant_id);
    const tokens = await issuePair(tx, pepper, {
      agentId: row.agent_id,
      clientId: row.client_id,
      grantId: row.grant_id,
      resource: row.resource,
      refreshExpiresAt: null,
      via: 'authorization_code',
      requestId: input.requestId,
    });
    return { ok: true, tokens, agentId: row.agent_id, grantId: row.grant_id };
  });
}

export interface RefreshInput {
  clientId: string;
  refreshToken: string;
  resource: string | undefined;
  requestId?: string | undefined;
}

interface RefreshRow {
  agent_id: string;
  secret_hash: Buffer;
  kind: string;
  oauth_client_id: string | null;
  grant_id: string | null;
  resource: string | null;
  expires_at: Date | null;
  revoked: boolean;
  rotated: boolean;
  /** Rotated within `REUSE_GRACE_SECONDS`. */
  rotated_recently: boolean;
  expired: boolean;
  agent_enabled: boolean;
}

// Compared against when no row exists, so a miss costs the same HMAC and compare as a hit.
const NO_HASH = Buffer.alloc(32);

/**
 * The `refresh_token` grant: rotate under the grant lock, so of two concurrent refreshes one
 * wins. A rotated token coming back within `REUSE_GRACE_SECONDS` is refused; later, it revokes
 * every token in the grant.
 */
export async function refreshTokens(
  sql: Sql,
  pepper: string,
  input: RefreshInput,
): Promise<TokenResult> {
  const parsed = parseToken(input.refreshToken);
  if (!parsed) return fail('invalid_grant', 'refresh_malformed');
  const lookup = (q: Sql | TransactionSql) => q<RefreshRow[]>`
    SELECT t.agent_id, t.secret_hash, t.kind, t.oauth_client_id, t.grant_id, t.resource,
           t.expires_at, t.revoked_at IS NOT NULL AS revoked, t.rotated_at IS NOT NULL AS rotated,
           t.rotated_at > now() - make_interval(secs => ${REUSE_GRACE_SECONDS}) AS rotated_recently,
           t.expires_at IS NOT NULL AND t.expires_at <= now() AS expired,
           a.disabled_at IS NULL AS agent_enabled
    FROM agent_tokens t JOIN agents a USING (agent_id)
    WHERE t.token_id = ${parsed.tokenId}`;
  const [first] = await lookup(sql);
  const matches = timingSafeEqual(hashSecret(pepper, parsed.secret), first?.secret_hash ?? NO_HASH);
  if (!first || !matches)
    return fail('invalid_grant', first ? 'refresh_bad_secret' : 'refresh_unknown');
  if (first.kind !== 'oauth_refresh' || !first.grant_id)
    return fail('invalid_grant', 'refresh_wrong_kind');
  if (first.oauth_client_id !== input.clientId)
    return fail('invalid_grant', 'refresh_wrong_client');
  const grantId = first.grant_id;

  return sql.begin(async (tx): Promise<TokenResult> => {
    await lockGrant(tx, grantId);
    // Read again under the lock: a concurrent refresh or revoke has committed by now.
    const [row] = await lookup(tx);
    if (!row) return fail('invalid_grant', 'refresh_unknown');
    // Revoked first: a revoke also leaves rotated rows behind, and that must not read as a replay.
    if (row.revoked) return fail('invalid_grant', 'refresh_revoked');
    // A parallel refresh that lost the lock: refuse it, but leave the winner's pair working.
    if (row.rotated && row.rotated_recently) return fail('invalid_grant', 'refresh_reuse_grace');
    if (row.rotated) {
      await revokeForReuse(tx, 'refresh', {
        grantId,
        agentId: row.agent_id,
        clientId: input.clientId,
        tokenId: parsed.tokenId,
        requestId: input.requestId,
      });
      return fail('invalid_grant', 'refresh_reuse');
    }
    if (row.expired) return fail('invalid_grant', 'refresh_expired');
    if (!row.agent_enabled) return fail('invalid_grant', 'agent_disabled');
    if (input.resource !== undefined && input.resource !== row.resource) {
      return fail('invalid_target', 'refresh_wrong_resource');
    }
    await tx`UPDATE agent_tokens SET rotated_at = now() WHERE token_id = ${parsed.tokenId}`;
    const tokens = await issuePair(tx, pepper, {
      agentId: row.agent_id,
      clientId: input.clientId,
      grantId,
      resource: row.resource ?? '',
      refreshExpiresAt: row.expires_at,
      via: 'refresh_token',
      rotatedFrom: parsed.tokenId,
      requestId: input.requestId,
    });
    return { ok: true, tokens, agentId: row.agent_id, grantId };
  });
}
