import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import * as quoteModule from '../src/shared/quote.js';
import {
  codePointSubstring,
  normalizeForMatch,
  type QuoteFailureReason,
  type QuoteVerification,
  valueInQuote,
  verifyQuote,
  wordCount,
} from '../src/shared/quote.js';
import { type Prng, prng } from './helpers/prng.js';

/** The §1 invariant of every match, against `Array.from` (code points, as Postgres counts them). */
function expectSane(body: string, result: QuoteVerification): void {
  if (!result.ok) return;
  const chars = Array.from(body);
  expect(Number.isInteger(result.start) && Number.isInteger(result.end)).toBe(true);
  expect(result.start).toBeGreaterThanOrEqual(0);
  expect(result.end).toBeGreaterThan(result.start);
  expect(result.end).toBeLessThanOrEqual(chars.length);
  expect(chars.slice(result.start, result.end).join('')).toBe(result.quote);
  expect(result.occurrences).toBeGreaterThanOrEqual(1);
}

function verified(body: string, quote: string) {
  const result = verifyQuote(body, quote);
  expectSane(body, result);
  return result;
}

const cpLength = (s: string) => Array.from(s).length;

describe('contract with task 5 (§1)', () => {
  it('exports verifyQuote(body, quote), valueInQuote(storedQuote, value) and the types', () => {
    expectTypeOf(verifyQuote).toEqualTypeOf<(body: string, quote: string) => QuoteVerification>();
    expectTypeOf(valueInQuote).toEqualTypeOf<(storedQuote: string, value: string) => boolean>();
    expectTypeOf<QuoteFailureReason>().toEqualTypeOf<
      'quote_length' | 'ellipsis' | 'quote_not_found'
    >();
    expectTypeOf<QuoteVerification>().toEqualTypeOf<
      | {
          ok: true;
          start: number;
          end: number;
          matchKind: 'exact' | 'normalized';
          occurrences: number;
          quote: string;
        }
      | { ok: false; reason: QuoteFailureReason }
    >();
    expect(Object.keys(quoteModule).sort()).toEqual([
      'codePointSubstring',
      'normalizeForMatch',
      'valueInQuote',
      'verifyQuote',
      'wordCount',
    ]);
  });

  it('returns exactly the ok shape and the failure shape', () => {
    const ok = verifyQuote('I use pnpm daily.', 'use pnpm daily');
    expect(Object.keys(ok).sort()).toEqual(
      ['end', 'matchKind', 'occurrences', 'ok', 'quote', 'start'].sort(),
    );
    expect(verifyQuote('I use pnpm daily.', 'use bun daily')).toEqual({
      ok: false,
      reason: 'quote_not_found',
    });
  });
});

const RECORD = 'For the record, my preferred package manager is pnpm. Can you update the README?';
const fourHundred = `${'abcd '.repeat(79)}abcde`;

describe('length and ellipsis gates', () => {
  const rows: [string, string, QuoteFailureReason | 'passes'][] = [
    ["'pnpm' (4 chars)", 'pnpm', 'quote_length'],
    ["'use pnpm' (8 chars, 2 words)", 'use pnpm', 'passes'],
    ["'pnpmpnpm' (8 chars, 1 word)", 'pnpmpnpm', 'quote_length'],
    ["'a b'", 'a b', 'quote_length'],
    ['401 code points with spaces', `${fourHundred}f`, 'quote_length'],
    ['exactly 400 code points', fourHundred, 'passes'],
    ["'my favorite…'", 'my favorite…', 'ellipsis'],
    ["'use pnpm... always'", 'use pnpm... always', 'ellipsis'],
    ["'𝒜𝒷 𝒸𝒹': 5 code points, 9 UTF-16 units", '𝒜𝒷 𝒸𝒹', 'quote_length'],
    ['five emoji: 9 code points, no word', '😀 😀 😀 😀 😀', 'quote_length'],
    // Whitespace to /\s/u, but it joins words for Intl.Segmenter (Word_Break ExtendNumLet).
    ['two words joined only by U+202F count as one', 'pnpm\u202fworks', 'quote_length'],
    ['only quote marks: 11 characters, no word', '" " " " " "', 'quote_length'],
  ];
  for (const [name, quote, expected] of rows) {
    it(`${name} → ${expected}`, () => {
      const body = `Note: ${fourHundred}f and I use pnpm`;
      const result = verified(body, quote);
      if (expected === 'passes') expect(result.ok).toBe(true);
      else expect(result).toEqual({ ok: false, reason: expected });
    });
  }

  it('counts the 400-character gate in code points, not UTF-16 units', () => {
    const quote = `${'😀'.repeat(198)} ab cd`;
    expect(quote.length).toBe(402);
    expect(cpLength(quote)).toBe(204);
    expect(verified(`x ${quote} y`, quote).ok).toBe(true);
  });

  it('counts words with Intl.Segmenter', () => {
    expect(wordCount('你好 世界')).toBe(2);
    expect(wordCount("don't")).toBe(1);
    expect(wordCount('pnpm-lock')).toBe(2);
    expect(wordCount('😀 😀 😀 😀 😀')).toBe(0);
    expect(verified('她说你好 世界很好', '说你好 世界很好').ok).toBe(true);
  });

  it('rejects an ellipsis even when the body really contains it (Decided, §6.5)', () => {
    expect(verified('wait... I prefer bun', 'wait... I prefer bun')).toEqual({
      ok: false,
      reason: 'ellipsis',
    });
  });
});

