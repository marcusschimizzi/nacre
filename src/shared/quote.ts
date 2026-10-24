/**
 * Quote verification (spec §6.5): the model proposes a quote, and code decides whether it is really
 * in the TARGET event's stored body. On a match it returns the span in Unicode code points (as
 * Postgres `substring` counts them), how it matched, how many times it occurs, and the body's own
 * text at that span, which is what gets stored. Pure and synchronous, never throws, logs nothing,
 * and runs in linear time in the body's length.
 */

export type QuoteFailureReason = 'quote_length' | 'ellipsis' | 'quote_not_found';

export type QuoteVerification =
  | {
      ok: true;
      /** First match, in Unicode code points into `body`: [start, end). */
      start: number;
      end: number;
      matchKind: 'exact' | 'normalized';
      /** How many matches in all (>= 1). */
      occurrences: number;
      /** The body's own text at [start, end), never the model's string. */
      quote: string;
    }
  | { ok: false; reason: QuoteFailureReason };

/** The length gate (spec §6.5), on the quote as the model gave it. */
const MIN_CHARS = 8;
const MAX_CHARS = 400;
const MIN_WORDS = 2;

/** Spec §6.5. `body` is the stored NFC body of the TARGET event only. Pure and never throws. */
export function verifyQuote(body: string, quote: string): QuoteVerification {
  try {
    return verify(body, quote);
  } catch {
    // Nothing above is expected to throw; a failure is a value either way (the worker relies on it).
    return fail('quote_not_found');
  }
}

/** Spec §6.5, `checks.value_in_quote`: a soft signal, never a gate. Pure and never throws. */
export function valueInQuote(storedQuote: string, value: string): boolean {
  try {
    const needle = valueText(value);
    return needle.length > 0 && valueText(storedQuote).includes(needle);
  } catch {
    return false;
  }
}

const fail = (reason: QuoteFailureReason): QuoteVerification => ({ ok: false, reason });

function verify(body: string, quote: string): QuoteVerification {
  // The word count last: it is the only step that isn't a plain count, and a long quote fails anyway.
  const chars = codePointLength(quote);
  if (chars < MIN_CHARS || chars > MAX_CHARS || wordCount(quote) < MIN_WORDS) {
    return fail('quote_length');
  }
  if (quote.includes('…') || quote.includes('...')) return fail('ellipsis');
  const q = quote.normalize('NFC');
  // A lone surrogate can't be in a stored body: Postgres can't hold one.
  if (!q.isWellFormed()) return fail('quote_not_found');

  // A well-formed quote starts and ends on code-point boundaries, so a hit found in UTF-16 units is
  // a code-point hit too; only its offset needs converting.
  const exact = findAll(body, q);
  if (exact.count > 0) {
    const start = codePointIndex(body, exact.first);
    return span(body, start, start + codePointLength(q), 'exact', exact.count, q);
  }

  const nq = fold(q).text;
  if (nq.length === 0) return fail('quote_not_found');
  const nb = fold(body);
  const hits = findAll(nb.text, nq);
  if (hits.count === 0) return fail('quote_not_found');
  // Both ends of a hit are non-space characters, so the span never takes in the whitespace around it.
  const start = nb.map[hits.first] ?? -1;
  const end = (nb.map[hits.first + nq.length - 1] ?? -2) + 1;
  return span(body, start, end, 'normalized', hits.count, nq);
}

/**
 * A match at [start, end): the stored quote is the body's own text there. Defensive check: that
 * text must be what was searched for (folded, for a normalized match), or the match is dropped.
 */
function span(
  body: string,
  start: number,
  end: number,
  matchKind: 'exact' | 'normalized',
  occurrences: number,
  searched: string,
): QuoteVerification {
  const quote = codePointSubstring(body, start, end);
  const found = matchKind === 'exact' ? quote : fold(quote).text;
  if (!(start >= 0 && end > start) || found !== searched) return fail('quote_not_found');
  return { ok: true, start, end, matchKind, occurrences, quote };
}

const WORDS = new Intl.Segmenter('en', { granularity: 'word' });

/** Word-like `Intl.Segmenter` segments: "你好 世界" is 2, "don't" is 1, "pnpm-lock" is 2. */
export function wordCount(text: string): number {
  let words = 0;
  for (const segment of WORDS.segment(text)) if (segment.isWordLike) words++;
  return words;
}

const isHigh = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;
const isLow = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff;

/** UTF-16 units in the code point at `i`: 2 for a surrogate pair, else 1 (a lone surrogate too). */
const width = (s: string, i: number): number =>
  isHigh(s.charCodeAt(i)) && isLow(s.charCodeAt(i + 1)) ? 2 : 1;

/** Code points, as `Array.from` counts them: a lone surrogate is one. */
function codePointLength(s: string): number {
  let count = 0;
  for (let i = 0; i < s.length; i += width(s, i)) count++;
  return count;
}

/** The code-point index of UTF-16 index `unit`, which is on a code-point boundary. */
function codePointIndex(s: string, unit: number): number {
  let count = 0;
  for (let i = 0; i < unit; i += width(s, i)) count++;
  return count;
}

