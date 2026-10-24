import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  clockFlags,
  codePointLength,
  contentHash,
  EVENT_LIMITS,
  parseEvent,
  timeZoneOrNull,
} from '../src/shared/events.js';
import { fakeSecrets, OBSERVED_AT, validEvent } from './helpers/events.js';

describe('clockFlags', () => {
  const received = new Date('2026-10-21T19:05:10Z');
  const at = (ms: number) => new Date(received.getTime() + ms);
  const MIN = 60_000;

  it.each([
    ['6 minutes ago', -6 * MIN, ['drift']],
    ['6 minutes ahead', 6 * MIN, ['drift', 'future']],
    ['2 seconds ahead', 2_000, []],
    ['exactly 60 seconds ahead', 60_000, []],
    ['61 seconds ahead', 61_000, ['future']],
    ['exactly 5:00 ago', -5 * MIN, []],
    ['exactly 5:00 ahead', 5 * MIN, ['future']],
    ['4:59 ago', -(5 * MIN - 1_000), []],
    ['the same instant', 0, []],
  ])('%s', (_name, offset, flags) => {
    expect(clockFlags(at(offset), received)).toEqual(flags);
  });
});

describe('contentHash', () => {
  it('is sha256 over the UTF-8 bytes, 32 bytes long', () => {
    const hash = contentHash('café');
    expect(hash).toHaveLength(32);
    expect(hash.equals(createHash('sha256').update(Buffer.from('café', 'utf8')).digest())).toBe(
      true,
    );
  });

  it('hashes NFC-equivalent inputs the same once normalized, and other text differently', () => {
    const decomposed = 'café';
    const composed = 'café';
    expect(contentHash(decomposed.normalize('NFC')).equals(contentHash(composed))).toBe(true);
    expect(contentHash(decomposed).equals(contentHash(composed))).toBe(false);
    expect(contentHash('a').equals(contentHash('b'))).toBe(false);
  });
});

describe('parseEvent: accepted shapes', () => {
  it('accepts the spec §5.1 example, with the hook’s exact observed_at', () => {
    const parsed = parseEvent(validEvent({ observed_at: OBSERVED_AT }));
    expect(parsed.ok).toBe(true);
  });

  it.each([
    ['Z', '2026-10-21T19:05:09Z'],
    ['fractional seconds', '2026-10-21T19:05:09.123Z'],
    ['a positive offset', '2026-10-22T00:35:09+05:30'],
  ])('accepts observed_at with %s', (_name, observed_at) => {
    expect(parseEvent(validEvent({ observed_at })).ok).toBe(true);
  });

  it('accepts the optional fields as null or missing', () => {
    const minimal = {
      client_event_id: 'k1',
      kind: 'message',
      role: 'assistant',
      observed_at: OBSERVED_AT,
      content: 'x',
    };
    expect(parseEvent(minimal).ok).toBe(true);
    expect(
      parseEvent({
        ...minimal,
        session_id: null,
        observed_tz: null,
        scope_hint: null,
        sensitivity_hint: null,
      }).ok,
    ).toBe(true);
  });

  it('accepts nested metadata of any JSON values', () => {
    const metadata = { a: [1, 'two', null, true, { b: { c: 2.5 } }], prompt_id: null };
    expect(parseEvent(validEvent({ metadata })).ok).toBe(true);
  });
});

describe('timeZoneOrNull: lenient on purpose', () => {
  it.each([
    ['America/Chicago', 'America/Chicago'],
    ['UTC', 'UTC'],
    ['', null],
    ['Not/AZone', null],
    ['/var/db/timezone/zoneinfo/America/Chicago', null],
    ['x'.repeat(65), null],
    [null, null],
    [undefined, null],
  ])('%s → %s', (input, expected) => {
    expect(timeZoneOrNull(input)).toBe(expected);
  });

  it('a junk observed_tz is not a 422', () => {
    expect(parseEvent(validEvent({ observed_tz: 'Not/AZone' })).ok).toBe(true);
    expect(parseEvent(validEvent({ observed_tz: '' })).ok).toBe(true);
  });
});