describe('exact matches', () => {
  it("spec §5.4's numbers: 16 to 52", () => {
    expect(verified(RECORD, 'my preferred package manager is pnpm')).toEqual({
      ok: true,
      start: 16,
      end: 52,
      matchKind: 'exact',
      occurrences: 1,
      quote: 'my preferred package manager is pnpm',
    });
  });

  it('a quote at offset 0', () => {
    expect(verified(RECORD, 'For the record')).toMatchObject({ start: 0, end: 14 });
  });

  it('a quote ending at the last character', () => {
    const result = verified(RECORD, 'update the README?');
    expect(result).toMatchObject({ matchKind: 'exact', end: cpLength(RECORD) });
  });

  it('a quote that occurs twice: occurrences 2, the first hit', () => {
    const body = 'I use pnpm daily. Really, I use pnpm daily.';
    expect(verified(body, 'I use pnpm daily')).toMatchObject({
      start: 0,
      end: 16,
      matchKind: 'exact',
      occurrences: 2,
    });
  });

  it('overlapping occurrences count, hits at 0 and 5', () => {
    // The brief's 'aa aa' in 'aa aa aa' is 5 code points, under the length gate; the same shape.
    const body = 'abcd abcd abcd';
    expect(verified(body, 'abcd abcd')).toMatchObject({ start: 0, end: 9, occurrences: 2 });
    expect(body.indexOf('abcd abcd', 1)).toBe(5);
  });

  it('the whole body as the quote', () => {
    expect(verified(RECORD, RECORD)).toMatchObject({ start: 0, end: cpLength(RECORD) });
  });

  it('NFC: a decomposed quote matches the composed body, and the body text is returned', () => {
    expect(verified('un café au lait', 'café au lait')).toEqual({
      ok: true,
      start: 3,
      end: 15,
      matchKind: 'exact',
      occurrences: 1,
      quote: 'café au lait',
    });
  });

  it('a quote may contain a redaction marker (it is just text)', () => {
    const body = 'my db password=[REDACTED:password] is in the vault';
    expect(verified(body, 'password=[REDACTED:password] is in the vault')).toMatchObject({
      matchKind: 'exact',
      start: 6,
    });
  });
});

describe('normalized matches', () => {
  it('curly quotes and two spaces: the source text, 9 to 32', () => {
    const body = 'She said “use  pnpm” and I agree.';
    const result = verified(body, '"use pnpm" and I agree');
    expect(result).toEqual({
      ok: true,
      start: 9,
      end: 32,
      matchKind: 'normalized',
      occurrences: 1,
      quote: '“use  pnpm” and I agree',
    });
  });

  const rows: [string, string, string, string][] = [
    [
      'en dash in the body',
      'Ship it in Q3 – or Q4 at worst.',
      'Q3 - or Q4 at worst',
      'Q3 – or Q4 at worst',
    ],
    [
      'em dash in the body',
      'It works—mostly—on Linux.',
      'works-mostly-on Linux',
      'works—mostly—on Linux',
    ],
    ['NBSP in the body', 'I use pnpm daily.', 'use pnpm daily', 'use pnpm daily'],
    [
      'a newline and indentation in the body',
      'Rules:\n    always run\n    the tests first',
      'always run the tests',
      'always run\n    the tests',
    ],
    ['a tab in the body', 'name:\tDana Smith here', 'name: Dana Smith', 'name:\tDana Smith'],
    ['a curly apostrophe', 'I don’t use npm anymore.', "don't use npm", 'don’t use npm'],
    [
      '‘single’ quotes in the body',
      'call it ‘the lab’ please',
      "'the lab' please",
      '‘the lab’ please',
    ],
    [
      'the reverse: curly in the quote, straight in the body',
      'She said "use pnpm" twice.',
      '“use pnpm” twice',
      '"use pnpm" twice',
    ],
    ['a minus sign and a hyphen', 'temp was −5 C today', 'was -5 C today', 'was −5 C today'],
  ];
  for (const [name, body, quote, expected] of rows) {
    it(name, () => {
      expect(verified(body, quote)).toMatchObject({
        ok: true,
        matchKind: 'normalized',
        quote: expected,
      });
    });
  }

  it('a quote with a trailing space: the span leaves out the whitespace around it', () => {
    const body = 'I use  pnpm   daily.';
    const result = verified(body, ' use pnpm daily ');
    expect(result).toMatchObject({ matchKind: 'normalized', start: 2, end: 19 });
    expect(result.ok && result.quote).toBe('use  pnpm   daily');
  });

  it('the exact stage wins when any exact hit exists, even after a normalized one', () => {
    const body = 'He said “use pnpm now” and later "use pnpm now" again.';
    const result = verified(body, '"use pnpm now"');
    expect(result).toMatchObject({ matchKind: 'exact', occurrences: 1, quote: '"use pnpm now"' });
    expect(result.ok && result.start).toBe(body.indexOf('"use pnpm now"'));
  });
});