/**
 * `Array.from(s).slice(start, end).join('')` for `0 <= start <= end`, without building the array:
 * what Postgres `substring(s FROM start + 1 FOR end - start)` returns.
 */
export function codePointSubstring(s: string, start: number, end: number): string {
  let i = 0;
  for (let cp = 0; i < s.length && cp < start; cp++) i += width(s, i);
  const from = i;
  for (let cp = start; i < s.length && cp < end; cp++) i += width(s, i);
  return s.slice(from, i);
}

/**
 * The closed folding table (spec §6.5): typography to its ASCII form. Anything not listed is
 * unchanged: case, accents, `…`, full-width forms and zero-width characters are never folded.
 */
const FOLDS: readonly [string, string][] = [
  ['‘’‚‛′', "'"],
  ['“”„‟″', '"'],
  ['‐‑‒–—―−', '-'],
];
const FOLD = new Map<number, number>(
  FOLDS.flatMap(([from, to]) =>
    [...from].map((ch): [number, number] => [ch.charCodeAt(0), to.charCodeAt(0)]),
  ),
);

const WHITESPACE = /\s/u;

/** Exactly `/\s/u` for one BMP unit (no astral character is whitespace), ASCII without the regex. */
function isWhitespace(unit: number): boolean {
  if (unit < 0x80) return unit === 0x20 || (unit >= 0x09 && unit <= 0x0d);
  return WHITESPACE.test(String.fromCharCode(unit));
}

interface Folded {
  text: string;
  /** For each UTF-16 unit of `text`, the code-point index in the source of the character it came from. */
  map: Int32Array;
}

/**
 * Folds `s` with the table, collapses each whitespace run to one space and trims, in one pass over
 * its code points. A collapsed run maps to the run's first character; both units of an astral
 * character map to the same index. Never longer than `s`.
 */
function fold(s: string): Folded {
  const units = new Uint16Array(s.length);
  const map = new Int32Array(s.length);
  let n = 0;
  // The first code point of the whitespace run before the current character, or -1. A run is only
  // written out when a non-space follows it, which drops leading and trailing runs.
  let run = -1;
  for (let i = 0, cp = 0; i < s.length; cp++) {
    const unit = s.charCodeAt(i);
    const w = width(s, i);
    if (w === 1 && isWhitespace(unit)) {
      if (n > 0 && run < 0) run = cp;
      i += 1;
      continue;
    }
    if (run >= 0) {
      units[n] = 0x20;
      map[n++] = run;
      run = -1;
    }
    units[n] = w === 1 ? (FOLD.get(unit) ?? unit) : unit;
    map[n++] = cp;
    if (w === 2) {
      units[n] = s.charCodeAt(i + 1);
      map[n++] = cp;
    }
    i += w;
  }
  return { text: decode(units, n), map };
}

/** The first `length` units as a string, in chunks small enough to pass as arguments. */
function decode(units: Uint16Array, length: number): string {
  let text = '';
  for (let from = 0; from < length; from += 8192) {
    text += String.fromCharCode(...units.subarray(from, Math.min(from + 8192, length)));
  }
  return text;
}

/** The §6.5 fold of `s` (typography table, whitespace runs to one space, trimmed), as a string. */
export function normalizeForMatch(s: string): string {
  return fold(s).text;
}

/**
 * The first UTF-16 index of `pattern` in `text`, and how many times it occurs, overlapping hits
 * included. Knuth-Morris-Pratt: linear in `text` whatever the input, however many hits.
 */
function findAll(text: string, pattern: string): { first: number; count: number } {
  const m = pattern.length;
  if (m === 0 || m > text.length) return { first: -1, count: 0 };
  // border[i]: the length of the longest proper prefix of pattern[0..i] that is also its suffix.
  const border = new Int32Array(m);
  for (let i = 1, k = 0; i < m; i++) {
    while (k > 0 && pattern.charCodeAt(i) !== pattern.charCodeAt(k)) k = border[k - 1] ?? 0;
    if (pattern.charCodeAt(i) === pattern.charCodeAt(k)) k++;
    border[i] = k;
  }
  let first = -1;
  let count = 0;
  for (let i = 0, k = 0; i < text.length; i++) {
    while (k > 0 && text.charCodeAt(i) !== pattern.charCodeAt(k)) k = border[k - 1] ?? 0;
    if (text.charCodeAt(i) === pattern.charCodeAt(k)) k++;
    if (k === m) {
      if (first < 0) first = i - m + 1;
      count++;
      k = border[k - 1] ?? 0;
    }
  }
  return { first, count };
}

const NOT_LETTER_OR_DIGIT = /[^\p{L}\p{N}]+/gu;

/**
 * `value_in_quote`'s form of a string: NFC, folded, lowercased, each run of characters that are
 * neither letters nor digits as one space, trimmed. "$3.50" becomes "3 50".
 */
function valueText(s: string): string {
  return normalizeForMatch(s.normalize('NFC'))
    .toLowerCase()
    .replace(NOT_LETTER_OR_DIGIT, ' ')
    .trim();
}
