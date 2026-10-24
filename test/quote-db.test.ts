import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { verifyQuote } from '../src/shared/quote.js';
import { startTestApp, staticToken, type TestApp, testAgent } from './helpers/app.js';
import { postEvent, validEvent } from './helpers/events.js';

const appDatabaseUrl = inject('appDatabaseUrl');

const RECORD = 'For the record, my preferred package manager is pnpm. Can you update the README?';

/** [name, content as posted, quote, expected match]: the §6 exact, normalized and astral rows. */
const ROWS: [string, string, string, 'exact' | 'normalized'][] = [
  ["spec §5.4's example (16 to 52)", RECORD, 'my preferred package manager is pnpm', 'exact'],
  ['a quote at offset 0', RECORD, 'For the record', 'exact'],
  ['a quote ending at the last character', RECORD, 'update the README?', 'exact'],
  ['the whole body', RECORD, RECORD, 'exact'],
  ['two occurrences', 'I use pnpm daily. Really, I use pnpm daily.', 'I use pnpm daily', 'exact'],
  ['overlapping occurrences', 'abcd abcd abcd', 'abcd abcd', 'exact'],
  ['NFC: a decomposed quote', 'un café au lait', 'café au lait', 'exact'],
  [
    'curly quotes and two spaces',
    'She said “use  pnpm” and I agree.',
    '"use pnpm" and I agree',
    'normalized',
  ],
  ['an en dash', 'Ship it in Q3 – or Q4 at worst.', 'Q3 - or Q4 at worst', 'normalized'],
  ['an em dash', 'It works—mostly—on Linux.', 'works-mostly-on Linux', 'normalized'],
  ['an NBSP', 'I use pnpm daily.', 'use pnpm daily', 'normalized'],
  [
    'a newline and indentation',
    'Rules:\n    always run\n    the tests first',
    'always run the tests',
    'normalized',
  ],
  ['a tab', 'name:\tDana Smith here', 'name: Dana Smith', 'normalized'],
  ['a curly apostrophe', 'I don’t use npm anymore.', "don't use npm", 'normalized'],
  ['curly single quotes', 'call it ‘the lab’ please', "'the lab' please", 'normalized'],
  [
    'curly in the quote, straight in the body',
    'She said "use pnpm" twice.',
    '“use pnpm” twice',
    'normalized',
  ],
  ['a trailing space in the quote', 'I use  pnpm   daily.', ' use pnpm daily ', 'normalized'],
  [
    'exact wins after a normalized hit',
    'He said “use pnpm now” and later "use pnpm now" again.',
    '"use pnpm now"',
    'exact',
  ],
  ['after an emoji', '😀 I prefer pnpm 😀 and bun', 'I prefer pnpm 😀 and bun', 'exact'],
  [
    'normalized, after emoji',
    '😀😀 she said “use  bun” today',
    'said "use bun" today',
    'normalized',
  ],
  [
    'normalized, ending on an emoji',
    'ok:  “pnpm” wins 😀 for sure',
    '"pnpm" wins 😀',
    'normalized',
  ],
  [
    '50,000 emoji before the quote',
    `${'😀'.repeat(50_000)} my preferred package manager is pnpm.`,
    'preferred  package\nmanager',
    'normalized',
  ],
  [
    'a redaction marker in the quote',
    `my db password=${'hunter2'.repeat(2)} is in the vault`,
    'password=[REDACTED:password] is in the vault',
    'exact',
  ],
];

describe.skipIf(!appDatabaseUrl)('quote offsets are the offsets Postgres uses (§8)', () => {
  let app: TestApp;
  const agent = testAgent('quote');
  let token: string;

  beforeAll(async () => {
    app = await startTestApp(appDatabaseUrl);
    ({ token } = await staticToken(app, agent));
  });
  afterAll(() => app?.close());

  for (const [name, content, quote, matchKind] of ROWS) {
    it(name, async () => {
      // Stored exactly as ingest stores it: NFC, then redacted.
      const res = await postEvent(app, token, validEvent({ content }));
      expect(res.status).toBe(201);
      const { event_id } = (await res.json()) as { event_id: string };
      const [stored] = await app.sql<{ body: string }[]>`
        SELECT body FROM event_content WHERE event_id = ${event_id}`;
      const body = stored?.body ?? '';

      const result = verifyQuote(body, quote);
      expect(result).toMatchObject({ ok: true, matchKind });
      if (!result.ok) return;
      const [sql] = await app.sql<{ quote: string; length: number }[]>`
        SELECT substring(body FROM ${result.start}::int + 1 FOR ${result.end}::int - ${result.start}::int)
                 AS quote,
               char_length(body) AS length
        FROM event_content WHERE event_id = ${event_id}`;
      expect(sql?.quote).toBe(result.quote);
      expect(sql?.length).toBe(Array.from(body).length);
    });
  }
});
