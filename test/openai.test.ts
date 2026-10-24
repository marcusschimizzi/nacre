import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type ExtractInput, ExtractorError } from '../src/worker/extractor.js';
import { normalizeAttribute, OPENAI_RESPONSES_URL, OpenAiExtractor } from '../src/worker/openai.js';
import { OUTPUT_SCHEMA, SYSTEM_PROMPT } from '../src/worker/prompts/extract-claims.v1.js';
import { randomToken } from './helpers/events.js';

// Built at runtime: no key-shaped literal in the repo.
const FAKE_KEY = `sk-${'proj-'}${randomToken('alnum', 48, 'openai-test-key')}`;

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/openai/${name}`, import.meta.url), 'utf8');

const INPUT: ExtractInput = {
  observedAt: new Date('2026-10-21T19:05:09Z'),
  observedTz: 'America/Chicago',
  context: [],
  target: {
    kind: 'message',
    role: 'user',
    text: 'For the record, my preferred package manager is pnpm. Can you update the README?',
  },
};

interface Captured {
  url: string;
  init: RequestInit;
}

function extractorFor(status: number, body: string, captured: Captured[] = []) {
  const fetchImpl: typeof fetch = async (url, init) => {
    captured.push({ url: String(url), init: init ?? {} });
    return new Response(body, { status, headers: { 'content-type': 'application/json' } });
  };
  return new OpenAiExtractor({ apiKey: FAKE_KEY, model: 'gpt-6-luna', fetchImpl });
}

async function failure(promise: Promise<unknown>): Promise<ExtractorError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ExtractorError) return err;
    throw err;
  }
  throw new Error('expected an ExtractorError');
}

const signal = () => new AbortController().signal;

/** Nothing secret or provider-written in an error, except the raw model output it carries for the run. */
function expectClean(err: ExtractorError): void {
  expect(err.message).toBe(err.code);
  const { rawOutput: _raw, ...extra } = err.extra;
  const visible = JSON.stringify({ message: err.message, name: err.name, extra, stack: err.stack });
  expect(visible).not.toContain(FAKE_KEY);
  expect(visible).not.toContain('FIXTURE-');
  expect(JSON.stringify(err.extra)).not.toContain(FAKE_KEY);
}

describe('OpenAiExtractor', () => {
  it('sends the Responses request: strict schema, low effort, store false, no temperature', async () => {
    const captured: Captured[] = [];
    await extractorFor(200, fixture('ok-no-claims.json'), captured).extract(INPUT, {
      signal: signal(),
    });
    expect(captured).toHaveLength(1);
    const [req] = captured;
    expect(req?.url).toBe(OPENAI_RESPONSES_URL);
    expect(req?.init.method).toBe('POST');
    const headers = new Headers(req?.init.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${FAKE_KEY}`);
    expect(headers.get('content-type')).toBe('application/json');
    const body = JSON.parse(String(req?.init.body));
    expect(body).toEqual({
      model: 'gpt-6-luna',
      input: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: expect.stringContaining(INPUT.target.text) },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'extract_claims',
          strict: true,
          schema: JSON.parse(JSON.stringify(OUTPUT_SCHEMA)),
        },
      },
      reasoning: { effort: 'low' },
      store: false,
      max_output_tokens: 8000,
    });
    expect(body).not.toHaveProperty('temperature');
  });

  it('identifies itself, and keeps the key out of its settings', () => {
    const x = extractorFor(200, '{}');
    expect([x.id, x.provider, x.model, x.promptId]).toEqual([
      'fastpass-v1',
      'openai',
      'gpt-6-luna',
      'extract-claims',
    ]);
    expect(x.settings).toEqual({
      model: 'gpt-6-luna',
      reasoning_effort: 'low',
      response_format: 'json_schema_strict',
    });
    expect(JSON.stringify(x)).not.toContain(FAKE_KEY);
  });

  it('parses two claims, normalizes the attribute, and turns an empty time_phrase into null', async () => {
    const result = await extractorFor(200, fixture('ok-two-claims.json')).extract(INPUT, {
      signal: signal(),
    });
    expect(result.modelVersion).toBe('gpt-6-luna');
    expect(result.usage).toEqual({ inputTokens: 2500, cachedTokens: 0, outputTokens: 300 });
    expect(result.claims).toHaveLength(2);
    expect(result.claims[0]).toMatchObject({
      attribute: 'preferred_package_manager',
      quote: 'my preferred package manager is pnpm',
      time_phrase: null,
      confidence: 0.93,
    });
    expect(result.claims[1]).toMatchObject({ attribute: 'pending_request', time_phrase: null });
    expect(result.rawOutput).toHaveProperty('claims');
  });

  it('parses an empty claims list', async () => {
    const result = await extractorFor(200, fixture('ok-no-claims.json')).extract(INPUT, {
      signal: signal(),
    });
    expect(result.claims).toEqual([]);
    expect(result.rawOutput).toEqual({ claims: [] });
  });

  it('reads cached tokens', async () => {
    const result = await extractorFor(200, fixture('cached-tokens.json')).extract(INPUT, {
      signal: signal(),
    });
    expect(result.usage).toEqual({ inputTokens: 2500, cachedTokens: 1200, outputTokens: 300 });
  });

  it.each([
    ['refusal.json', 'refusal', false, true],
    ['incomplete.json', 'incomplete', true, true],
    ['api-error.json', 'api_error', true, true],
    ['malformed-json.json', 'schema_violation', true, true],
    ['schema-confidence.json', 'schema_violation', true, true],
    ['schema-empty-quote.json', 'schema_violation', true, true],
    ['schema-empty-attribute.json', 'schema_violation', true, true],
  ] as const)(
    '%s → %s (retryable %s, usage attached %s)',
    async (name, code, retryable, billed) => {
      const err = await failure(
        extractorFor(200, fixture(name)).extract(INPUT, { signal: signal() }),
      );
      expect(err.code).toBe(code);
      expect(err.retryable).toBe(retryable);
      expect(err.extra.usage !== undefined).toBe(billed);
      expectClean(err);
    },
  );

  it('keeps the raw output for the run: the text when it is not JSON, else the parsed value', async () => {
    const malformed = await failure(
      extractorFor(200, fixture('malformed-json.json')).extract(INPUT, { signal: signal() }),
    );
    expect(typeof malformed.extra.rawOutput).toBe('string');
    const schema = await failure(
      extractorFor(200, fixture('schema-confidence.json')).extract(INPUT, { signal: signal() }),
    );
    expect(schema.extra.rawOutput).toMatchObject({ claims: [{ confidence: 1.5 }] });
  });

  it.each([
    [400, 'http_4xx', false],
    [401, 'auth', false],
    [403, 'auth', false],
    [404, 'http_4xx', false],
    [408, 'http_retryable', true],
    [409, 'http_retryable', true],
    [429, 'rate_limited', true],
    [500, 'http_5xx', true],
    [503, 'http_5xx', true],
  ] as const)('HTTP %i → %s (retryable %s)', async (status, code, retryable) => {
    const err = await failure(
      extractorFor(status, fixture('http-error.json')).extract(INPUT, { signal: signal() }),
    );
    expect(err.code).toBe(code);
    expect(err.retryable).toBe(retryable);
    expect(err.extra.status).toBe(status);
    // A short plain provider code may be kept for a log field; the message text never is.
    expect(err.extra.providerCode).toBe('invalid_value');
    expectClean(err);
  });

  it('drops a provider code that is not a short plain code', async () => {
    const body = JSON.stringify({ error: { code: 'Bad Code With Spaces', type: null } });
    const err = await failure(extractorFor(500, body).extract(INPUT, { signal: signal() }));
    expect(err.extra.providerCode).toBeUndefined();
  });

  it('a failed fetch is network; the caller aborting is aborted; the timeout is timeout', async () => {
    const throwing = new OpenAiExtractor({
      apiKey: FAKE_KEY,
      model: 'gpt-6-luna',
      fetchImpl: async () => {
        throw new TypeError(`fetch failed for ${FAKE_KEY}`);
      },
    });
    const network = await failure(throwing.extract(INPUT, { signal: signal() }));
    expect([network.code, network.retryable]).toEqual(['network', true]);
    expectClean(network);

    const hanging = (timeoutMs: number) =>
      new OpenAiExtractor({
        apiKey: FAKE_KEY,
        model: 'gpt-6-luna',
        timeoutMs,
        fetchImpl: (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          }),
      });
    const controller = new AbortController();
    const pending = hanging(60_000).extract(INPUT, { signal: controller.signal });
    controller.abort();
    const aborted = await failure(pending);
    expect([aborted.code, aborted.retryable]).toEqual(['aborted', false]);

    const timeout = await failure(hanging(20).extract(INPUT, { signal: signal() }));
    expect([timeout.code, timeout.retryable]).toEqual(['timeout', true]);
  });

  it.each([
    ['preferred_package_manager', 'preferred_package_manager'],
    ['Preferred Package Manager', 'preferred_package_manager'],
    ['  contact-for: data contract!! ', 'contact_for_data_contract'],
    ['__employer__', 'employer'],
    ['日本 city', 'city'],
    ['!!!', ''],
  ])('normalizes attribute %j to %j', (input, expected) => {
    expect(normalizeAttribute(input)).toBe(expected);
  });
});
