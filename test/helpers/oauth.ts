import { randomBytes } from 'node:crypto';
import { s256 } from '../../src/shared/oauth.js';
import { MCP_RESOURCE, OWNER_PASSWORD, PUBLIC_API_URL, type TestApp } from './app.js';

export const REDIRECT_URI = 'https://client.example/oauth/callback';
export const NEW_AGENT = '__new__';

/** A `fetch` for clients that think the api is at `PUBLIC_API_URL`: sends those requests to the test server. */
export function localFetch(app: TestApp): typeof fetch {
  return (input, init) => {
    const original = new URL(input instanceof Request ? input.url : String(input));
    if (original.origin !== PUBLIC_API_URL) return fetch(input, init);
    const target = new URL(`${original.pathname}${original.search}`, app.base);
    return input instanceof Request ? fetch(new Request(target, input), init) : fetch(target, init);
  };
}

export const at = (app: TestApp, path: string) => new URL(path, app.base);

export async function register(app: TestApp, body: Record<string, unknown>): Promise<Response> {
  return fetch(at(app, '/oauth/register'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Registers a public client with one https redirect URI; returns its id. */
export async function registerClient(
  app: TestApp,
  clientName: string | undefined,
): Promise<string> {
  const res = await register(app, {
    ...(clientName === undefined ? {} : { client_name: clientName }),
    redirect_uris: [REDIRECT_URI],
    token_endpoint_auth_method: 'none',
  });
  if (res.status !== 201) throw new Error(`register: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { client_id: string }).client_id;
}

export function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: s256(verifier) };
}

export function authorizeQuery(
  clientId: string,
  challenge: string,
  overrides: Record<string, string | null> = {},
): string {
  const params: Record<string, string | null> = {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'st-123',
    resource: MCP_RESOURCE,
    ...overrides,
  };
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null) q.set(k, v);
  return q.toString();
}

export const authorize = (app: TestApp, query: string) =>
  fetch(at(app, `/oauth/authorize?${query}`), { redirect: 'manual' });

const decode = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

export interface ConsentForm {
  html: string;
  request: string;
  /** Option values in order, `__new__` last. */
  options: string[];
  selected: string[];
  newAgentId: string;
}

export function parseConsent(html: string): ConsentForm {
  const request = /name="request" value="([^"]*)"/.exec(html)?.[1] ?? '';
  const optionTags = [...html.matchAll(/<option value="([^"]*)"( selected="")?/g)];
  return {
    html,
    request: decode(request),
    options: optionTags.map((m) => decode(m[1] ?? '')),
    selected: optionTags.filter((m) => m[2]).map((m) => decode(m[1] ?? '')),
    newAgentId: decode(/name="new_agent_id" value="([^"]*)"/.exec(html)?.[1] ?? ''),
  };
}

export async function consentForm(app: TestApp, clientId: string, challenge: string) {
  const res = await authorize(app, authorizeQuery(clientId, challenge));
  if (res.status !== 200)
    throw new Error(`authorize: ${res.status} ${res.headers.get('location')}`);
  return parseConsent(await res.text());
}

export function postConsent(
  app: TestApp,
  fields: Record<string, string>,
  origin: string | null = PUBLIC_API_URL,
): Promise<Response> {
  return fetch(at(app, '/oauth/authorize'), {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(origin === null ? {} : { origin }),
    },
    body: new URLSearchParams(fields).toString(),
  });
}

/** Approve with the page's preselection unless told otherwise; returns the code from the redirect. */
export async function approve(
  app: TestApp,
  form: ConsentForm,
  choice: { agent?: string; newAgentId?: string; password?: string } = {},
): Promise<Response> {
  return postConsent(app, {
    request: form.request,
    agent: choice.agent ?? form.selected[0] ?? NEW_AGENT,
    new_agent_id: choice.newAgentId ?? form.newAgentId,
    password: choice.password ?? OWNER_PASSWORD,
    decision: 'approve',
  });
}

export const codeFrom = (res: Response): string =>
  new URL(res.headers.get('location') ?? '').searchParams.get('code') ?? '';

export function token(app: TestApp, form: Record<string, string>): Promise<Response> {
  return fetch(at(app, '/oauth/token'), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
}

/** register → authorize → approve → exchange, for tests about what comes after. */
export async function connect(
  app: TestApp,
  clientName: string,
  choice: { agent?: string; newAgentId?: string } = {},
): Promise<{ clientId: string; tokens: TokenResponse; form: ConsentForm }> {
  const clientId = await registerClient(app, clientName);
  const { verifier, challenge } = pkce();
  const form = await consentForm(app, clientId, challenge);
  const approved = await approve(app, form, choice);
  if (approved.status !== 303)
    throw new Error(`approve: ${approved.status} ${await approved.text()}`);
  const res = await token(app, {
    grant_type: 'authorization_code',
    client_id: clientId,
    code: codeFrom(approved),
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
    resource: MCP_RESOURCE,
  });
  if (res.status !== 200) throw new Error(`token: ${res.status} ${await res.text()}`);
  return { clientId, tokens: (await res.json()) as TokenResponse, form };
}

/** A raw `initialize` to /mcp with a bearer token: the status says whether the token works. */
export function mcpStatus(app: TestApp, accessToken: string): Promise<number> {
  return fetch(app.mcpUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'oauth-test', version: '0' },
      },
    }),
  }).then((r) => r.status);
}
