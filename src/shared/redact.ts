import type { Json } from './activity.js';

/**
 * Secret redaction at ingest (spec §6.2, §17 Q2): pasted secrets are replaced with
 * `[REDACTED:<kind>]` before the body is hashed or stored, so no secret reaches the database, a
 * model provider or a log. Pure and synchronous; every pattern runs in linear time on the 100,000
 * characters an event may hold.
 */
export const REDACTION_KINDS = [
  'private_key',
  'jwt',
  'url_credentials',
  'bearer_token',
  'api_key',
  'password',
  'high_entropy',
] as const;

export type RedactionKind = (typeof REDACTION_KINDS)[number];

export interface Redaction {
  kind: RedactionKind;
  count: number;
}

export interface RedactResult {
  text: string;
  /** Only kinds with a count above 0, sorted by kind. */
  redactions: Redaction[];
}

const marker = (kind: RedactionKind) => `[REDACTED:${kind}]`;

// A value some earlier rule (or an earlier pass) already replaced.
const ALREADY = '\\[REDACTED:';

interface Rule {
  kind: RedactionKind;
  pattern: RegExp;
  /**
   * The replacement for one match (and its first group, if any). Calls `hit` once per secret it
   * replaces; returning the match unchanged skips it.
   */
  replace: (match: string, group: string, hit: () => void) => string;
}

const whole = (kind: RedactionKind) => (_m: string, _g: string, hit: () => void) => {
  hit();
  return marker(kind);
};

const API_KEY_PREFIXES = [
  '\\bsk-[A-Za-z0-9_-]{20,}', // OpenAI, Anthropic (sk-ant-…), sk-test-…
  '\\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}', // GitHub
  '\\bgithub_pat_[A-Za-z0-9_]{40,}',
  '\\b(?:AKIA|ASIA)[0-9A-Z]{16}\\b', // AWS access key ids
  '\\bxox[abprs]-[A-Za-z0-9-]{10,}', // Slack
  '\\bAIza[0-9A-Za-z_-]{35}', // Google
  '\\b[rs]k_(?:live|test)_[0-9A-Za-z]{16,}', // Stripe
  '\\bnacre_tok_[0-9A-Za-z]{26}_[A-Za-z0-9_-]{16,}', // Nacre's own tokens
];

const PASSWORD_KEYS = [
  'password',
  'passwd',
  'pwd',
  'passphrase',
  'secret',
  'token',
  'api[_-]?key',
  'access_token',
  'auth_token',
  'client_secret',
  'secret_key',
  'private_key',
].join('|');

// In this order, each on the output of the one before, so a span is counted once.
const RULES: Rule[] = [
  {
    // A PEM block, or to the end of the text when the END line was cut off.
    kind: 'private_key',
    pattern:
      /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----|$)/g,
    replace: whole('private_key'),
  },
  {
    // Matches what /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g would, but that
    // regex is quadratic: in `eyJ-eyJ-eyJ-…` every `eyJ` is a start that scans to the end of the run.
    // So take each maximal run of JWT characters once and find the JWTs in it with jwtsInRun.
    kind: 'jwt',
    pattern: /[A-Za-z0-9_.-]+/g,
    replace: (run, _g, hit) => (run.includes('eyJ') ? jwtsInRun(run, hit) : run),
  },
  {
    // Keeps the scheme and host: postgres://[REDACTED:url_credentials]@db.internal:5432/app.
    kind: 'url_credentials',
    pattern: new RegExp(
      `\\b([a-z][a-z0-9+.-]{1,20}:\\/\\/)(?!${ALREADY})[^\\s:@/?#]+:[^\\s@/?#]+@`,
      'gi',
    ),
    replace: (_m, scheme, hit) => {
      hit();
      return `${scheme}${marker('url_credentials')}@`;
    },
  },
  {
    // Keeps the word: Authorization: Bearer [REDACTED:bearer_token].
    kind: 'bearer_token',
    pattern: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi,
    replace: (_m, word, hit) => {
      hit();
      return `${word}${marker('bearer_token')}`;
    },
  },
  {
    kind: 'api_key',
    pattern: new RegExp(API_KEY_PREFIXES.join('|'), 'g'),
    replace: whole('api_key'),
  },
  {
    // Keeps the key and separator: DB_PASSWORD=[REDACTED:password]. A quoted value is replaced
    // with its quotes; an unquoted one needs 6+ characters. Prose like "secret: recipe" is redacted
    // too, which the spec accepts (§6.2).
    kind: 'password',
    pattern: new RegExp(
      `(?<![A-Za-z0-9])((?:${PASSWORD_KEYS})["']?\\s*[:=]\\s*)(?!["']?${ALREADY})(?:"[^"\\n]{4,200}"|'[^'\\n]{4,200}'|[^\\s"',;]{6,})`,
      'gi',
    ),
    replace: (_m, key, hit) => {
      hit();
      return `${key}${marker('password')}`;
    },
  },
  {
    kind: 'high_entropy',
    pattern: /[A-Za-z0-9+/_=-]{32,}/g,
    replace: (m, _g, hit) => {
      if (!isHighEntropy(m)) return m;
      hit();
      return marker('high_entropy');
    },
  },
];

