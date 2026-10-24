import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import type { JSX } from 'hono/jsx/jsx-runtime';
import { type ApiConfig, mcpResource } from '../../shared/config.js';
import type { Sql } from '../../shared/db/sql.js';
import type { Logger } from '../../shared/logger.js';
import {
  type AgentChoice,
  agentDisplayName,
  approveConsent,
  CLIENT_NAME_MAX_LENGTH,
  type ClientRow,
  type ConsentRequest,
  exchangeCode,
  findUsableClient,
  isAllowedRedirectUri,
  isLoopbackRedirect,
  isValidAgentId,
  isValidCodeChallenge,
  isValidCodeVerifier,
  lastApprovedAgent,
  listAgents,
  REDIRECT_URIS_MAX,
  recordDenial,
  refreshTokens,
  registerClient,
  signConsentRequest,
  suggestAgentId,
  verifyConsentRequest,
} from '../../shared/oauth.js';
import { verifyOwnerPassword } from '../../shared/password.js';
import type { AppEnv } from '../env.js';
import { originCheck } from '../origin.js';
import { SlidingWindowLimiter } from '../rate-limit.js';
import { ConsentPage, ErrorPage, NEW_AGENT, type PreselectReason } from './pages.js';

export interface OAuthLimits {
  /** Dynamic registrations per hour, process-wide (spec §9.3: 10). */
  registrationsPerHour: number;
  /** Wrong consent passwords per window before 429 (the web login's limit: 5 in 15 minutes). */
  passwordFailures: number;
  passwordWindowMs: number;
}

export const DEFAULT_OAUTH_LIMITS: OAuthLimits = {
  registrationsPerHour: 10,
  passwordFailures: 5,
  passwordWindowMs: 15 * 60_000,
};

export interface OAuthDeps {
  sql: Sql;
  config: Pick<ApiConfig, 'TOKEN_PEPPER' | 'PUBLIC_API_URL' | 'OWNER_PASSWORD_HASH'>;
  log: Logger;
  limits?: Partial<OAuthLimits> | undefined;
}

type Ctx = Context<AppEnv>;

const REGISTER_BODY_MAX = 8 * 1024;
const FORM_BODY_MAX = 16 * 1024;

/** One value, or `DUPLICATE` when the parameter was sent more than once (RFC 6749 §3.1). */
const DUPLICATE = Symbol('duplicate');
type Param = string | undefined | typeof DUPLICATE;
const single = (values: string[] | undefined): Param =>
  values === undefined || values.length === 0
    ? undefined
    : values.length === 1
      ? values[0]
      : DUPLICATE;

const looksLikeUrl = (clientId: string | undefined): boolean =>
  clientId !== undefined && /^https:\/\//i.test(clientId);

// The consent page's headers (spec §9.3). No `form-action`: Chrome applies it to the redirect after
// the post. `same-origin`, not `no-referrer`: under `no-referrer` browsers send `Origin: null` on the
// form post, which the Origin check rejects.
const PAGE_HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'same-origin',
};

async function page(c: Ctx, element: JSX.Element, status: 200 | 400 | 403 | 422 | 429 | 503) {
  return c.html(`<!doctype html>${await element}`, status, PAGE_HEADERS);
}

/**
 * `/.well-known/*` discovery and `/oauth/*` (spec §9.3). Every refusal is a plain OAuth error: RFC
 * 7591 JSON on register, RFC 6749 §5.2 JSON on token, a redirect with `error` once the redirect URI
 * is trusted, and an HTML page before that. The request log gets the step and outcome as `oauth`.
 */