describe('astral characters: offsets are code points', () => {
  it('a quote after an emoji: start 2, end the body length in code points', () => {
    const body = '😀 I prefer pnpm 😀 and bun';
    const result = verified(body, 'I prefer pnpm 😀 and bun');
    expect(result).toMatchObject({ start: 2, end: cpLength(body), matchKind: 'exact' });
    expect(cpLength(body)).toBe(25);
    // UTF-16 offsets would be 3 and 27.
    expect([body.indexOf('I prefer'), body.length]).toEqual([3, 27]);
  });

  it('a normalized match after an emoji', () => {
    const body = '😀😀 she said “use  bun” today';
    expect(verified(body, 'said "use bun" today')).toMatchObject({
      start: 7,
      end: cpLength(body),
      matchKind: 'normalized',
      quote: 'said “use  bun” today',
    });
  });

  it('a normalized match that ends on an emoji', () => {
    const body = 'ok:  “pnpm” wins 😀 for sure';
    const result = verified(body, '"pnpm" wins 😀');
    expect(result).toMatchObject({ start: 5, end: 18, matchKind: 'normalized' });
    expect(result.ok && result.quote).toBe('“pnpm” wins 😀');
  });

  it('50,000 emoji and a sentence: found at the right code-point offset', () => {
    const body = `${'😀'.repeat(50_000)} my preferred package manager is pnpm.`;
    expect(verified(body, 'preferred package manager')).toMatchObject({
      start: 50_004,
      end: 50_029,
      matchKind: 'exact',
    });
    expect(verified(body, 'preferred  package\nmanager')).toMatchObject({
      start: 50_004,
      end: 50_029,
      matchKind: 'normalized',
    });
  });
});

describe('must fail: quote_not_found', () => {
  const rows: [string, string, string][] = [
    ['different case', RECORD, 'My Preferred package manager is pnpm'],
    ['a dropped word', RECORD, 'my preferred manager is pnpm'],
    ['an added word', RECORD, 'my preferred node package manager is pnpm'],
    ['swapped word order', RECORD, 'my package preferred manager is pnpm'],
    ['a typo', RECORD, 'my prefered package manager is pnpm'],
    ['a lone surrogate in the quote', RECORD, 'my preferred \ud800 package'],
    ['a zero-width space in the quote', RECORD, 'my pre​ferred package'],
    ['a zero-width space in the body', 'my pre​ferred package', 'my preferred package'],
    ['a fold that would need case', 'I moved to İstanbul last year', 'moved to istanbul'],
    ['accents', 'I drink café au lait daily', 'drink cafe au lait'],
    ['a full-width quote mark', 'she said ＂hi there＂ ok', 'said "hi there" ok'],
  ];
  for (const [name, body, quote] of rows) {
    it(name, () => {
      expect(verified(body, quote)).toEqual({ ok: false, reason: 'quote_not_found' });
    });
  }

  it('a quote found only in a string that is not passed (A4 "context only", at unit level)', () => {
    const context = 'My sister Dana works at Acme Corp as a data engineer.';
    const quote = 'works at Acme Corp as a data engineer';
    expect(verified(context, quote).ok).toBe(true);
    expect(verified(RECORD, quote)).toEqual({ ok: false, reason: 'quote_not_found' });
  });
});

describe('never throws', () => {
  const big = 'lorem ipsum dolor sit amet '.repeat(4_000).slice(0, 100_000);
  const rows: [string, string, string][] = [
    ['an empty body', '', 'use pnpm daily'],
    ['an empty quote', RECORD, ''],
    ['both empty', '', ''],
    ['NUL characters', 'a\u0000b use\u0000pnpm daily', 'use\u0000pnpm daily'],
    ['a lone high surrogate in the body', 'x\ud83d use pnpm daily', 'use pnpm daily'],
    ['a lone low surrogate in the body', '\ude00use pnpm daily\ud83d', 'use pnpm daily'],
    ['lone surrogates in the quote', RECORD, '\ude00\ud83d preferred \ud83d'],
    ['a 100,000-character body', big, 'dolor sit amet lorem'],
    ['a 100,000-character quote', RECORD, big],
    [
      'a 400-character quote of one character and a space',
      'b'.repeat(500),
      `${'b'.repeat(199)} ${'b'.repeat(200)}`,
    ],
  ];
  for (const [name, body, quote] of rows) {
    it(name, () => {
      expect(() => verifyQuote(body, quote)).not.toThrow();
      expectSane(body, verifyQuote(body, quote));
      expect(() => valueInQuote(body, quote)).not.toThrow();
    });
  }

  it('a body with a lone surrogate before the match keeps code-point offsets', () => {
    const body = '\ud83d😀 use pnpm daily';
    expect(verified(body, 'use pnpm daily')).toMatchObject({ start: 3, end: 17 });
  });
});

