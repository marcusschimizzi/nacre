import { describe, expect, it } from 'vitest';
import { SlidingWindowLimiter } from '../src/api/rate-limit.js';
import { loadApiConfig } from '../src/shared/config.js';
import {
  type ConsentRequest,
  isAllowedRedirectUri,
  isValidAgentId,
  pkceMatches,
  s256,
  signConsentRequest,
  suggestAgentId,
  verifyConsentRequest,
} from '../src/shared/oauth.js';
import { hashOwnerPassword, isArgon2idPhc, verifyOwnerPassword } from '../src/shared/password.js';

const CHEAP = { memory: 8, passes: 1, parallelism: 1 };

describe('suggestAgentId (spec §9.3)', () => {
  const none: { agentId: string; enabled: boolean }[] = [];

  it.each([
    ['Grok Bot', 'grok-bot'],
    ['  Café  Notes! ', 'cafe-notes'],
    ['日本語', 'agent'],
    ['', 'agent'],
    ['123 Tool', 'agent-123-tool'],
    ['X', 'agent-x'],
    ['Claude.ai — Research', 'claude-ai-research'],
  ])('%j → %s', (name, slug) => {
    expect(suggestAgentId(name, none)).toEqual({ slug, matchedAgentId: null, newAgentId: slug });
  });

  it('no name → agent', () => {
    expect(suggestAgentId(null, none).slug).toBe('agent');
  });

  it('a 60-character name is cut to 32 with no trailing dash', () => {
    // The cut falls right after a word, on what would be a dash.
    const name = `${'a'.repeat(31)} ${'b'.repeat(28)}`;
    expect(name).toHaveLength(60);
    expect(suggestAgentId(name, none).slug).toBe('a'.repeat(31));
    const long = suggestAgentId('a'.repeat(60), none);
    expect(long.slug).toBe('a'.repeat(32));
    expect(isValidAgentId(long.slug)).toBe(true);
  });

  it('an enabled agent with the slug is the match; the create-new prefill moves to -2', () => {
    expect(suggestAgentId('Grok Bot', [{ agentId: 'grok-bot', enabled: true }])).toEqual({
      slug: 'grok-bot',
      matchedAgentId: 'grok-bot',
      newAgentId: 'grok-bot-2',
    });
  });

  it('a disabled agent is never matched, and its id counts as taken', () => {
    expect(
      suggestAgentId('Grok Bot', [
        { agentId: 'grok-bot', enabled: false },
        { agentId: 'grok-bot-2', enabled: true },
      ]),
    ).toEqual({ slug: 'grok-bot', matchedAgentId: null, newAgentId: 'grok-bot-3' });
  });

  it('matching is exact', () => {
    expect(
      suggestAgentId('Grok Bot', [{ agentId: 'grok-bot-2', enabled: true }]).matchedAgentId,
    ).toBeNull();
    expect(
      suggestAgentId('Grok', [{ agentId: 'grok-bot', enabled: true }]).matchedAgentId,
    ).toBeNull();
  });

  it('reserved names are never suggested as is', () => {
    expect(suggestAgentId('System', none)).toEqual({
      slug: 'system',
      matchedAgentId: null,
      newAgentId: 'system-2',
    });
  });

  it('a suffix on a 32-character slug still fits', () => {
    const slug = 'a'.repeat(32);
    const { newAgentId } = suggestAgentId(slug, [{ agentId: slug, enabled: false }]);
    expect(newAgentId).toBe(`${'a'.repeat(30)}-2`);
    expect(isValidAgentId(newAgentId)).toBe(true);
  });
});

describe('isValidAgentId (spec §4)', () => {
  it.each(['grok-bot', 'claude-code', 'ab', 'a1', 'test-client-alpha-2', 'a'.repeat(32)])(
    '%s is valid',
    (id) => {
      expect(isValidAgentId(id)).toBe(true);
    },
  );
  it.each([
    'Bad Slug',
    '-x',
    'x-',
    'a',
    'a--b',
    'Ünï',
    '../x',
    'x_y',
    '',
    'a'.repeat(33),
    'owner',
    'worker',
    'system',
    '1abc',
    '__new__',
  ])('%j is invalid', (id) => {
    expect(isValidAgentId(id)).toBe(false);
  });
});

describe('redirect URIs (RFC 7591, RFC 8252)', () => {
  it.each([
    'https://claude.ai/api/mcp/auth_callback',
    'https://client.example/cb?x=1',
    'http://127.0.0.1:33418/callback',
    'http://[::1]:8080/cb',
    'http://localhost/cb',
  ])('%s is allowed', (uri) => {
    expect(isAllowedRedirectUri(uri)).toBe(true);
  });
  it.each([
    'http://evil.example/cb',
    'http://127.0.0.1.evil.example/cb',
    'https://client.example/cb#x',
    'https://client.example/cb#',
    'https://user:pw@client.example/cb',
    'https://@client.example/cb',
    'javascript:alert(1)',
    'cursor://callback',
    'not a url',
    `https://client.example/${'x'.repeat(2000)}`,
  ])('%s is refused', (uri) => {
    expect(isAllowedRedirectUri(uri)).toBe(false);
  });
});