export function oauthRoutes({ sql, config, log, limits }: OAuthDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const issuer = config.PUBLIC_API_URL;
  const resource = mcpResource(config);
  const pepper = config.TOKEN_PEPPER;
  const l = { ...DEFAULT_OAUTH_LIMITS, ...limits };
  const registrations = new SlidingWindowLimiter(l.registrationsPerHour, 3_600_000);
  const wrongPasswords = new SlidingWindowLimiter(l.passwordFailures, l.passwordWindowMs);

  // ---------- Discovery (RFC 9728, RFC 8414) ----------
  const publicGet = cors({ origin: '*', allowMethods: ['GET'] });
  const protectedResource = {
    resource,
    authorization_servers: [issuer],
    bearer_methods_supported: ['header'],
  };
  for (const path of [
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/mcp',
  ]) {
    app.use(path, publicGet);
    app.get(path, (c) => c.json(protectedResource));
  }
  app.use('/.well-known/oauth-authorization-server', publicGet);
  app.get('/.well-known/oauth-authorization-server', (c) =>
    c.json({
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      authorization_response_iss_parameter_supported: true,
    }),
  );

  // ---------- Dynamic client registration (RFC 7591) ----------
  const registerError = (c: Ctx, error: string, outcome: string, status: 400 | 413 = 400) => {
    c.set('oauth', `register:${outcome}`);
    return c.json({ error }, status);
  };
  app.post(
    '/oauth/register',
    async (c, next) => {
      // Every attempt counts, good or bad: the limit protects a public, append-only log.
      const wait = registrations.tryHit();
      if (wait > 0) {
        c.set('oauth', 'register:rate_limited');
        c.header('Retry-After', String(Math.ceil(wait / 1000)));
        return c.json({ error: 'too_many_requests' }, 429);
      }
      await next();
    },
    bodyLimit({
      maxSize: REGISTER_BODY_MAX,
      onError: (c) => registerError(c, 'invalid_client_metadata', 'too_large', 413),
    }),
    async (c) => {
      if (!/^application\/json\b/i.test(c.req.header('content-type') ?? '')) {
        return registerError(c, 'invalid_client_metadata', 'not_json');
      }
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return registerError(c, 'invalid_client_metadata', 'not_json');
      }
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return registerError(c, 'invalid_client_metadata', 'not_object');
      }
      const meta = body as Record<string, unknown>;
      const authMethod = meta.token_endpoint_auth_method;
      if (authMethod !== undefined && authMethod !== 'none') {
        return registerError(c, 'invalid_client_metadata', 'confidential_client');
      }
      const name = meta.client_name;
      if (
        name !== undefined &&
        (typeof name !== 'string' || name.length > CLIENT_NAME_MAX_LENGTH)
      ) {
        return registerError(c, 'invalid_client_metadata', 'client_name');
      }
      const uris = meta.redirect_uris;
      if (
        !Array.isArray(uris) ||
        uris.length < 1 ||
        uris.length > REDIRECT_URIS_MAX ||
        !uris.every((u): u is string => typeof u === 'string' && isAllowedRedirectUri(u))
      ) {
        return registerError(c, 'invalid_redirect_uri', 'invalid_redirect_uri');
      }
      const clientName = typeof name === 'string' && name.trim() ? name : null;
      const { clientId, issuedAt } = await registerClient(sql, {
        clientName,
        redirectUris: uris,
        metadata: meta,
        requestId: c.get('requestId'),
      });
      c.set('oauth', 'register:ok');
      c.header('Cache-Control', 'no-store');
      return c.json(
        {
          client_id: clientId,
          client_id_issued_at: Math.floor(issuedAt.getTime() / 1000),
          ...(clientName ? { client_name: clientName } : {}),
          redirect_uris: uris,
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
        },
        201,
      );
    },
  );

  // ---------- Authorization (GET: validate and show consent; POST: decide) ----------

  /** Back to the client with `iss` (RFC 9207) and `state`; only once the redirect URI is trusted. */
  const redirectBack = (
    c: Ctx,
    redirectUri: string,
    params: Record<string, string | null>,
    status: 302 | 303,
  ) => {
    const url = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) if (v !== null) url.searchParams.set(k, v);
    url.searchParams.set('iss', issuer);
    return c.redirect(url.href, status);
  };

  const errorPage = (c: Ctx, outcome: string, message: string, status: 400 | 503 = 400) => {
    c.set('oauth', outcome);
    return page(c, <ErrorPage message={message} />, status);
  };

  interface PageState {
    selected?: string | undefined;
    newAgentId?: string | undefined;
    error?: string | undefined;
    fieldError?: string | undefined;
  }

  const consentPage = async (
    c: Ctx,
    client: ClientRow,
    request: ConsentRequest,
    signed: string,
    state: PageState,
    status: 200 | 403 | 422 | 429,
  ) => {
    const agents = await listAgents(sql);
    const enabled = agents.filter((a) => a.enabled);
    const suggestion = suggestAgentId(
      client.client_name,
      agents.map((a) => ({ agentId: a.agent_id, enabled: a.enabled })),
    );
    const selectable = (v: string | undefined) =>
      v === NEW_AGENT || enabled.some((a) => a.agent_id === v);
    // The default: the agent this client was last approved for, else the name's slug match.
    const lastUsed = await lastApprovedAgent(sql, client);
    const preselect: { agentId: string; reason: PreselectReason } | null = lastUsed
      ? { agentId: lastUsed, reason: 'last_used' }
      : suggestion.matchedAgentId
        ? { agentId: suggestion.matchedAgentId, reason: 'name_match' }
        : null;
    const selected = selectable(state.selected)
      ? (state.selected as string)
      : (preselect?.agentId ?? NEW_AGENT);
    return page(
      c,
      <ConsentPage
        clientId={client.client_id}
        clientName={client.client_name}
        redirectHost={new URL(request.redirectUri).host}
        loopback={isLoopbackRedirect(request.redirectUri)}
        agents={enabled.map((a) => ({ agentId: a.agent_id, displayName: a.display_name }))}
        selected={selected}
        preselectReason={selected === preselect?.agentId ? preselect.reason : undefined}
        newAgentId={state.newAgentId ?? suggestion.newAgentId}
        signedRequest={signed}
        error={state.error}
        fieldError={state.fieldError}
      />,
      status,
    );
  };

  app.get('/oauth/authorize', async (c) => {
    const q = (name: string) => single(c.req.queries(name));
    // Until the client and redirect URI check out, never redirect: show a page.
    const clientId = q('client_id');
    const client = typeof clientId === 'string' ? await findUsableClient(sql, clientId) : null;
    if (!client) {
      if (typeof clientId === 'string' && looksLikeUrl(clientId)) c.set('oauthClientIdIsUrl', true);
      return errorPage(
        c,
        'authorize:unknown_client',
        'The app asking to connect is not registered.',
      );
    }
    const redirectUri = q('redirect_uri');
    if (typeof redirectUri !== 'string' || !client.redirect_uris.includes(redirectUri)) {
      return errorPage(
        c,
        'authorize:bad_redirect_uri',
        'The return address does not match what the app registered.',
      );
    }
    // Registered before the allow-list, or since dropped from it: still never redirect there.
    if (!isAllowedRedirectUri(redirectUri)) {
      return errorPage(
        c,
        'authorize:redirect_not_allowed',
        "Nacre doesn't accept this app's return address.",
      );
    }

    const stateParam = q('state');
    const state = typeof stateParam === 'string' ? stateParam : null;
    const refuse = (error: string, outcome: string) => {
      c.set('oauth', `authorize:${outcome}`);
      return redirectBack(c, redirectUri, { error, state }, 302);
    };
    if (stateParam === DUPLICATE) return refuse('invalid_request', 'duplicate_param');
    const responseType = q('response_type');
    const challenge = q('code_challenge');
    const method = q('code_challenge_method');
    const requested = q('resource');
    if ([responseType, challenge, method, requested].includes(DUPLICATE)) {
      return refuse('invalid_request', 'duplicate_param');
    }
    if (responseType !== 'code') return refuse('unsupported_response_type', 'response_type');
    if (method !== 'S256') return refuse('invalid_request', 'pkce_method');
    if (typeof challenge !== 'string' || !isValidCodeChallenge(challenge)) {
      return refuse('invalid_request', 'pkce_challenge');
    }
    if (requested !== undefined && requested !== resource) {
      return refuse('invalid_target', 'resource');
    }

    const request: ConsentRequest = {
      clientId: client.client_id,
      redirectUri,
      codeChallenge: challenge,
      resource,
      state,
    };
    c.set('oauth', 'authorize:consent_shown');
    return consentPage(c, client, request, signConsentRequest(pepper, request), {}, 200);
  });

  app.post(
    '/oauth/authorize',
    // Only the api's own origin, required: this is a browser form (spec §11).
    originCheck([issuer], { required: true }),
    bodyLimit({
      maxSize: FORM_BODY_MAX,
      onError: (c) => errorPage(c, 'consent:too_large', 'The form was too large.'),
    }),
    async (c) => {
      if (!config.OWNER_PASSWORD_HASH) {
        return errorPage(
          c,
          'consent:not_configured',
          'Approving connections is not set up on this server yet.',
          503,
        );
      }
      const body = await c.req.parseBody();
      const field = (name: string) => {
        const v = body[name];
        return typeof v === 'string' ? v : undefined;
      };
      const signed = field('request') ?? '';
      const request = verifyConsentRequest(pepper, signed);
      if (!request) {
        return errorPage(c, 'consent:bad_request', 'This sign-in form expired or was changed.');
      }
      const client = await findUsableClient(sql, request.clientId);
      if (!client?.redirect_uris.includes(request.redirectUri)) {
        return errorPage(
          c,
          'consent:unknown_client',
          'The app asking to connect is not registered.',
        );
      }

      // Only these three fields are read; everything else comes from the signed request.
      const agentField = field('agent');
      const newAgentField = field('new_agent_id');
      const decision = field('decision');
      const kept = { selected: agentField, newAgentId: newAgentField };
      const rerender = (outcome: string, state: PageState, status: 403 | 422 | 429) => {
        c.set('oauth', `consent:${outcome}`);
        return consentPage(c, client, request, signed, { ...kept, ...state }, status);
      };

      // Every attempt claims a slot before the (slow) password check and only a right password gives
      // it back, so parallel guesses can't all pass the limit before any failure is counted.
      const wait = wrongPasswords.tryHit();
      if (wait > 0) {
        c.header('Retry-After', String(Math.ceil(wait / 1000)));
        return rerender(
          'rate_limited',
          { error: 'Too many wrong passwords. Wait a few minutes and try again.' },
          429,
        );
      }
      // Request log only, never the activity log: anyone can post a wrong password (spec §13.1).
      if (!(await verifyOwnerPassword(config.OWNER_PASSWORD_HASH, field('password') ?? ''))) {
        return rerender('bad_password', { error: 'Wrong owner password.' }, 403);
      }
      wrongPasswords.refund();

      const requestId = c.get('requestId');
      if (decision === 'deny') {
        await recordDenial(sql, { request, requestId });
        c.set('oauth', 'consent:deny');
        return redirectBack(
          c,
          request.redirectUri,
          { error: 'access_denied', state: request.state },
          303,
        );
      }
      if (decision !== 'approve') {
        return rerender('bad_decision', { error: 'Choose Approve or Deny.' }, 422);
      }

      let agent: AgentChoice;
      if (agentField === NEW_AGENT) {
        const id = (newAgentField ?? '').trim();
        if (!isValidAgentId(id)) {
          return rerender(
            'invalid_agent_id',
            {
              fieldError:
                'Not a valid agent id: use 2 to 32 lowercase letters, digits and single dashes, ' +
                'starting with a letter (not owner, worker or system).',
            },
            422,
          );
        }
        agent = { kind: 'new', agentId: id, displayName: agentDisplayName(client.client_name, id) };
      } else if (agentField) {
        agent = { kind: 'existing', agentId: agentField };
      } else {
        return rerender('no_agent', { error: 'Choose an agent.' }, 422);
      }

      const result = await approveConsent(sql, pepper, { request, agent, requestId });
      if (!result.ok) {
        return result.reason === 'agent_exists'
          ? rerender(
              'agent_exists',
              {
                fieldError: `An agent with the id ${agent.agentId} already exists. Choose it from the list instead.`,
              },
              422,
            )
          : rerender(
              'agent_unavailable',
              { error: 'That agent is not available. Choose another.' },
              422,
            );
      }
      c.set('oauth', result.agentCreated ? 'consent:approve:agent_created' : 'consent:approve');
      return redirectBack(c, request.redirectUri, { code: result.code, state: request.state }, 303);
    },
  );

  // ---------- Token endpoint (RFC 6749 §3.2, §6; RFC 7636; RFC 8707) ----------
  app.post(
    '/oauth/token',
    async (c, next) => {
      await next();
      // On every answer, refusals included.
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');
    },
    bodyLimit({
      maxSize: FORM_BODY_MAX,
      onError: (c) => {
        c.set('oauth', 'token:too_large');
        return c.json({ error: 'invalid_request' }, 413);
      },
    }),
    async (c) => {
      const tokenError = (error: string, outcome: string, status: 400 | 401 = 400) => {
        c.set('oauth', `token:${outcome}`);
        return c.json({ error }, status);
      };
      if (!/^application\/x-www-form-urlencoded\b/i.test(c.req.header('content-type') ?? '')) {
        return tokenError('invalid_request', 'not_form');
      }
      const form = new URLSearchParams(await c.req.text());
      const p = (name: string) => single(form.getAll(name));
      const params = {
        grantType: p('grant_type'),
        clientId: p('client_id'),
        code: p('code'),
        redirectUri: p('redirect_uri'),
        verifier: p('code_verifier'),
        refreshToken: p('refresh_token'),
        resource: p('resource'),
      };
      if (Object.values(params).includes(DUPLICATE)) {
        return tokenError('invalid_request', 'duplicate_param');
      }
      const v = params as { [K in keyof typeof params]: string | undefined };
      // Public clients only: no secret of any kind is accepted (spec §9.3).
      if (
        c.req.header('authorization') ||
        form.has('client_secret') ||
        form.has('client_assertion')
      ) {
        return tokenError('invalid_client', 'client_secret_sent', 401);
      }
      if (!v.grantType) return tokenError('invalid_request', 'no_grant_type');
      if (v.grantType !== 'authorization_code' && v.grantType !== 'refresh_token') {
        return tokenError('unsupported_grant_type', 'unsupported_grant_type');
      }
      if (!v.clientId) return tokenError('invalid_client', 'no_client_id', 401);
      const client = await findUsableClient(sql, v.clientId);
      if (!client) {
        if (looksLikeUrl(v.clientId)) c.set('oauthClientIdIsUrl', true);
        return tokenError('invalid_client', 'unknown_client', 401);
      }

      const requestId = c.get('requestId');
      let result: Awaited<ReturnType<typeof exchangeCode>>;
      if (v.grantType === 'authorization_code') {
        if (!v.code || !v.redirectUri || !v.verifier)
          return tokenError('invalid_request', 'missing_param');
        if (!isValidCodeVerifier(v.verifier)) return tokenError('invalid_request', 'pkce_verifier');
        result = await exchangeCode(sql, pepper, {
          clientId: client.client_id,
          code: v.code,
          redirectUri: v.redirectUri,
          codeVerifier: v.verifier,
          resource: v.resource,
          requestId,
        });
      } else {
        if (!v.refreshToken) return tokenError('invalid_request', 'missing_param');
        result = await refreshTokens(sql, pepper, {
          clientId: client.client_id,
          refreshToken: v.refreshToken,
          resource: v.resource,
          requestId,
        });
      }
      if (!result.ok) return tokenError(result.error, result.outcome);
      c.set('oauth', `token:${v.grantType === 'authorization_code' ? 'code' : 'refresh'}`);
      log.debug({ grant_id: result.grantId, agent_id: result.agentId }, 'oauth tokens issued');
      return c.json(result.tokens);
    },
  );

  return app;
}
