import { createHash, randomUUID } from 'node:crypto';
import type { TestApp } from './app.js';

/** The spec §8.3 hook's `observed_at` shape, and a hub clock one second later. */
export const OBSERVED_AT = '2026-10-21T14:05:09-05:00';
export const RECEIVED_AT = new Date('2026-10-21T19:05:10.000Z');

export function validEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    client_event_id: `test:${randomUUID()}`,
    kind: 'message',
    role: 'user',
    session_id: 'sess-test',
    observed_at: OBSERVED_AT,
    observed_tz: 'America/Chicago',
    content: 'For the record, my preferred package manager is pnpm.',
    scope_hint: null,
    sensitivity_hint: 'normal',
    metadata: { cwd: '/home/u/repo', hook: 'UserPromptSubmit' },
    ...overrides,
  };
}

export function postEvent(
  app: TestApp,
  token: string | null,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(new URL('/v1/events', app.base), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const ALPHABETS = {
  b64: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_',
  alnum: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
};

/**
 * A random-looking token, the same on every run (derived from a hash, not `Math.random`), with a
 * lowercase letter, an uppercase letter and a digit, so it can never flake.
 */
export function randomToken(alphabet: keyof typeof ALPHABETS, length: number, label = ''): string {
  const chars = ALPHABETS[alphabet];
  for (let seed = 0; ; seed++) {
    let out = '';
    for (let block = 0; out.length < length; block++) {
      const bytes = createHash('sha512').update(`${alphabet}:${label}:${seed}:${block}`).digest();
      for (const byte of bytes) out += chars[byte % chars.length];
    }
    out = out.slice(0, length);
    if (/[a-z]/.test(out) && /[A-Z]/.test(out) && /[0-9]/.test(out)) return out;
  }
}

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

/**
 * Fake secrets, assembled at runtime so no secret-shaped literal sits in the repo (GitHub secret
 * scanning and push protection would flag one).
 */
export function fakeSecrets() {
  return {
    skKey: `sk-${'test-'}${'a1B2c3D4'.repeat(3)}`,
    anthropicKey: `sk-${'ant-api03-'}${'x9Y8z7W6'.repeat(4)}`,
    githubToken: `gh${'p_'}${'A1b2C3d4E5'.repeat(4)}`,
    githubPat: `github${'_pat_'}11AB${'a1B2c3D4e5'.repeat(5)}`,
    awsKeyId: `AK${'IA'}ABCDEFGHIJKLMNOP`,
    slackToken: `xo${'xb-'}1234567890-abcdefghij`,
    googleKey: `AI${'za'}Sy${'D4e5F6g7H8'.repeat(3)}abc`,
    stripeKey: `s${'k_live_'}${'A1b2C3d4'.repeat(3)}`,
    stripeRestrictedKey: `r${'k_test_'}${'A1b2C3d4'.repeat(3)}`,
    jwt: [
      b64url({ alg: 'HS256', typ: 'JWT' }),
      b64url({ sub: '1234567890', name: 'Test User', iat: 1_700_000_000 }),
      randomToken('b64', 43, 'jwt-signature'),
    ].join('.'),
  };
}