describe('PKCE S256', () => {
  it('matches the RFC 7636 appendix B example', () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(s256(verifier)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    expect(pkceMatches(verifier, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')).toBe(true);
    expect(pkceMatches(verifier, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cN')).toBe(false);
    expect(pkceMatches(verifier, 'short')).toBe(false);
  });
});

describe('the consent form signature', () => {
  const pepper = 'p'.repeat(32);
  const request: ConsentRequest = {
    clientId: 'cli_x',
    redirectUri: 'https://client.example/cb',
    codeChallenge: 'c'.repeat(43),
    resource: 'https://api.nacre.test/mcp',
    state: null,
  };

  it('round-trips, and expires after 10 minutes', () => {
    const now = 1_000_000;
    const signed = signConsentRequest(pepper, request, now);
    expect(verifyConsentRequest(pepper, signed, now + 9 * 60_000)).toEqual(request);
    expect(verifyConsentRequest(pepper, signed, now + 10 * 60_000)).toBeNull();
  });

  it('refuses another pepper, a changed payload or a mangled value', () => {
    const signed = signConsentRequest(pepper, request);
    expect(verifyConsentRequest('q'.repeat(32), signed)).toBeNull();
    const [, sig] = signed.split('.');
    const changed = Buffer.from(
      JSON.stringify({ ...request, v: 1, exp: Date.now() + 60_000, clientId: 'cli_y' }),
    ).toString('base64url');
    expect(verifyConsentRequest(pepper, `${changed}.${sig}`)).toBeNull();
    for (const bad of ['', '.', 'a.b', `${signed}.x`, signed.slice(0, -2)]) {
      expect(verifyConsentRequest(pepper, bad)).toBeNull();
    }
  });
});

describe('the owner password (argon2id)', () => {
  it('hashes to a PHC string that verifies, and refuses a wrong password', async () => {
    const hash = await hashOwnerPassword('correct horse battery', CHEAP);
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=8,t=1,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
    expect(isArgon2idPhc(hash)).toBe(true);
    expect(await verifyOwnerPassword(hash, 'correct horse battery')).toBe(true);
    expect(await verifyOwnerPassword(hash, 'correct horse batterY')).toBe(false);
  });

  it('defaults to RFC 9106 parameters', async () => {
    expect(await hashOwnerPassword('x'.repeat(12))).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=4\$/);
  });

  it.each([
    ['argon2i', '$argon2i$v=19$m=8,t=1,p=1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaA'],
    ['an old version', '$argon2id$v=16$m=8,t=1,p=1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaA'],
    ['huge memory', '$argon2id$v=19$m=99999999,t=1,p=1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaA'],
    ['bcrypt', '$2b$12$abcdefghijklmnopqrstuuabcdefghijklmnopqrstuvwxyz0123'],
    ['plain text', 'hunter2hunter2'],
  ])('rejects %s', async (_case, value) => {
    expect(isArgon2idPhc(value)).toBe(false);
    expect(await verifyOwnerPassword(value, 'hunter2hunter2')).toBe(false);
  });

  it('config: OWNER_PASSWORD_HASH is optional, and checked when set', async () => {
    const base = {
      DATABASE_URL: 'postgres://nacre_app@localhost/nacre',
      TOKEN_PEPPER: 'p'.repeat(32),
      PUBLIC_API_URL: 'http://localhost:3000',
    };
    expect(loadApiConfig(base).OWNER_PASSWORD_HASH).toBeUndefined();
    const hash = await hashOwnerPassword('x'.repeat(12), CHEAP);
    expect(loadApiConfig({ ...base, OWNER_PASSWORD_HASH: hash }).OWNER_PASSWORD_HASH).toBe(hash);
    expect(() => loadApiConfig({ ...base, OWNER_PASSWORD_HASH: 'hunter2' })).toThrow(
      /OWNER_PASSWORD_HASH: must be an argon2id PHC string/,
    );
    // The error names the variable, never its value.
    expect(() => loadApiConfig({ ...base, OWNER_PASSWORD_HASH: 'hunter2' })).not.toThrow(/hunter2/);
  });
});

describe('SlidingWindowLimiter', () => {
  it('claims up to `limit` slots per window, then reports the wait without recording', () => {
    let t = 0;
    const limiter = new SlidingWindowLimiter(2, 1000, () => t);
    expect(limiter.tryHit()).toBe(0);
    t = 100;
    expect(limiter.tryHit()).toBe(0);
    expect(limiter.tryHit()).toBe(900);
    t = 999;
    expect(limiter.tryHit()).toBe(1);
    t = 1000; // the first hit has left the window
    expect(limiter.tryHit()).toBe(0);
    expect(limiter.tryHit()).toBe(100);
  });

  it('refund gives a claimed slot back', () => {
    const limiter = new SlidingWindowLimiter(1, 1000, () => 0);
    expect(limiter.tryHit()).toBe(0);
    limiter.refund();
    expect(limiter.tryHit()).toBe(0);
    expect(limiter.tryHit()).toBe(1000);
  });
});
