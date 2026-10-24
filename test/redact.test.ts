import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isHighEntropy, REDACTION_KINDS, redactJson, redactSecrets } from '../src/shared/redact.js';
import { mintToken } from '../src/shared/tokens.js';
import { fakeSecrets, randomToken } from './helpers/events.js';

const DASHES = '-'.repeat(5);
const pem = (label: string, end = true) =>
  `${DASHES}BEGIN ${label}${DASHES}\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nBKcwggSjAgEAAoIBAQC7\n` +
  (end ? `${DASHES}END ${label}${DASHES}` : '');

/** Every must-redact fixture: the input, its expected output, and the kind it counts. */
function mustRedact(): { name: string; input: string; output: string; kind: string }[] {
  const s = fakeSecrets();
  const whole = (name: string, secret: string, kind = 'api_key') => ({
    name,
    input: `before ${secret} after`,
    output: `before [REDACTED:${kind}] after`,
    kind,
  });
  return [
    whole('OpenAI-style sk- key', s.skKey),
    whole('Anthropic sk-ant- key', s.anthropicKey),
    whole('GitHub ghp_ token', s.githubToken),
    whole('GitHub fine-grained PAT', s.githubPat),
    whole('AWS access key id', s.awsKeyId),
    whole('Slack xoxb- token', s.slackToken),
    whole('Google AIza key', s.googleKey),
    whole('Stripe sk_live_ key', s.stripeKey),
    whole('Stripe rk_test_ key', s.stripeRestrictedKey),
    whole('a Nacre token', mintToken('pepper').token),
    whole('a JWT', s.jwt, 'jwt'),
    whole('a PEM private key', pem('PRIVATE KEY'), 'private_key'),
    whole('an RSA PEM private key', pem('RSA PRIVATE KEY'), 'private_key'),
    whole('a PGP private key block', pem('PGP PRIVATE KEY BLOCK'), 'private_key'),
    {
      name: 'a PEM with no END line, to the end of the text',
      input: `my key:\n${pem('PRIVATE KEY', false)}more lines`,
      output: 'my key:\n[REDACTED:private_key]',
      kind: 'private_key',
    },
    {
      name: 'URL credentials, keeping scheme, host and path',
      input: `postgres://app:${'hunter2'.repeat(2)}@db.internal:5432/app`,
      output: 'postgres://[REDACTED:url_credentials]@db.internal:5432/app',
      kind: 'url_credentials',
    },
    {
      name: 'a bearer header, keeping the word',
      input: `Authorization: Bearer ${'abcDEF123456ghiJKL78'}`,
      output: 'Authorization: Bearer [REDACTED:bearer_token]',
      kind: 'bearer_token',
    },
    {
      name: 'password=…',
      input: `password=${'hunter2'.repeat(2)}`,
      output: 'password=[REDACTED:password]',
      kind: 'password',
    },
    {
      name: 'a quoted DB_PASSWORD',
      input: 'DB_PASSWORD="correct horse battery"',
      output: 'DB_PASSWORD=[REDACTED:password]',
      kind: 'password',
    },
    {
      name: 'a JSON client_secret',
      input: `{"client_secret": "abcd1234efgh"}`,
      output: '{"client_secret": [REDACTED:password]}',
      kind: 'password',
    },
    {
      name: 'token: …',
      input: 'token: 9f8e7d6c5b4a',
      output: 'token: [REDACTED:password]',
      kind: 'password',
    },
    whole('a 43-character random base64url string', randomToken('b64', 43), 'high_entropy'),
    {
      name: 'a 50-character random alphanumeric string in a sentence',
      input: `The value is ${randomToken('alnum', 50)} and that is all.`,
      output: 'The value is [REDACTED:high_entropy] and that is all.',
      kind: 'high_entropy',
    },
  ];
}

