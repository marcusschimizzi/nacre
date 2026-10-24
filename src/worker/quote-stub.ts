/**
 * TEMPORARY, exact-only stand-in for task 6's `src/shared/quote.ts`, with the same types and
 * signatures (task 5 brief §9). No NFC and no normalization on purpose: a better stub would hide a
 * broken wiring. Delete this file when `src/worker/quote.ts` re-exports the real verifier.
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

const codePoints = (s: string): number => Array.from(s).length;

/** Spec §6.5. `body` is the stored NFC body of the TARGET event only. Pure and never throws. */
export function verifyQuote(body: string, quote: string): QuoteVerification {
  const length = codePoints(quote);
  const words = quote.split(/\s+/).filter(Boolean).length;
  if (length < 8 || words < 2 || length > 400) return { ok: false, reason: 'quote_length' };
  if (quote.includes('...') || quote.includes('…')) return { ok: false, reason: 'ellipsis' };

  const first = body.indexOf(quote);
  if (first < 0) return { ok: false, reason: 'quote_not_found' };
  let occurrences = 0;
  for (let i = first; i >= 0; i = body.indexOf(quote, i + quote.length)) occurrences++;
  // UTF-16 index to code-point index: count the code points before the hit.
  const start = codePoints(body.slice(0, first));
  return {
    ok: true,
    start,
    end: start + length,
    matchKind: 'exact',
    occurrences,
    quote: body.slice(first, first + quote.length),
  };
}

/** Spec §6.5, `checks.value_in_quote`: a soft signal, never a gate. Pure and never throws. */
export function valueInQuote(storedQuote: string, value: string): boolean {
  const fold = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  const v = fold(value);
  return v.length > 0 && fold(storedQuote).includes(v);
}