describe('normalization is a closed table (§3)', () => {
  const table: [string, string][] = [
    ['‘’‚‛′', "'"],
    ['“”„‟″', '"'],
    ['‐‑‒–—―−', '-'],
  ];
  for (const [from, to] of table) {
    it(`${[...from].join(' ')} → ${to}`, () => {
      for (const ch of from) expect(normalizeForMatch(`a${ch}b`)).toBe(`a${to}b`);
    });
  }

  it('every whitespace character (/\\s/u) becomes one space, and a run becomes one', () => {
    const spaces = [' ', ' ', ' ', ' ', '　', '\n', '\r', '\t', '﻿'];
    for (const ch of spaces) expect(normalizeForMatch(`a${ch}b`)).toBe('a b');
    expect(normalizeForMatch(`a${spaces.join('')}b`)).toBe('a b');
    for (let cp = 0; cp <= 0xffff; cp++) {
      const ch = String.fromCharCode(cp);
      if (/\s/u.test(ch)) expect(normalizeForMatch(`a${ch}b`)).toBe('a b');
    }
  });

  it('trims leading and trailing whitespace', () => {
    expect(normalizeForMatch(' \n  use  pnpm \t')).toBe('use pnpm');
    expect(normalizeForMatch('   ')).toBe('');
  });

  it('does not fold case, accents, the ellipsis, zero-width spaces or other punctuation', () => {
    for (const s of ['My Pnpm', 'café', 'café', 'a…b', 'a​b', '«x»', '＂x＂', '‹x›']) {
      expect(normalizeForMatch(s)).toBe(s);
    }
  });

  it('leaves every other BMP character as it was', () => {
    const folded = new Set([...table.map(([from]) => from).join('')]);
    for (let cp = 0; cp <= 0xffff; cp++) {
      const ch = String.fromCharCode(cp);
      if (folded.has(ch) || /\s/u.test(ch)) continue;
      expect(normalizeForMatch(`a${ch}b`)).toBe(`a${ch}b`);
    }
  });
});

describe('valueInQuote (§4)', () => {
  const rows: [string, string, boolean][] = [
    ['my preferred package manager is pnpm', 'pnpm', true],
    ['Dana is my contact', 'dana', true],
    ['works at Acme Corp.', 'Acme Corp', true],
    ['it costs $3.50', '3.50', true],
    ['I live in Austin', 'Boston', false],
    ['three days', '3 days', false],
    ['pnpm', '', false],
    ['…', '—', false],
    ['she said "use pnpm" twice', '“use pnpm”', true],
    ['I PREFER Pnpm Daily', 'pnpm daily', true],
    ['我喜欢用pnpm工具', '用pnpm', true],
  ];
  for (const [quote, value, expected] of rows) {
    it(`(${JSON.stringify(quote)}, ${JSON.stringify(value)}) → ${expected}`, () => {
      expect(valueInQuote(quote, value)).toBe(expected);
    });
  }
});

// ---------------------------------------------------------------------------------------------
// Properties (§7), with a seeded generator and an independent, slow oracle.

const CASES = 2_000;

const SINGLES = ["'", '‘', '’', '‚', '‛', '′'];
const DOUBLES = ['"', '“', '”', '„', '‟', '″'];
const DASHES = ['-', '‐', '‑', '‒', '–', '—', '―', '−'];
const SPACES = [' ', '\n', '\t', ' ', ' ', ' ', '　', '\r'];
const GAP_SPACES = [' ', '\n', '\t', ' ', '  '];
const GAP_MARKS = ["'", '’', '‘', '"', '“', '”', '-', '–', '—', '.', ',', '😀'];
const LETTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

interface Generated {
  body: string;
  /** Code-point [start, end) of each word. */
  words: [number, number][];
}

function genWord(r: Prng): string {
  let word = '';
  const length = 1 + r.int(6);
  for (let i = 0; i < length; i++) {
    word += r.chance(0.05) ? r.pick(['é', '日']) : (LETTERS[r.int(LETTERS.length)] ?? 'a');
  }
  return word;
}

