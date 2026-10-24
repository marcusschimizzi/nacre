import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { authShape } from '../src/api/auth.js';
import { checkOrigin } from '../src/api/origin.js';
import { formatToken, hashSecret, mintToken, parseToken } from '../src/shared/tokens.js';

describe('authShape', () => {
  it.each([
    [undefined, 'none'],
    ['', 'none'],
    ['Bearer abc123', 'bearer'],
    ['bearer abc123', 'bearer'],
    ['Bearer ', 'bearer-malformed'],
    ['Bearer Bearer abc123', 'bearer-malformed'],
    ['Basic dXNlcjpwYXNz', 'other'],
    ['abc123', 'other'],
  ] as const)('%j is %s', (header, shape) => {
    expect(authShape(header)).toBe(shape);
  });
});

const TOKEN_FORMAT = /^nacre_tok_[0-9A-HJKMNP-TV-Z]{26}_[A-Za-z0-9_-]{43}$/;
const ULID = '01JAXK5W3J8N4Q2R7T9V0Y1Z2A';

describe('token format', () => {
  it('mints nacre_tok_<ulid>_<43-char base64url secret>', () => {
    const { token, tokenId } = mintToken('p'.repeat(32));
    expect(token).toMatch(TOKEN_FORMAT);
    expect(token.startsWith(`nacre_${tokenId}_`)).toBe(true);
  });

  it('parses by fixed positions, so a secret containing _ survives', () => {
    const secret = `__${'a_b-'.repeat(10)}x`; // 43 chars, underscores included
    expect(secret).toHaveLength(43);
    expect(parseToken(formatToken(`tok_${ULID}`, secret))).toEqual({
      tokenId: `tok_${ULID}`,
      secret,
    });
  });

  it.each([
    ['empty', ''],
    ['no prefix', `tok_${ULID}_${'a'.repeat(43)}`],
    ['lowercase ULID', `nacre_tok_${ULID.toLowerCase()}_${'a'.repeat(43)}`],
    ['ULID with I/L/O/U', `nacre_tok_${'I'.repeat(26)}_${'a'.repeat(43)}`],
    ['short secret', `nacre_tok_${ULID}_${'a'.repeat(42)}`],
    ['long secret', `nacre_tok_${ULID}_${'a'.repeat(44)}`],
    ['padding', `nacre_tok_${ULID}_${'a'.repeat(42)}=`],
    ['trailing text', `nacre_tok_${ULID}_${'a'.repeat(43)} x`],
  ])('rejects %s', (_case, value) => {
    expect(parseToken(value)).toBeNull();
  });

  it('stores HMAC-SHA256(pepper, secret): 32 bytes, keyed, not a plain sha256', () => {
    const secret = 'a'.repeat(43);
    const hash = hashSecret('pepper-'.repeat(6), secret);
    expect(hash).toHaveLength(32);
    expect(hash.equals(createHash('sha256').update(secret).digest())).toBe(false);
    expect(hash.equals(hashSecret('another-pepper-'.repeat(3), secret))).toBe(false);
  });
});

describe('checkOrigin (exact scheme, host and port)', () => {
  const allowed = new Set(['https://api.nacre.so', 'https://app.nacre.so']);

  it.each([
    [undefined, 'absent'],
    ['https://api.nacre.so', 'allowed'],
    ['https://app.nacre.so', 'allowed'],
    ['https://evil.example', 'forbidden'],
    ['http://api.nacre.so', 'forbidden'], // scheme
    ['https://api.nacre.so:8443', 'forbidden'], // port
    ['https://api.nacre.so.evil.example', 'forbidden'], // suffix trick
    ['https://API.nacre.so', 'forbidden'], // not the canonical form a browser sends
    ['https://api.nacre.so/', 'forbidden'], // not a bare origin
    ['null', 'forbidden'], // opaque origin (sandboxed iframe, file://)
    ['', 'forbidden'],
  ] as const)('%j → %s', (header, verdict) => {
    expect(checkOrigin(header, allowed)).toBe(verdict);
  });
});
