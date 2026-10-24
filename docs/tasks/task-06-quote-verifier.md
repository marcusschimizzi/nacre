# Task 6: Quote verifier (`src/shared/quote.ts`)

*Brief v1.1, Oct 24, 2026 (v1.1: Marcus's answers to the two questions are recorded as decided, and spec v0.2.18 now carries them). Written after task 4 merged (PR #28, merge `2a3ca55`). Paste this whole file into Claude Code or Codex, run from an up-to-date clone of `github.com/marcusschimizzi/nacre` (`main` at or after `2a3ca55`). Marcus reviews the PR. Spec: `docs/slice-1-spec.md` v0.2.18. **This task runs in parallel with task 5** (worker, `Extractor`, OpenAI adapter); the two briefs share one interface contract, §1 below, and touch different files.*

## Context
The write path's safety rule is that a claim only counts when its quote is **really in the source message**. The model proposes a quote; **code decides** whether it is there (spec §6.5: "code only; the model never decides this"). This task builds that check as a pure, dependency-free function: given the stored message body and the model's quote, return the exact span of the body it matches (code-point offsets, as Postgres `substring` counts them), how it matched (`exact` or `normalized`), how many times it occurs, and the **source text** to store, or the reason it failed. It is the evidence behind every belief, the thing the nightly self-audit re-checks (§13.1) and the A4 acceptance test (§14).

Task 5 builds the worker that calls it. Because the two tasks are built in parallel, they meet at a **narrow, fixed interface** (§1). Build exactly that. Don't touch the worker.

**Decided, already in the spec (don't reopen):**
- The algorithm and the failure reasons are §6.5 as written: length gate, ellipsis gate, NFC, exact match, then a normalized match, else fail. The reasons are exactly `quote_length`, `ellipsis` and `quote_not_found`.
- **Normalization is typography and whitespace only, never case, never words.** Curly quotes to straight, en and em dash to `-`, NBSP to a space, whitespace runs to one space, trimmed.
- **Offsets are Unicode code points** into the stored body (NFC, redacted), not UTF-16 units. The stored quote is **the body's own text** at those offsets, never the model's string.
- **Only the target event's body is searched.** The function gets one body; a quote that appears only in a context event fails because the caller passes only the target body.
- `value_in_quote` is a **soft signal**, never a gate.
- First hit wins; `occurrences` counts all of them.
- Match against the body **as stored**: the body already holds `[REDACTED:<kind>]` markers (§6.2). A quote may contain a marker (it is just text).

**This task adds no migration, no variable, no dependency, and does not edit anything under `src/worker/`, `src/api/`, `migrations/` or `.railway/`.** Verify with `git diff main --stat` (only the files in the layout below, plus the docs row). If you think you need a runtime dependency (for example `fast-check`), stop and say why in the PR; the answer is almost certainly no (§7).

**Read first:** `docs/slice-1-spec.md` §4 (`evidence_spans`, `claims.checks`), §5.3, §5.4, §6.2, §6.5, §13.1 (fidelity audit), §14 A4; `docs/tasks/task-04-event-ingest.md` §5 and §8 (the redactor's fixtures, properties and time guards are the model for this task's tests); `src/shared/events.ts` (`codePointLength`), `src/shared/redact.ts`; `test/redact.test.ts` (seeded property tests, time guards); `test/helpers/db.ts` and `test/a11.test.ts` (database tests as `nacre_app`).

## What to do

Layout (rename if you have a reason, and say so in the PR):
- `src/shared/quote.ts`: the verifier. Pure; imports nothing from `src/worker`, `src/api` or the database.
- `test/quote.test.ts`: cases, normalization, properties, adversarial and time-guard tests. No database.
- `test/helpers/prng.ts`: the seeded generator (§7). **Owned by this task**; task 5 doesn't create it.
- `test/quote-db.test.ts`: Postgres parity (§8). Skips without `TEST_DATABASE_URL`, like the other database tests.
- `docs/tasks/README.md`: row 06 (§10).

### 1. The interface contract with task 5 (build exactly this)
File `src/shared/quote.ts` exports these two functions and these types, with these exact names and signatures. Task 5 imports them (through one re-export file, `src/worker/quote.ts`) and must compile against them unchanged.

```ts
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

/** Spec §6.5. `body` is the stored NFC body of the TARGET event only. Pure and never throws. */
export function verifyQuote(body: string, quote: string): QuoteVerification;

/** Spec §6.5, `checks.value_in_quote`: a soft signal, never a gate. Pure and never throws. */
export function valueInQuote(storedQuote: string, value: string): boolean;
```

Rules of the contract:
- **Argument order is `(body, quote)`**, body first.
- **Never throws**, on any string input (empty, lone surrogates, 100,000 characters, NUL). A failure is a value. Task 5 relies on that.
- **Pure and synchronous**; no I/O, no clock, no randomness, no logging. It never sees or logs content itself.
- **Invariant, always true when `ok` is `true`:** `Array.from(body).slice(start, end).join('') === quote`, `end > start`, and `start`, `end` are integers in `[0, codePointLength(body)]`. This is exactly what Postgres `substring(body FROM start + 1 FOR end - start)` returns, and `evidence_spans` has `CHECK (span_end > span_start)`.
- `occurrences` counts matches in whichever stage matched (exact hits for `exact`, normalized hits for `normalized`), overlapping ones included, as the spec's `all_indices` does.
- Extra exports are fine (`wordCount`, `normalizeForMatch`, `codePointSubstring`), but nothing else in this contract may change. If you believe it must, say so at the top of the PR; don't just change it, because task 5 builds against it today.

### 2. The algorithm
Implement §6.5 in this order. Every step is deterministic.
1. **Length gate** on the quote **as given** (before NFC): `cpLength(quote) < 8`, or `wordCount(quote) < 2`, or `cpLength(quote) > 400` → `{ ok: false, reason: 'quote_length' }`.
   - `cpLength` counts code points (`codePointLength` from `src/shared/events.ts` is fine to reuse, or a local loop).
   - `wordCount` counts `Intl.Segmenter('en', { granularity: 'word' })` segments with `isWordLike`. That counts "你好 世界" as 2 and "don't" as 1, and splits "pnpm-lock" into 2. (Question 1.)
2. **Ellipsis gate**: the quote contains `…` (U+2026) or `...` → `{ ok: false, reason: 'ellipsis' }`. (Question 2.)
3. `q = quote.normalize('NFC')`. If `!q.isWellFormed()` → `quote_not_found` (a lone surrogate can't be in a stored body, and Postgres can't hold it).
4. **Exact**: find every index of `q` in `body` (overlapping hits too: after a hit at `i`, resume at `i + 1`). If any, the first hit wins: `matchKind: 'exact'`, `occurrences` = the number of hits.
5. **Normalized**: build `nb` and its map from `body`, and `nq` from `q` (§3). Find every hit of `nq` in `nb`. If any: `start = map[hit]`, `end = map[hit + nq.length - 1] + 1`, `matchKind: 'normalized'`, `occurrences` = the number of hits. An empty `nq` (a quote of only whitespace and quote marks can't pass the length gate, but check anyway) → `quote_not_found`.
6. Otherwise `quote_not_found`.
7. On a match, **`quote` is the body's text at `[start, end)`**, and the function asserts internally that the code-point slice equals it (a defensive check; if it ever failed, return `quote_not_found` rather than throw).

**Offsets.** JavaScript indexes are UTF-16 units; the contract is code points. The two differ only when the body holds characters above U+FFFF (emoji, some CJK). Do not rely on `indexOf` results as offsets. Convert once per call (a prefix array, or `Array.from(body)`), and make the identity case (no astral characters) cheap. The normalized map is indexed by **UTF-16 unit of `nb`** and holds the **code-point index in `body`** of the source character; both units of an astral character map to the same source index, so `end = map[lastUnit] + 1` is right for a quote that ends in an emoji.

### 3. Normalization rules (a closed table; anything not listed is unchanged)
Applied identically to the body and the quote. It maps a character to another **character**, or collapses whitespace; it never deletes a non-whitespace character and never changes case.

| Input (code points) | Becomes |
|---|---|
| `‘` U+2018, `’` U+2019, `‚` U+201A, `‛` U+201B, `′` U+2032 | `'` |
| `“` U+201C, `”` U+201D, `„` U+201E, `‟` U+201F, `″` U+2033 | `"` |
| `‐` U+2010, `‑` U+2011, `‒` U+2012, `–` U+2013, `—` U+2014, `―` U+2015, `−` U+2212 | `-` |
| every whitespace character (`/\s/u`, which includes NBSP U+00A0, U+2007, U+202F, U+3000, `\n`, `\r`, `\t`) | one space, and a run of them becomes **one** space |
| leading and trailing whitespace | removed (trim) |

- **Not folded** (they must stay different, and a test says so): case; `…` (rejected earlier); accents (NFC only; no NFD stripping); full-width or other punctuation not in the table; and the zero-width space U+200B, which `/\s/u` does not treat as whitespace. (U+FEFF *is* whitespace to `/\s/u`, so it folds to a space; follow `/\s/u` exactly.)
- The folded body can be shorter than the body (whitespace runs collapse), so the map matters: `map[i]` is the index in `body` of the first source character that produced `nb[i]`; for a collapsed run that is the run's first character.
- **A normalized match never starts or ends on whitespace** (both sides are trimmed and a hit starts and ends on a non-space), so the returned span never includes the whitespace around it. Test it.

### 4. `valueInQuote(storedQuote, value)`
Spec: `fuzzy_contains(stored_quote, claim.value)`, a soft signal. Define it as: fold both strings with the §3 table and `toLowerCase()`, replace every run of characters that are neither a letter nor a digit (`/[^\p{L}\p{N}]+/gu`) with one space, trim, and return whether the folded quote **contains** the folded value as a substring. An empty folded value returns `false`. Examples: `("my preferred package manager is pnpm", "pnpm")` true; `("Dana is my contact", "dana")` true; `("works at Acme Corp.", "Acme Corp")` true; `("it costs $3.50", "3.50")` true (`3 50` both sides); `("I live in Austin", "Boston")` false; `("three days", "3 days")` false (soft; no number words); `("pnpm", "")` false; `("…", "—")` false. Plain `includes` on the folded text is intended, so it also works for scripts without spaces.

### 5. What it must never do
- Return an offset that is not a code-point offset, or a `quote` that is not the body's text.
- Match across a case change, a spelling change, a dropped or added word, or a different order. A quote that differs from the body only in case (`My preferred…` vs `my preferred…`) fails.
- Search anywhere but the body it was given (it takes no other text).
- Take time that grows faster than linearly in `body.length` for any input (§7, time guards), including many overlapping hits.

## 6. Cases (`test/quote.test.ts`, table-driven)
Build bodies in the test file. Use these exact bodies and quotes; each row is one `it`.

**Length and ellipsis** (quote → reason): `'pnpm'` (4 chars) → `quote_length`; `'use pnpm'` (8 chars, 2 words) → passes the gate (then found or not); `'pnpmpnpm'` (8 chars, 1 word) → `quote_length`; `'a b'` → `quote_length`; 401 code points with spaces → `quote_length`; exactly 400 → passes the gate; `'my favorite…'` → `ellipsis`; `'use pnpm... always'` → `ellipsis`; `'𝒜𝒷 𝒸𝒹'` (two words, 5 code points but 9 UTF-16 units) → `quote_length`, which proves the gate counts code points; `'😀 😀 😀 😀 😀'` (9 code points, no word-like segment) → `quote_length`.

**Exact** (body `'For the record, my preferred package manager is pnpm. Can you update the README?'`): quote `'my preferred package manager is pnpm'` → `start 16, end 52, exact, occurrences 1`, `quote` identical (these are spec §5.4's numbers). A quote at offset 0; a quote ending at the last character; a quote that occurs twice (`occurrences: 2`, first hit's offsets); overlapping occurrences (body `'aa aa aa'`, quote `'aa aa'` → `occurrences: 2`, hits at 0 and 3); the whole body as the quote; NFC: a quote `'cafe\u0301 au lait'` against body `'un caf\u00e9 au lait'` → `exact` (the quote is NFC-normalized first) and `quote` is the body's `'caf\u00e9 au lait'`.

**Normalized**: body `'She said “use  pnpm” and I agree.'` (curly quotes, two spaces) with quote `'"use pnpm" and I agree'` → `normalized`, `quote` is `'“use  pnpm” and I agree'` (the source text, curly quotes and two spaces), offsets 9 to 32 in code points, and `Array.from(body).slice(start, end).join('') === quote`. Also: en dash body vs hyphen quote; em dash; NBSP in the body vs a space in the quote; a newline and indentation in the body vs a single space in the quote; a tab; a curly apostrophe (`don’t` vs `don't`); a quote with trailing space; a body with `‘single’` quotes; **the reverse direction** (curly quote in the model's string, straight in the body) also verifies as `normalized`; a normalized hit followed by an exact one later in the body: the exact stage wins when any exact hit exists (`exact`, with its own offsets).

**Astral characters**: body `'😀 I prefer pnpm 😀 and bun'`, quote `'I prefer pnpm 😀 and bun'` → offsets `start 2`, `end` equal to the code-point length of the body (UTF-16 would say 3 and 26). A normalized match **after** an emoji and one that **ends on** an emoji; a body of 50,000 emoji plus a sentence, found at the right code-point offset. Check each against `Array.from`.

**Must fail, `quote_not_found`**: different case (`'My Preferred package manager is pnpm'`); a dropped word; an added word; swapped word order; a typo (`'prefered'`); the quote found only in another string that is **not** passed (the test passes only the target body; this is the A4 "context only" case at unit level); a quote with a lone surrogate; a quote that differs by a zero-width space in the middle (`/\s/u` doesn't match U+200B: assert it fails); a fold that would need case (`'İstanbul'` vs `'istanbul'`); accents (`'cafe au lait'` vs `'café au lait'`); a quote made only of characters the folding removes can't pass the length gate, so test `'" " " " " "'` (11 characters, no word-like segments) → `quote_length`.

**Never throws**: `''` body, `''` quote, NUL characters, lone surrogates in either argument, a 100,000-character body, a 400-character quote of one repeated character with a space in it.

**`valueInQuote`**: every example in §4, plus a curly-quote value against a straight-quote quote and mixed case.

## 7. Properties and adversarial tests
**Property tests without a new dependency.** The repo has no `fast-check`, and `test/redact.test.ts` already uses a hand-rolled seeded generator. Put the shared generator in `test/helpers/prng.ts`: a `mulberry32`-style `prng(seed)` returning `{ next(): number, int(max): number, pick<T>(xs: readonly T[]): T, chance(p: number): boolean }`. Use fixed seeds and **2,000 cases per property**; on failure the message must print the seed, the case index, the body and the quote (bodies are at most about 120 code points, so a failure is readable without a shrinker). Don't use `Math.random` or the clock. Leave `test/redact.test.ts` alone unless you reuse the helper there (optional; if you do, keep that change in its own commit).

**Generator.** A body is 3 to 14 words (letters `a–zA–Z`, with `é` and `日` sometimes), each gap holding **at least one whitespace character** from `[' ', '\n', '\t', '\u00a0', '  ']`, and optionally around it punctuation, typography (`'’‘"“”-–—`), a period, a comma or an emoji. This keeps `Intl.Segmenter` word counts honest (an apostrophe or hyphen alone between letters can fuse words). A span is `k >= 2` consecutive words with the gaps between them, from a word start to a word end, of 8 to 400 code points (draw again otherwise).

**Properties** (each for all generated cases):
1. **Self-match:** `verifyQuote(body, span)` is `ok`; `quote === span`; `matchKind === 'exact'`; `Array.from(body).slice(start, end).join('') === quote`; `occurrences >= 1`; `start` is no later than the span's true code-point offset (equal when `occurrences` is 1).
2. **Jitter:** replace each typography character in the span by a random member of its class (§3 table) and each whitespace run by a random run of 1 to 3 whitespace characters. The result still verifies, `quote` equals the **original** span (the body's text, not the jittered one), and `matchKind` is `'normalized'` unless the jittered string happens to be an exact substring of the body, in which case it is `'exact'`.
3. **Case mutation:** upper-casing one letter of the span (if that changes the string and the result isn't a substring of the body or of the folded body) gives `quote_not_found`.
4. **Word mutation:** deleting one word of the span, or replacing a letter with a different letter, gives `quote_not_found` unless the result is still a (folded) substring of the body; the test checks that with the oracle below, so the property never claims more than it knows.
5. **Offsets are code points:** prepend a random number (0 to 20) of `'😀'` to the body; `start` and `end` move by exactly that number, and `quote` is unchanged.
6. **Oracle agreement:** a plain, slow reference (`Array.from`, a hand-written fold with the §3 table written as a regex chain `replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")`…, `includes`) written **in the test file, independently of `quote.ts`**, gives the same `ok`, `matchKind`, `start`, `end` and `occurrences`. Compare only cases past the length and ellipsis gates (the oracle uses `split(/\s+/)` for words, which agrees with the segmenter on the generator's output).
7. **Never throws, always sane:** for arbitrary strings built from the full alphabet in both arguments (including lone surrogates and NUL), `verifyQuote` returns a value, and when `ok` the invariant of §1 holds.

**Adversarial and time guards** (`performance.now()`, each under **250 ms** on CI; the real numbers should be a few ms; the bound is generous so a loaded runner doesn't flake):
- body `'a'.repeat(100_000)`, quote `'b ' + 'a'.repeat(398)` (a near miss at the first character), and quote `'a'.repeat(398) + ' b'` (a near miss at the last);
- body `'a '.repeat(50_000)`, quote `'a '.repeat(199) + 'a'` (about 50,000 overlapping hits; `occurrences` is right and it's fast);
- body `' '.repeat(100_000) + 'x' + ' '.repeat(100_000)`, quote `'x yyyyyyy'` (whitespace-heavy normalization, not found); and body `' '.repeat(100_000) + 'xx' + ' '.repeat(100_000) + 'yyyyyy' + ' '.repeat(100_000)`, quote `'xx yyyyyy'` (a `normalized` match; check the offsets, 100,000 to 200,008);
- body `'“a '.repeat(33_333)`, quote `'"a "a "a "a'` (a `normalized` match with about 33,000 hits; `occurrences` right) and quote `'"a "a "a "b'` (not found);
- body `'😀'.repeat(50_000) + ' ab cd ' + '😀'.repeat(50_000)`, quote `'ab cd 😀😀'` (found at code-point offset 50,001, checked against `Array.from`), and `'ab cd 😀😀x'` (not found);
- body `'ab'.repeat(50_000)` (no spaces), quote `'ab'.repeat(100) + ' ' + 'ab'.repeat(99)` (399 characters; not found, and fast);
- a **ReDoS guard**: the module contains **no** regular expression with a nested or overlapping quantifier applied to input (`(a+)+`, `(\s*\w*)*`, `\s+$` on untrusted text). A test reads `src/shared/quote.ts` and asserts it contains no `new RegExp(` built from input and no `+)+`, `*)*`, `+)*` or `*)+`, and the whitespace collapse is a single pass over the code points, not `replace(/\s+$/)`-style backtracking. Fixed-pattern regexes on single characters (`/\s/u`, `/[^\p{L}\p{N}]+/gu`) are fine.

## 8. Database parity (`test/quote-db.test.ts`)
Against the scratch database as `nacre_app`, using `startTestApp`, `testAgent`, `staticToken` and `postEvent` from `test/helpers` (so files sharing the database don't collide): for a table of 20 bodies and quotes (the §6 exact, normalized and astral rows), post each body as an event (so it is stored exactly as ingest stores it), read `event_content.body` back, run `verifyQuote` on the stored body, and assert `SELECT substring(body FROM ${start} + 1 FOR ${end} - ${start}) FROM event_content WHERE event_id = …` equals `quote` exactly. This proves the offsets are the ones Postgres uses (A5 and the §13.1 fidelity audit depend on it). **Do not insert `evidence_spans` here**; the pipeline writes those (task 5).

## 9. Wiring, and the A4 pipeline test (whoever merges second does this)
Task 5 imports this module through **one file**, `src/worker/quote.ts`. While `src/shared/quote.ts` isn't on `main`, task 5's PR carries a temporary exact-only `src/worker/quote-stub.ts`.
- **If task 5 is already on `main` when you finish:** rebase, then switch `src/worker/quote.ts` to re-export from `../shared/quote.js` (its comment says how), **delete `src/worker/quote-stub.ts`**, run the whole suite, and add **`test/a4.test.ts`**: the A4 pipeline test in the box below. Tell the reader in the PR that you wired it.
- **If you merge first:** do none of that; task 5 will, and its brief says so. Leave `src/worker/` alone and note in the PR that wiring is task 5's.

*`test/a4.test.ts` (spec §14 A4, the same text is in task 5's brief).* Against the scratch database as `nacre_app`, with the real worker pipeline (`processExtractJob`, task 5) and a **fake `Extractor`** (no network). Seed one agent and three user events in one session through `ingestEvent`: **C** (context) `'My sister Dana works at Acme Corp as a data engineer.'`, **T1** (target) `'For the record, my preferred package manager is pnpm. Can you update the README?'`, **T2** `'She said “use  pnpm” and I agree with her completely.'`. The fake returns, for T1: claim 1 with quote `'my preferred package manager is pnpm'`; claim 2 with quote `'works at Acme Corp as a data engineer'` (only in C); claim 3 with quote `'my favourite package manager is pnpm'` (not anywhere). For T2: claim 4 with quote `'"use pnpm" and I agree'`. Assert:
- claim 1: one `evidence_spans` row, `match_kind 'exact'`, offsets 16 and 52, and `quote` equals `substring(body FROM 17 FOR 36)`; its `checks` is `{"quote":"exact","value_in_quote":true}`; status `candidate` (promotion is task 8's);
- claims 2 and 3: `status 'held'`, `status_reason 'quote_not_found'`, **no** `evidence_spans` row, and one `extraction_error` activity entry for each (with the claim id and the reason, no quote text);
- claim 4: `match_kind 'normalized'`, the stored `quote` is `'“use  pnpm” and I agree'` and equals the SQL substring at the stored offsets;
- the `beliefs` table has no row; no `claim_promoted` entry exists; every claim's `evidence_spans.quote` that exists equals the SQL substring.

## 10. Docs
A `docs:` commit, separate from the code: `docs/tasks/README.md` row 06 becomes **"In progress (PR #NN)"** (add this brief file to `docs/tasks/` if it isn't there yet). **Don't** touch the root `README.md`: task 5 owns its Status paragraph, and two PRs editing it conflict. Leave `docs/slice-1-spec.md` alone; in the PR add a **"Spec updates to apply"** list only for rules the build set that v0.2.17 doesn't say. Expected candidates: the folding table (§3), `valueInQuote`'s definition (§4), the `Intl.Segmenter` word count, `occurrences` counting overlapping hits, and `quote_not_found` for a malformed quote.

## Out of scope
- The worker, the `Extractor`, prompts, the OpenAI adapter, the cost guard, claim writing (task 5); promotion, the future-tense guard and time grounding (tasks 7 and 8); the nightly self-audit query (task 14).
- A new dependency (`fast-check`, `fastest-levenshtein`, a normalization library), a migration, a variable, Railway.
- Fuzzy or edit-distance matching, case folding, accent stripping, or searching context events. §6.5 says "never case, never words"; a quote that needs more fails and the claim is held.
- Editing `docs/slice-1-spec.md` and `src/worker/` (except the wiring in §9 when task 5 has already merged).

## Done when (list each check and its result in the PR description)
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test` (with `TEST_DATABASE_URL`) and `pnpm build` pass locally and in CI; paste the test count.
- [ ] **Contract:** `src/shared/quote.ts` exports exactly `verifyQuote(body, quote)`, `valueInQuote(storedQuote, value)` and the types in §1; a test imports them and asserts the shapes, including that no input makes `verifyQuote` throw.
- [ ] **No new dependency or schema change:** `git diff main --stat -- package.json pnpm-lock.yaml migrations .railway src/worker src/api` is empty (apart from §9's wiring, if you did it).
- [ ] **Cases:** every row of §6 passes, including the spec §5.4 numbers (16 and 52) and the astral and NFC rows.
- [ ] **Properties:** the seven properties pass, 2,000 cases each, with fixed seeds; the failure message prints seed, body and quote.
- [ ] **Time guards:** each adversarial case in §7 runs under 250 ms; paste the measured numbers. The ReDoS source check passes.
- [ ] **Postgres parity:** for every row of §8, Postgres `substring` at the returned offsets equals `quote`.
- [ ] **Normalization is closed:** a test lists each §3 table row and asserts one example each, and asserts that case, accents and zero-width spaces are not folded.
- [ ] **Wiring / A4:** if task 5 is on `main`, `src/worker/quote.ts` re-exports this module, the stub is gone and `test/a4.test.ts` passes; otherwise the PR says task 5 does it.
- [ ] **Live check:** none needed (pure code). The PR says so.
- [ ] PR from `task-06-quote-verifier` to `main`, titled **"Task 6: Quote verifier"**, with deviations, **Spec updates to apply**, and open questions per `docs/tasks/README.md`. Don't merge.

## Decided by Marcus (Oct 24, 2026)
1. **How are "words" counted for the 2-word minimum?** The spec says `word_count(quote) < 2` but not how. *Decided (built): `Intl.Segmenter` word-like segments*, which handles "你好 世界" and splits "pnpm-lock". The alternative is `split(/\s+/)`, simpler but it treats an unspaced Chinese or Japanese sentence as one word and rejects every quote from it.
2. **A source message that really contains `...` or `…`.** The spec rejects any quote with an ellipsis, because the model is told not to use them and an ellipsis usually means a stitched, non-contiguous quote. A message like "wait... I prefer bun" can then never be quoted across the dots; the claim is held as `ellipsis`. *Decided (built): keep the spec's rule*, since a held claim is visible and a stitched quote is the worse failure. The alternative is to allow an ellipsis when the exact string occurs in the body.

## Conventions
Conventional Commits, small and readable. The docs change is its own commit. One task per PR. No secrets in the repo, ever, and no secret-shaped literals in tests. No content in logs (this module logs nothing). Don't merge.