function mustNotRedact(): { name: string; input: string }[] {
  return [
    { name: 'a UUID', input: `id ${randomUUID()}` },
    { name: 'a git SHA', input: createHash('sha1').update('commit').digest('hex') },
    { name: 'a sha256 digest', input: createHash('sha256').update('x').digest('hex') },
    { name: 'a camel-case identifier', input: 'handleIncomingWebhookPayloadForCustomers' },
    { name: 'a long lowercase path', input: '/home/marcus/dev/nacre/src/shared/redact.test.ts' },
    { name: 'password in prose', input: 'I changed my password yesterday' },
    { name: 'a too-short password', input: 'password=abc' },
    { name: 'task-force', input: 'a task-force on risk-assessment' },
    { name: 'sk-learn', input: 'pip install sk-learn' },
    { name: 'an already redacted value', input: 'token=[REDACTED:api_key]' },
    { name: 'mypassword', input: 'mypassword=hunter2hunter2' },
  ];
}

describe('redactSecrets: must redact', () => {
  for (const f of mustRedact()) {
    it(f.name, () => {
      const result = redactSecrets(f.input);
      expect(result.text).toBe(f.output);
      expect(result.redactions).toEqual([{ kind: f.kind, count: 1 }]);
    });
  }
});

describe('redactSecrets: must not redact', () => {
  for (const f of mustNotRedact()) {
    it(f.name, () => {
      expect(redactSecrets(f.input)).toEqual({ text: f.input, redactions: [] });
    });
  }
});

describe('redactSecrets: properties', () => {
  const all = [...mustRedact().map((f) => f.input), ...mustNotRedact().map((f) => f.input)];

  it('is idempotent: a second pass changes nothing and finds nothing', () => {
    for (const input of [...all, all.join('\n')]) {
      const once = redactSecrets(input).text;
      expect(redactSecrets(once)).toEqual({ text: once, redactions: [] });
    }
  });

  it('returns text with no secrets unchanged', () => {
    const text = 'My preferred package manager is pnpm.\n\tTabs, "quotes", émoji 🎉 and a nbsp.';
    expect(redactSecrets(text)).toEqual({ text, redactions: [] });
  });

  it('counts several secrets of one kind, and lists kinds sorted', () => {
    const s = fakeSecrets();
    const text = `${s.skKey} ${s.githubToken} ${s.awsKeyId} password=hunter2hunter2 ${s.jwt}`;
    expect(redactSecrets(text).redactions).toEqual([
      { kind: 'api_key', count: 3 },
      { kind: 'jwt', count: 1 },
      { kind: 'password', count: 1 },
    ]);
  });

  it('counts a token=sk-… once, as api_key and not password', () => {
    const result = redactSecrets(`token=${fakeSecrets().skKey}`);
    expect(result.text).toBe('token=[REDACTED:api_key]');
    expect(result.redactions).toEqual([{ kind: 'api_key', count: 1 }]);
  });

  it('keeps the text around a marker byte for byte', () => {
    const before = 'Line one,\r\n  indented «quoted» — ';
    const after = ' …​ tail\n';
    const result = redactSecrets(`${before}${fakeSecrets().skKey}${after}`);
    expect(result.text).toBe(`${before}[REDACTED:api_key]${after}`);
  });

  it('only ever uses the closed set of kinds', () => {
    const kinds = new Set<string>(REDACTION_KINDS);
    for (const f of mustRedact()) {
      for (const r of redactSecrets(f.input).redactions) expect(kinds.has(r.kind)).toBe(true);
    }
  });

  it('finds the same JWTs as the brief regex (random strings)', () => {
    // With no digits in the alphabet, only the JWT rule can fire.
    const BRIEF_JWT = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g;
    const pieces = ['eyJ', 'eyJ', 'eyJ', 'ababababab', 'ababababab', 'ab', '-', '.', '.', '_', ' '];
    let seed = 7;
    const next = () => {
      // The high bits: an LCG's low bits cycle quickly.
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed >>> 16;
    };
    let hits = 0;
    for (let n = 0; n < 20_000; n++) {
      let text = '';
      const length = next() % 16;
      for (let i = 0; i < length; i++) text += pieces[next() % pieces.length];
      const expected = text.replace(BRIEF_JWT, '[REDACTED:jwt]');
      const count = text.match(BRIEF_JWT)?.length ?? 0;
      hits += count;
      const result = redactSecrets(text);
      expect(result.text).toBe(expected);
      expect(result.redactions).toEqual(count > 0 ? [{ kind: 'jwt', count }] : []);
    }
    expect(hits).toBeGreaterThan(100);
  });
});