/**
 * The JWTs in one maximal run of `[A-Za-z0-9_.-]`, in one pass over its dot-separated parts. A JWT
 * is three parts: the first starts with `eyJ` at a word boundary (the run's start, a part's start,
 * or after `-`) and has 10+ characters after it, the second has 10+, the third any number.
 */
function jwtsInRun(run: string, hit: () => void): string {
  const parts = run.split('.');
  let out = '';
  let copied = 0;
  let partStart = 0;
  for (let i = 0; i + 2 < parts.length; ) {
    const part = parts[i] ?? '';
    const start = (parts[i + 1] ?? '').length >= 10 ? jwtStart(part) : -1;
    if (start < 0) {
      partStart += part.length + 1;
      i += 1;
      continue;
    }
    const end =
      partStart + part.length + 1 + (parts[i + 1] ?? '').length + 1 + (parts[i + 2] ?? '').length;
    out += run.slice(copied, partStart + start) + marker('jwt');
    hit();
    copied = end;
    partStart = end + 1;
    i += 3;
  }
  return out + run.slice(copied);
}

/** The leftmost `eyJ` in a part that can start a JWT's first segment, or -1. */
function jwtStart(part: string): number {
  for (let j = part.indexOf('eyJ'); j >= 0; j = part.indexOf('eyJ', j + 1)) {
    if (part.length - j < 13) return -1;
    if (j === 0 || part[j - 1] === '-') return j;
  }
  return -1;
}

/** Entropy needed for a long token to count as a secret, in bits per character. */
export const HIGH_ENTROPY_BITS = 4.2;

/**
 * A long run that looks random: mixed case and a digit (so lowercase paths and camel-case words
 * without digits stay), not hex once `-` is removed (so UUIDs, git SHAs and digests stay), and at
 * least `HIGH_ENTROPY_BITS` of Shannon entropy per character.
 */
export function isHighEntropy(candidate: string): boolean {
  if (!/[a-z]/.test(candidate) || !/[A-Z]/.test(candidate) || !/[0-9]/.test(candidate)) {
    return false;
  }
  if (/^[0-9a-f]+$/i.test(candidate.replaceAll('-', ''))) return false;
  return shannonEntropy(candidate) >= HIGH_ENTROPY_BITS;
}

export function shannonEntropy(text: string): number {
  const counts = new Map<string, number>();
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  const length = [...text].length;
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

export function redactSecrets(text: string): RedactResult {
  const counts = new Map<RedactionKind, number>();
  let out = text;
  for (const rule of RULES) {
    // With no capture group, the callback's second argument is the offset, not a string.
    const hit = () => counts.set(rule.kind, (counts.get(rule.kind) ?? 0) + 1);
    out = out.replace(rule.pattern, (match: string, group: unknown) =>
      rule.replace(match, typeof group === 'string' ? group : '', hit),
    );
  }
  return { text: out, redactions: toRedactions(counts) };
}

// The password rule's keys as a whole JSON key (`password`, `DB_PASSWORD`, `client_secret`), matched
// the way the rule matches them in text.
const PASSWORD_KEY = new RegExp(`(?<![A-Za-z0-9])(?:${PASSWORD_KEYS})$`, 'i');

export interface RedactJsonResult {
  value: Json;
  redactions: Redaction[];
}

/**
 * Redact the string values of a JSON value (`metadata`), recursively; keys are kept. A string under a
 * password-style key is the secret itself, so it is replaced whole as `password` (4+ characters, as
 * for a quoted value in text) unless another rule already caught it: the text rule can't see it,
 * because the key and the value are separate strings.
 */
export function redactJson(value: Json): RedactJsonResult {
  const found: Redaction[][] = [];
  const walk = (v: Json, key: string | undefined): Json => {
    if (typeof v === 'string') {
      const result = redactSecrets(v);
      found.push(result.redactions);
      if (
        key !== undefined &&
        PASSWORD_KEY.test(key) &&
        result.text.length >= 4 &&
        !result.text.startsWith('[REDACTED:')
      ) {
        found.push([{ kind: 'password', count: 1 }]);
        return marker('password');
      }
      return result.text;
    }
    // An array's items belong to the key that holds it.
    if (Array.isArray(v)) return v.map((item) => walk(item, key));
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, item]) => [k, walk(item, k)]));
    }
    return v;
  };
  const redacted = walk(value, undefined);
  return { value: redacted, redactions: mergeRedactions(...found) };
}

/** Sums several redaction lists kind by kind (the content's and the metadata's). */
export function mergeRedactions(...lists: Redaction[][]): Redaction[] {
  const counts = new Map<RedactionKind, number>();
  for (const list of lists) {
    for (const { kind, count } of list) counts.set(kind, (counts.get(kind) ?? 0) + count);
  }
  return toRedactions(counts);
}

function toRedactions(counts: Map<RedactionKind, number>): Redaction[] {
  return [...counts]
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
}