function genBody(r: Prng): Generated {
  const count = 3 + r.int(12);
  const parts: string[] = [];
  const words: [number, number][] = [];
  let at = 0;
  const push = (s: string) => {
    parts.push(s);
    at += cpLength(s);
  };
  if (r.chance(0.2)) push(r.pick(GAP_MARKS));
  for (let i = 0; i < count; i++) {
    if (i > 0) {
      // Every gap holds whitespace, so Intl.Segmenter and split(/\s+/) agree on the words.
      if (r.chance(0.3)) push(r.pick(GAP_MARKS));
      push(r.pick(GAP_SPACES));
      if (r.chance(0.3)) push(r.pick(GAP_MARKS));
    }
    const word = genWord(r);
    words.push([at, at + cpLength(word)]);
    push(word);
  }
  if (r.chance(0.3)) push(r.pick(GAP_MARKS));
  return { body: parts.join(''), words };
}

interface Span {
  text: string;
  start: number;
  end: number;
  /** The span's words, as [start, end) offsets relative to the span. */
  words: [number, number][];
}

/** k >= 2 consecutive words and the gaps between them, 8 to 400 code points; null if none fits. */
function genSpan(r: Prng, g: Generated): Span | null {
  for (let attempt = 0; attempt < 20; attempt++) {
    const first = r.int(g.words.length - 1);
    const last = first + 1 + r.int(g.words.length - first - 1);
    const start = g.words[first]?.[0] ?? 0;
    const end = g.words[last]?.[1] ?? 0;
    if (end - start < 8 || end - start > 400) continue;
    const text = Array.from(g.body).slice(start, end).join('');
    const words = g.words
      .slice(first, last + 1)
      .map(([s, e]): [number, number] => [s - start, e - start]);
    return { text, start, end, words };
  }
  return null;
}

/** A case's body, span and seed; at most `CASES` of them, skipping bodies with no span. */
function* cases(seed: number): Generator<{ r: Prng; index: number; g: Generated; span: Span }> {
  const r = prng(seed);
  for (let index = 0; index < CASES; ) {
    const g = genBody(r);
    const span = genSpan(r, g);
    if (!span) continue;
    yield { r, index, g, span };
    index++;
  }
}

const describeCase = (seed: number, index: number, body: string, quote: string) =>
  `seed ${seed}, case ${index}\n  body:  ${JSON.stringify(body)}\n  quote: ${JSON.stringify(quote)}`;

// The oracle: plain, slow, and written without looking at quote.ts. Code points via Array.from, the
// §3 table as a regex chain, and a direct comparison at every start.
const foldOne = (ch: string) =>
  ch
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, '-');
const oracleFold = (s: string) => foldOne(s).replace(/\s+/gu, ' ').trim();
const isSpace = (ch: string) => /^\s$/u.test(ch);

interface OracleResult {
  ok: boolean;
  matchKind?: 'exact' | 'normalized';
  start?: number;
  end?: number;
  occurrences?: number;
}

/** null when the quote doesn't pass the length and ellipsis gates (counted with split(/\s+/)). */
function oracle(body: string, quote: string): OracleResult | null {
  const length = cpLength(quote);
  const words = quote.split(/\s+/).filter((w) => w !== '').length;
  if (length < 8 || length > 400 || words < 2) return null;
  if (quote.includes('…') || quote.includes('...')) return null;
  const q = quote.normalize('NFC');
  if (!q.isWellFormed()) return { ok: false };
  const b = Array.from(body);
  const qs = Array.from(q);

  const exact: number[] = [];
  for (let s = 0; s + qs.length <= b.length; s++) {
    if (b.slice(s, s + qs.length).join('') === q) exact.push(s);
  }
  if (exact.length > 0) {
    const start = exact[0] ?? 0;
    return {
      ok: true,
      matchKind: 'exact',
      start,
      end: start + qs.length,
      occurrences: exact.length,
    };
  }

  // A normalized hit at s: each character of nq matches one body character after folding, and each
  // space in nq matches a whole run of body whitespace.
  const nq = Array.from(oracleFold(q));
  if (nq.length === 0) return { ok: false };
  const hits: [number, number][] = [];
  for (let s = 0; s < b.length; s++) {
    let i = s;
    let ok = true;
    for (const ch of nq) {
      if (ch === ' ') {
        if (i >= b.length || !isSpace(b[i] ?? '')) {
          ok = false;
          break;
        }
        while (i < b.length && isSpace(b[i] ?? '')) i++;
      } else if (i < b.length && !isSpace(b[i] ?? '') && foldOne(b[i] ?? '') === ch) {
        i++;
      } else {
        ok = false;
        break;
      }
    }
    if (ok) hits.push([s, i]);
  }
  const [first] = hits;
  if (!first) return { ok: false };
  return {
    ok: true,
    matchKind: 'normalized',
    start: first[0],
    end: first[1],
    occurrences: hits.length,
  };
}