describe('parseEvent: 422', () => {
  const secret = fakeSecrets().skKey;
  const issuesOf = (body: unknown) => {
    const parsed = parseEvent(body);
    if (parsed.ok || parsed.status !== 422) throw new Error(`expected a 422, got ${parsed.ok}`);
    return parsed.issues;
  };

  it.each([
    ['client_event_id', { client_event_id: undefined }, 'invalid_type'],
    ['client_event_id', { client_event_id: '' }, 'invalid_format'],
    ['client_event_id', { client_event_id: 'has space' }, 'invalid_format'],
    ['client_event_id', { client_event_id: 'é' }, 'invalid_format'],
    ['client_event_id', { client_event_id: 'k'.repeat(201) }, 'invalid_format'],
    ['client_event_id', { client_event_id: 42 }, 'invalid_type'],
    ['kind', { kind: 'remember' }, 'invalid_value'],
    ['kind', { kind: undefined }, 'invalid_value'],
    ['role', { role: 'tool' }, 'invalid_value'],
    ['role', { role: secret }, 'invalid_value'],
    ['session_id', { session_id: 'a b' }, 'invalid_format'],
    ['observed_at', { observed_at: '2026-10-21T14:05:09' }, 'invalid_format'],
    ['observed_at', { observed_at: '2026-02-30T00:00:00Z' }, 'invalid_format'],
    ['observed_at', { observed_at: 'yesterday' }, 'invalid_format'],
    ['observed_at', { observed_at: '0000-01-01T00:00:00Z' }, 'custom'],
    ['observed_at', { observed_at: 1_729_537_509 }, 'invalid_type'],
    ['observed_tz', { observed_tz: 5 }, 'invalid_type'],
    ['content', { content: undefined }, 'invalid_type'],
    ['content', { content: ['a'] }, 'invalid_type'],
    ['scope_hint', { scope_hint: 's'.repeat(101) }, 'too_big'],
    ['sensitivity_hint', { sensitivity_hint: 'secret' }, 'invalid_value'],
    ['metadata', { metadata: ['a'] }, 'invalid_type'],
    ['metadata', { metadata: 'a' }, 'invalid_type'],
    ['metadata', { metadata: null }, 'invalid_type'],
  ])('%s: %j → %s', (path, overrides, code) => {
    expect(issuesOf(validEvent(overrides))).toEqual([{ path, code }]);
  });

  it.each([
    ['empty content', { content: '' }, 'content', 'empty_content'],
    ['whitespace-only content', { content: ' \n\t ' }, 'content', 'empty_content'],
    ['a NUL in content', { content: 'a\u0000b' }, 'content', 'invalid_characters'],
    ['a lone surrogate in content', { content: 'a\ud800b' }, 'content', 'invalid_characters'],
    ['a NUL in a metadata key', { metadata: { 'k\u0000': 'v' } }, 'metadata', 'invalid_characters'],
    [
      'a NUL in a nested metadata value',
      { metadata: { a: [{ b: 'x\u0000' }] } },
      'metadata',
      'invalid_characters',
    ],
    ['a NUL in scope_hint', { scope_hint: 'a\u0000' }, 'scope_hint', 'invalid_characters'],
  ])('%s', (_name, overrides, path, code) => {
    expect(issuesOf(validEvent(overrides))).toEqual([{ path, code }]);
  });

  it.each([
    'agent_id',
    'token_id',
    'source_client',
    'trust_tier',
    'scope_id',
    'tainted',
    'explicit_remember',
  ])('rejects the server-set field %s without naming it', (key) => {
    expect(issuesOf(validEvent({ [key]: 'x' }))).toEqual([{ path: '', code: 'unrecognized_keys' }]);
  });

  it('never echoes a submitted value or an unknown key', () => {
    const issues = issuesOf(
      validEvent({ role: secret, [`key_${secret}`]: secret, client_event_id: `${secret} ` }),
    );
    const text = JSON.stringify(issues);
    expect(text).not.toContain(secret);
    expect(text).not.toContain('key_');
    expect(issues).toEqual(
      expect.arrayContaining([
        { path: 'role', code: 'invalid_value' },
        { path: '', code: 'unrecognized_keys' },
        { path: 'client_event_id', code: 'invalid_format' },
      ]),
    );
  });

  it('a metadata issue names only `metadata`, never the nested path', () => {
    // JSON can't carry a bigint; this reaches zod's nested issue path, which must not leak.
    const issues = issuesOf(validEvent({ metadata: { deep: { [secret]: 1n } } }));
    expect(issues).toEqual([{ path: 'metadata', code: expect.any(String) }]);
    expect(JSON.stringify(issues)).not.toContain(secret);
  });
});

describe('parseEvent: 413, after the shape checks', () => {
  it('content over 100,000 code points; exactly 100,000 passes', () => {
    const max = EVENT_LIMITS.contentChars;
    expect(parseEvent(validEvent({ content: 'a'.repeat(max) })).ok).toBe(true);
    expect(parseEvent(validEvent({ content: 'a'.repeat(max + 1) }))).toEqual({
      ok: false,
      status: 413,
      field: 'content',
    });
  });

  it('counts code points, not UTF-16 units', () => {
    const emoji = '🎉'.repeat(EVENT_LIMITS.contentChars);
    expect(emoji.length).toBe(2 * EVENT_LIMITS.contentChars);
    expect(codePointLength(emoji)).toBe(EVENT_LIMITS.contentChars);
    expect(parseEvent(validEvent({ content: emoji })).ok).toBe(true);
  });

  it('metadata over 8 KiB of JSON', () => {
    expect(parseEvent(validEvent({ metadata: { a: 'x'.repeat(9 * 1024) } }))).toEqual({
      ok: false,
      status: 413,
      field: 'metadata',
    });
    expect(parseEvent(validEvent({ metadata: { a: 'x'.repeat(8 * 1024 - 16) } })).ok).toBe(true);
  });

  it('a shape error wins over a size error', () => {
    const parsed = parseEvent(validEvent({ content: 'a'.repeat(200_000), role: 'tool' }));
    expect(parsed).toMatchObject({ ok: false, status: 422 });
  });
});