describe('redactJson (metadata)', () => {
  const secret = `hunter2${'hunter2'}`;

  it('replaces a value under a password-style key, which the text rule cannot see', () => {
    const result = redactJson({
      password: secret,
      DB_PASSWORD: 'correct horse battery',
      nested: { client_secret: 'abcd1234efgh', list: { token: [secret, 'x'] } },
    });
    expect(result.value).toEqual({
      password: '[REDACTED:password]',
      DB_PASSWORD: '[REDACTED:password]',
      nested: {
        client_secret: '[REDACTED:password]',
        list: { token: ['[REDACTED:password]', 'x'] },
      },
    });
    expect(result.redactions).toEqual([{ kind: 'password', count: 4 }]);
  });

  it('runs the text rules on every string value, and keeps the keys', () => {
    const s = fakeSecrets();
    const result = redactJson({
      note: `key ${s.skKey}`,
      [s.awsKeyId]: 1,
      n: 5,
      ok: true,
      nil: null,
    });
    expect(result.value).toEqual({
      note: 'key [REDACTED:api_key]',
      [s.awsKeyId]: 1,
      n: 5,
      ok: true,
      nil: null,
    });
    expect(result.redactions).toEqual([{ kind: 'api_key', count: 1 }]);
  });

  it('counts a key under `token` once, as api_key', () => {
    const result = redactJson({ token: fakeSecrets().skKey });
    expect(result.value).toEqual({ token: '[REDACTED:api_key]' });
    expect(result.redactions).toEqual([{ kind: 'api_key', count: 1 }]);
  });

  it('replaces the whole value when another rule caught only part of it', () => {
    const result = redactJson({ password: `${fakeSecrets().skKey} rest1234`, pwd: ' x ' });
    expect(result.value).toEqual({ password: '[REDACTED:password]', pwd: ' x ' });
    expect(result.redactions).toEqual([
      { kind: 'api_key', count: 1 },
      { kind: 'password', count: 1 },
    ]);
  });

  it('leaves short values and look-alike keys alone', () => {
    const value = { password: 'abc', mypassword: secret, passwordHint: secret, cwd: '/home/u' };
    expect(redactJson(value)).toEqual({ value, redactions: [] });
  });

  it('is idempotent', () => {
    const once = redactJson({ password: secret, note: fakeSecrets().jwt }).value;
    expect(redactJson(once)).toEqual({ value: once, redactions: [] });
  });
});

describe('isHighEntropy', () => {
  it('needs mixed case and a digit, rejects hex, and needs 4.2 bits per character', () => {
    expect(isHighEntropy(randomToken('b64', 43))).toBe(true);
    expect(isHighEntropy('abcdefghijklmnopqrstuvwxyzabcdefgh')).toBe(false);
    expect(isHighEntropy('ABCDEF0123456789abcdef0123456789')).toBe(false);
    expect(isHighEntropy('aA1aA1aA1aA1aA1aA1aA1aA1aA1aA1aA1aA1')).toBe(false);
  });
});

describe('redactSecrets: no catastrophic backtracking (100,000 characters each)', () => {
  const N = 100_000;
  const fill = (s: string) => s.repeat(Math.ceil(N / s.length)).slice(0, N);
  const cases: Record<string, string> = {
    'a=b pairs': fill('a=b '),
    'BEGIN PRIVATE KEY repeated': fill(`${DASHES}BEGIN PRIVATE KEY${DASHES}`),
    'one run of base64 characters': fill('aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0xY+/'),
    'password: repeated': fill('password:'),
    // Not in the brief: each was slow, or could have been, with a naive pattern.
    'eyJ- repeated (quadratic with the plain JWT regex)': fill('eyJ-'),
    'eyJ segments and dots': fill('eyJabcdefghijkl.'),
    'scheme:// and user: repeated': fill('ab://x:'),
    'Bearer repeated': fill('Bearer '),
    'unclosed quoted passwords': fill('password="'),
    'sk- repeated': fill('sk-'),
  };
  for (const [name, text] of Object.entries(cases)) {
    it(name, () => {
      const started = performance.now();
      redactSecrets(text);
      expect(performance.now() - started).toBeLessThan(250);
    });
  }
});