/** Whether `quote` is in `body` as the oracle sees it (exact or folded). */
const oracleFinds = (body: string, quote: string) =>
  body.includes(quote.normalize('NFC')) ||
  oracleFold(body).includes(oracleFold(quote.normalize('NFC')));

const jitterClass = (ch: string): readonly string[] | null =>
  SINGLES.includes(ch)
    ? SINGLES
    : DOUBLES.includes(ch)
      ? DOUBLES
      : DASHES.includes(ch)
        ? DASHES
        : null;

/** Each typography character to another of its class, each whitespace run to 1-3 whitespace. */
function jitter(r: Prng, text: string): string {
  let out = '';
  let inRun = false;
  for (const ch of text) {
    if (isSpace(ch)) {
      if (!inRun) {
        const n = 1 + r.int(3);
        for (let i = 0; i < n; i++) out += r.pick(SPACES);
      }
      inRun = true;
      continue;
    }
    inRun = false;
    const cls = jitterClass(ch);
    out += cls ? r.pick(cls) : ch;
  }
  return out;
}

const passesGate = (quote: string) => {
  const length = cpLength(quote);
  return length >= 8 && length <= 400 && wordCount(quote) >= 2;
};

describe('properties (2,000 cases each, fixed seeds)', () => {
  it('1. self-match: a span of the body verifies exactly, at or before its own offset', () => {
    const seed = 101;
    for (const { index, g, span } of cases(seed)) {
      const result = verified(g.body, span.text);
      const where = describeCase(seed, index, g.body, span.text);
      expect(result.ok, where).toBe(true);
      if (!result.ok) continue;
      expect(result.quote, where).toBe(span.text);
      expect(result.matchKind, where).toBe('exact');
      expect(result.start, where).toBeLessThanOrEqual(span.start);
      if (result.occurrences === 1) expect(result.start, where).toBe(span.start);
    }
  });

  it("2. jitter: typography and whitespace changes still verify, returning the body's text", () => {
    const seed = 202;
    let normalized = 0;
    for (const { r, index, g, span } of cases(seed)) {
      const quote = jitter(r, span.text);
      if (!passesGate(quote)) continue;
      const result = verified(g.body, quote);
      const where = describeCase(seed, index, g.body, quote);
      expect(result.ok, where).toBe(true);
      if (!result.ok) continue;
      if (g.body.includes(quote)) {
        expect(result.matchKind, where).toBe('exact');
        expect(result.quote, where).toBe(quote);
        continue;
      }
      normalized++;
      expect(result.matchKind, where).toBe('normalized');
      expect(oracleFold(result.quote), where).toBe(oracleFold(quote));
      expect(result.start, where).toBeLessThanOrEqual(span.start);
      if (result.start === span.start) expect(result.quote, where).toBe(span.text);
      if (result.occurrences === 1) expect(result.quote, where).toBe(span.text);
    }
    expect(normalized).toBeGreaterThan(CASES / 2);
  });

  it('3. case mutation: upper-casing one letter fails unless the result is still in the body', () => {
    const seed = 303;
    let failed = 0;
    for (const { r, index, g, span } of cases(seed)) {
      const chars = Array.from(span.text);
      const lower = chars.flatMap((ch, i) => (ch !== ch.toUpperCase() ? [i] : []));
      if (lower.length === 0) continue;
      const at = r.pick(lower);
      chars[at] = (chars[at] ?? '').toUpperCase();
      const quote = chars.join('');
      if (oracleFinds(g.body, quote)) continue;
      const where = describeCase(seed, index, g.body, quote);
      expect(verified(g.body, quote), where).toEqual({ ok: false, reason: 'quote_not_found' });
      failed++;
    }
    expect(failed).toBeGreaterThan(CASES / 2);
  });

  it('4. word mutation: a deleted word or a changed letter fails unless still in the body', () => {
    const seed = 404;
    let failed = 0;
    for (const { r, index, g, span } of cases(seed)) {
      const chars = Array.from(span.text);
      let quote: string;
      if (r.chance(0.5)) {
        // Delete one word and the gap after it (or before it, for the last word).
        const w = r.int(span.words.length);
        const [s, e] = span.words[w] ?? [0, 0];
        const next = span.words[w + 1];
        const prev = span.words[w - 1];
        quote = next
          ? [...chars.slice(0, s), ...chars.slice(next[0])].join('')
          : [...chars.slice(0, prev?.[1] ?? s), ...chars.slice(e)].join('');
      } else {
        const letters = chars.flatMap((ch, i) => (/[a-zA-Z]/.test(ch) ? [i] : []));
        if (letters.length === 0) continue;
        const at = r.pick(letters);
        let replacement = chars[at] ?? 'a';
        while (replacement === chars[at]) replacement = LETTERS[r.int(LETTERS.length)] ?? 'a';
        chars[at] = replacement;
        quote = chars.join('');
      }
      if (!passesGate(quote)) continue;
      const where = describeCase(seed, index, g.body, quote);
      const result = verified(g.body, quote);
      expect(result.ok, where).toBe(oracleFinds(g.body, quote));
      if (!result.ok) {
        expect(result.reason, where).toBe('quote_not_found');
        failed++;
      }
    }
    expect(failed).toBeGreaterThan(CASES / 2);
  });

  it('5. offsets are code points: n leading emoji move start and end by exactly n', () => {
    const seed = 505;
    for (const { r, index, g, span } of cases(seed)) {
      const quote = r.chance(0.5) ? span.text : jitter(r, span.text);
      if (!passesGate(quote)) continue;
      const n = r.int(21);
      const shifted = '😀'.repeat(n) + g.body;
      const where = describeCase(seed, index, shifted, quote);
      const before = verified(g.body, quote);
      const after = verified(shifted, quote);
      expect(before.ok, where).toBe(true);
      if (!before.ok) continue;
      expect(after, where).toEqual({ ...before, start: before.start + n, end: before.end + n });
    }
  });

  it('6. oracle agreement: ok, matchKind, start, end and occurrences', () => {
    const seed = 606;
    let compared = 0;
    let normalized = 0;
    for (const { r, index, g, span } of cases(seed)) {
      const chars = Array.from(g.body);
      let quote: string;
      const kind = r.int(4);
      if (kind === 0) quote = span.text;
      else if (kind === 1) quote = jitter(r, span.text);
      else if (kind === 2) {
        // Any stretch from a letter to a letter, possibly mid-word.
        const letters = chars.flatMap((ch, i) => (/[a-zA-Zé日]/.test(ch) ? [i] : []));
        const from = r.pick(letters);
        const to = from + r.int(40);
        const ends = letters.filter((i) => i > from && i <= to);
        if (ends.length === 0) continue;
        quote = jitter(r, chars.slice(from, r.pick(ends) + 1).join(''));
      } else {
        // A span from somewhere else: usually not in this body.
        quote = genSpan(r, genBody(r))?.text ?? span.text;
      }
      const expected = oracle(g.body, quote);
      // Past both gates only: U+202F and U+FEFF are whitespace to split(/\s+/) but join words for
      // Intl.Segmenter (Word_Break ExtendNumLet and Format), so a jittered gap can make one word.
      if (expected === null || wordCount(quote) < 2) continue;
      const where = describeCase(seed, index, g.body, quote);
      const result = verified(g.body, quote);
      const actual: OracleResult = result.ok
        ? {
            ok: true,
            matchKind: result.matchKind,
            start: result.start,
            end: result.end,
            occurrences: result.occurrences,
          }
        : { ok: false };
      expect(actual, where).toEqual(expected);
      if (!result.ok) expect(result.reason, where).toBe('quote_not_found');
      compared++;
      if (result.ok && result.matchKind === 'normalized') normalized++;
    }
    expect(compared).toBeGreaterThan(CASES * 0.8);
    expect(normalized).toBeGreaterThan(CASES / 10);
  });

  it('7. never throws, always sane: arbitrary strings, lone surrogates and NUL included', () => {
    const seed = 707;
    const alphabet = [
      ...'abcAB é日.,',
      ...SINGLES,
      ...DOUBLES,
      ...DASHES,
      ...SPACES,
      '﻿',
      '…',
      '😀',
      '\ud83d',
      '\ude00',
      '\u0000',
      '́',
      '​',
    ];
    const r = prng(seed);
    const text = (max: number) => {
      let s = '';
      const length = r.int(max);
      for (let i = 0; i < length; i++) s += r.pick(alphabet);
      return s;
    };
    for (let index = 0; index < CASES; index++) {
      const body = text(80);
      let quote: string;
      if (r.chance(0.5) && body.length > 0) {
        // A slice in UTF-16 units: it can cut a surrogate pair in half.
        const from = r.int(body.length);
        quote = body.slice(from, from + 8 + r.int(40));
      } else quote = text(40);
      const where = describeCase(seed, index, body, quote);
      let result: QuoteVerification | undefined;
      expect(() => {
        result = verifyQuote(body, quote);
      }, where).not.toThrow();
      expect(result, where).toBeDefined();
      if (result) expectSane(body, result);
      expect(() => valueInQuote(body, quote), where).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Adversarial inputs and time guards (§7). Each must finish well under 250 ms; the real numbers are
// a few ms, and the bound is generous so a loaded CI runner doesn't flake.

const timed = <T>(f: () => T): { value: T; ms: number } => {
  const started = performance.now();
  const value = f();
  return { value, ms: performance.now() - started };
};

describe('adversarial inputs and time guards', () => {
  const spaced = (a: number, mid: string, b: number, tail = '', c = 0) =>
    ' '.repeat(a) + mid + ' '.repeat(b) + tail + ' '.repeat(c);
  const rows: [string, string, string, (r: QuoteVerification, body: string) => void][] = [
    [
      'a near miss at the first character',
      'a'.repeat(100_000),
      `b ${'a'.repeat(398)}`,
      (r) => expect(r).toEqual({ ok: false, reason: 'quote_not_found' }),
    ],
    [
      'a near miss at the last character',
      'a'.repeat(100_000),
      `${'a'.repeat(398)} b`,
      (r) => expect(r).toEqual({ ok: false, reason: 'quote_not_found' }),
    ],
    [
      'about 50,000 overlapping exact hits',
      'a '.repeat(50_000),
      `${'a '.repeat(199)}a`,
      (r) =>
        expect(r).toMatchObject({ start: 0, end: 399, matchKind: 'exact', occurrences: 49_801 }),
    ],
    [
      'whitespace-heavy normalization, not found',
      spaced(100_000, 'x', 100_000),
      'x yyyyyyy',
      (r) => expect(r).toEqual({ ok: false, reason: 'quote_not_found' }),
    ],
    [
      'whitespace-heavy normalization, found at 100,000 to 200,008',
      spaced(100_000, 'xx', 100_000, 'yyyyyy', 100_000),
      'xx yyyyyy',
      (r) =>
        expect(r).toMatchObject({
          start: 100_000,
          end: 200_008,
          matchKind: 'normalized',
          occurrences: 1,
        }),
    ],
    [
      'about 33,000 normalized hits',
      '“a '.repeat(33_333),
      '"a "a "a "a',
      (r) =>
        expect(r).toMatchObject({
          start: 0,
          end: 11,
          matchKind: 'normalized',
          occurrences: 33_330,
        }),
    ],
    [
      'a normalized near miss on every hit',
      '“a '.repeat(33_333),
      '"a "a "a "b',
      (r) => expect(r).toEqual({ ok: false, reason: 'quote_not_found' }),
    ],
    [
      '100,000 emoji around the quote: code-point offset 50,001',
      `${'😀'.repeat(50_000)} ab cd ${'😀'.repeat(50_000)}`,
      'ab cd 😀😀',
      (r, body) => {
        expect(r).toMatchObject({ start: 50_001, end: 50_009, matchKind: 'exact' });
        expect(Array.from(body).slice(50_001, 50_009).join('')).toBe('ab cd 😀😀');
      },
    ],
    [
      '100,000 emoji around a near miss',
      `${'😀'.repeat(50_000)} ab cd ${'😀'.repeat(50_000)}`,
      'ab cd 😀😀x',
      (r) => expect(r).toEqual({ ok: false, reason: 'quote_not_found' }),
    ],
    [
      'no spaces in the body, 399 characters in the quote',
      'ab'.repeat(50_000),
      `${'ab'.repeat(100)} ${'ab'.repeat(99)}`,
      (r) => expect(r).toEqual({ ok: false, reason: 'quote_not_found' }),
    ],
  ];
  for (const [name, body, quote, check] of rows) {
    it(name, () => {
      verifyQuote(body, quote); // warm-up, so the measurement is the algorithm and not the JIT
      const { value, ms } = timed(() => verifyQuote(body, quote));
      check(value, body);
      expectSane(body, value);
      console.info(`quote time guard: ${name}: ${ms.toFixed(2)} ms`);
      expect(ms).toBeLessThan(250);
    });
  }

  it('valueInQuote on 100,000 characters', () => {
    const { ms } = timed(() => valueInQuote('a—'.repeat(50_000), '—a'.repeat(1_000)));
    expect(ms).toBeLessThan(250);
  });

  it('ReDoS guard: no regex built from input, no nested quantifier, no backtracking trim', () => {
    const source = readFileSync(new URL('../src/shared/quote.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('new RegExp(');
    for (const nested of ['+)+', '*)*', '+)*', '*)+']) expect(source).not.toContain(nested);
    // The whitespace collapse is one pass over the code points: no \s quantified at all.
    for (const run of ['\\s+', '\\s*', '\\s{']) expect(source).not.toContain(run);
    // Only fixed patterns on single characters, and the one run class for valueInQuote.
    const literals = source.match(
      /(?<![\w)\]])\/(?![/*])(?:\\.|\[(?:\\.|[^\]])*\]|[^/\n])+\/[gimsuy]*/g,
    );
    expect(new Set(literals)).toEqual(new Set(['/[^\\p{L}\\p{N}]+/gu', '/\\s/u']));
  });
});

describe('codePointSubstring', () => {
  it('agrees with Array.from on astral characters and lone surrogates', () => {
    const s = 'a😀b\ud83dc\ude00d😀';
    const chars = Array.from(s);
    for (let start = 0; start <= chars.length; start++) {
      for (let end = start; end <= chars.length + 1; end++) {
        expect(codePointSubstring(s, start, end)).toBe(chars.slice(start, end).join(''));
      }
    }
  });
});
