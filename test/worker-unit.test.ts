import { describe, expect, it } from 'vitest';
import { loadWorkerConfig } from '../src/shared/config.js';
import { costUsd } from '../src/shared/pricing.js';
import { ExtractorError } from '../src/worker/extractor.js';
import { backoffMs, MAX_ATTEMPTS, STALE_LOCK_MS } from '../src/worker/jobs.js';
import { configHash, internalCode } from '../src/worker/process.js';
import {
  errorCode,
  newestMigration,
  retryDelayMs,
  waitForSchema,
} from '../src/worker/schema-wait.js';
import { skipReason } from '../src/worker/skip.js';
import { runSmoke, SMOKE_MESSAGE } from '../src/worker/smoke.js';
import { fakeSecrets, randomToken } from './helpers/events.js';
import { captureLog, FakeExtractor, rawClaim } from './helpers/worker.js';

describe('skip rules (spec §6.1)', () => {
  const ev = (kind: string, role: string | null, sensitivity = 'normal') => ({
    kind,
    role,
    sensitivity,
  });
  const text = 'I prefer pnpm.';

  it.each([
    ['user message', ev('message', 'user'), text, null],
    ['assistant message', ev('message', 'assistant'), text, 'role:assistant'],
    ['assistant remember (an agent made the call)', ev('remember', 'assistant'), text, null],
    ['user remember', ev('remember', 'user'), text, null],
    ['private', ev('message', 'user', 'private'), text, 'sensitivity:private'],
    ['restricted', ev('message', 'user', 'restricted'), text, 'sensitivity:restricted'],
    [
      'assistant and private: the sensitivity wins',
      ev('message', 'assistant', 'private'),
      text,
      'sensitivity:private',
    ],
    ['tool_result kind', ev('tool_result', 'tool'), text, 'kind:tool_result'],
    ['import kind', ev('import', null), text, 'kind:import'],
    ['only a marker and whitespace', ev('message', 'user'), ' [REDACTED:api_key] \n', 'empty'],
    [
      'markers and punctuation only',
      ev('message', 'user'),
      '[REDACTED:jwt], [REDACTED:password]!',
      'empty',
    ],
    ['real text plus a marker', ev('message', 'user'), 'key [REDACTED:api_key]', null],
    ['a digit counts', ev('message', 'user'), '42', null],
    ['CJK counts', ev('message', 'user'), '你好', null],
  ])('%s', (_name, event, body, expected) => {
    expect(skipReason(event, body)).toBe(expected);
  });
});

describe('job backoff and limits (spec §12.2)', () => {
  it('30 s × 4^(n−1), capped at 1 hour; 5 attempts; 10-minute stale lock', () => {
    expect([1, 2, 3, 4, 5, 6, 10].map(backoffMs)).toEqual([
      30_000, 120_000, 480_000, 1_920_000, 3_600_000, 3_600_000, 3_600_000,
    ]);
    expect(MAX_ATTEMPTS).toBe(5);
    expect(STALE_LOCK_MS).toBe(600_000);
    // The four waits before the fifth attempt: about 42 minutes in all.
    expect([1, 2, 3, 4].map(backoffMs).reduce((a, b) => a + b) / 60_000).toBe(42.5);
  });

  it('the schema-wait and loop backoff: 1 s doubling, capped at 30 s', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(retryDelayMs)).toEqual([
      1000, 2000, 4000, 8000, 16_000, 30_000, 30_000,
    ]);
  });

  it('error codes never carry a message', () => {
    expect(
      internalCode(Object.assign(new Error('Failing row contains secret'), { code: '23514' })),
    ).toBe('internal:23514');
    expect(internalCode(new TypeError('boom secret'))).toBe('internal:TypeError');
    expect(internalCode('a string')).toBe('internal:string');
    expect(errorCode(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe('ECONNREFUSED');
    expect(errorCode(new RangeError('secret'))).toBe('RangeError');
  });
});

describe('pricing (spec §12.3)', () => {
  it('2,500 input / 300 output on gpt-6-luna is $0.000400', () => {
    expect(costUsd('gpt-6-luna', { inputTokens: 2500, cachedTokens: 0, outputTokens: 300 })).toBe(
      0.0004,
    );
  });

  it('with 1,200 of the 2,500 input tokens cached it is $0.000292', () => {
    expect(
      costUsd('gpt-6-luna', { inputTokens: 2500, cachedTokens: 1200, outputTokens: 300 }),
    ).toBe(0.000292);
  });

  it('prices the fallback, and an unknown model throws', () => {
    expect(costUsd('gpt-5.6-luna', { inputTokens: 2500, cachedTokens: 0, outputTokens: 300 })).toBe(
      0.00086,
    );
    expect(() => costUsd('gpt-9', { inputTokens: 1, cachedTokens: 0, outputTokens: 1 })).toThrow();
  });

  it('config_hash is 64 hex and changes with the settings', () => {
    const a = configHash(new FakeExtractor());
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    const b = new FakeExtractor();
    Object.assign(b, { settings: { ...b.settings, model: 'gpt-5.6-luna' } });
    expect(configHash(b)).not.toBe(a);
  });
});

describe('worker config', () => {
  const DB = 'postgres://nacre_app@localhost:5432/nacre';

  it('DATABASE_URL is required', () => {
    expect(() => loadWorkerConfig({})).toThrow(/DATABASE_URL/);
  });

  it('defaults: no key, gpt-6-luna, $0.50, 1 s polls', () => {
    expect(loadWorkerConfig({ DATABASE_URL: DB })).toEqual({
      DATABASE_URL: DB,
      LLM_MODEL: 'gpt-6-luna',
      DAILY_LLM_BUDGET_USD: 0.5,
      WORKER_POLL_MS: 1000,
      LOG_LEVEL: 'info',
    });
  });

  it('an empty string counts as unset', () => {
    const config = loadWorkerConfig({
      DATABASE_URL: DB,
      OPENAI_API_KEY: '',
      LLM_MODEL: '',
      DAILY_LLM_BUDGET_USD: '',
    });
    expect(config.OPENAI_API_KEY).toBeUndefined();
    expect(config.LLM_MODEL).toBe('gpt-6-luna');
    expect(config.DAILY_LLM_BUDGET_USD).toBe(0.5);
  });

  it('accepts the fallback model and parses the budget', () => {
    const config = loadWorkerConfig({
      DATABASE_URL: DB,
      LLM_MODEL: 'gpt-5.6-luna',
      DAILY_LLM_BUDGET_USD: '1.25',
    });
    expect([config.LLM_MODEL, config.DAILY_LLM_BUDGET_USD]).toEqual(['gpt-5.6-luna', 1.25]);
    expect(() => loadWorkerConfig({ DATABASE_URL: DB, DAILY_LLM_BUDGET_USD: '-1' })).toThrow(
      /DAILY_LLM_BUDGET_USD/,
    );
  });

  it('an unsupported model fails naming the variable and the supported models', () => {
    expect(() => loadWorkerConfig({ DATABASE_URL: DB, LLM_MODEL: 'gpt-9' })).toThrow(
      /LLM_MODEL: must be one of: gpt-6-luna, gpt-5\.6-luna/,
    );
  });

  it('never echoes the key, even in an error about another variable', () => {
    const key = fakeSecrets().skKey;
    let message = '';
    try {
      loadWorkerConfig({ DATABASE_URL: 'mysql://x', OPENAI_API_KEY: key });
    } catch (err) {
      message = String(err);
    }
    expect(message).toContain('DATABASE_URL');
    expect(message).not.toContain(key);
  });
});

describe('waitForSchema', () => {
  const NEWEST = '20261024120000';
  const pgError = (code: string) => Object.assign(new Error(`relation secret ${code}`), { code });

  function run(
    versions: Array<string | null | Error>,
    options: { abortAfter?: number; clock?: () => number } = {},
  ) {
    const captured = captureLog();
    const controller = new AbortController();
    const sleeps: number[] = [];
    let i = 0;
    const result = waitForSchema({
      newest: NEWEST,
      signal: controller.signal,
      log: captured.log,
      clock: options.clock,
      readVersion: async () => {
        const v = versions[Math.min(i++, versions.length - 1)];
        if (v instanceof Error) throw v;
        return v ?? null;
      },
      sleep: async (ms) => {
        sleeps.push(ms);
        if (options.abortAfter !== undefined && sleeps.length >= options.abortAfter) {
          controller.abort();
        }
      },
    });
    return { result, sleeps, captured, reads: () => i };
  }

  it('is ready at once when the database is current', async () => {
    const r = run([NEWEST]);
    expect(await r.result).toBe(true);
    expect(r.sleeps).toEqual([]);
  });

  it('is ready when the database is ahead of the worker', async () => {
    expect(await run(['20991231000000']).result).toBe(true);
  });

  it('waits through a smaller version, then succeeds', async () => {
    const r = run(['20261023000100', '20261023000100', NEWEST]);
    expect(await r.result).toBe(true);
    expect(r.sleeps).toEqual([1000, 2000]);
    const warns = r.captured.records().filter((l) => l.msg === 'waiting for schema');
    expect(warns[0]).toMatchObject({ level: 40, attempt: 1, have: '20261023000100', want: NEWEST });
  });

  it.each([
    ['42501 (no grant yet)', pgError('42501')],
    ['42P01 (no schema_migrations yet)', pgError('42P01')],
    ['a refused connection', pgError('ECONNREFUSED')],
    ['57P03 (starting up)', pgError('57P03')],
    ['08006 (connection failure)', pgError('08006')],
  ])('keeps waiting on %s, quietly (warn, a code, no message)', async (_name, err) => {
    const r = run([err, err, NEWEST]);
    expect(await r.result).toBe(true);
    const lines = r.captured.records();
    expect(lines.every((l) => l.level === 40)).toBe(true);
    expect(lines[0]).toMatchObject({ sqlstate: err.code });
    expect(r.captured.lines.join('\n')).not.toContain('secret');
  });

  it('an unexpected error is logged at error, without its message, and the wait goes on', async () => {
    const r = run([pgError('XX000'), NEWEST]);
    expect(await r.result).toBe(true);
    expect(r.captured.records().some((l) => l.level === 50 && l.sqlstate === 'XX000')).toBe(true);
    expect(r.captured.lines.join('\n')).not.toContain('secret');
  });

  it('abort resolves false', async () => {
    const r = run([null], { abortAfter: 3 });
    expect(await r.result).toBe(false);
    expect(r.reads()).toBe(3);
  });

  it('after five minutes it logs at error, once a minute', async () => {
    let t = 0;
    // The clock moves 20 s per attempt: 30 attempts cover 10 minutes.
    const r = run([null], {
      abortAfter: 30,
      clock: () => {
        t += 20_000;
        return t;
      },
    });
    expect(await r.result).toBe(false);
    const lines = r.captured.records();
    const errors = lines.filter((l) => l.level === 50);
    expect(errors.length).toBeGreaterThanOrEqual(4);
    expect(errors.length).toBeLessThanOrEqual(6);
    expect(lines.findIndex((l) => l.level === 50)).toBeGreaterThan(10);
  });

  it('finds the newest migration in the image', () => {
    expect(newestMigration()).toBe(NEWEST);
  });
});

describe('extract:smoke', () => {
  it('prints the model, tokens, cost and each claim, then PASS', async () => {
    const lines: string[] = [];
    const pass = await runSmoke(
      new FakeExtractor(() => [rawClaim('my preferred package manager is pnpm')]),
      (l) => lines.push(l),
    );
    expect(pass).toBe(true);
    expect(lines).toEqual([
      'model: fake-model-2026-10-01',
      'tokens: input 2500 (cached 0), output 300',
      'cost: $0.000400',
      'claims: 1',
      '  1. preferred_package_manager = pnpm (preference): exact',
      'PASS',
    ]);
  });

  it('FAIL when a quote does not verify, when nothing came back, or on an error', async () => {
    for (const behavior of [
      () => [rawClaim('my favourite package manager is pnpm')],
      () => [],
      () => new ExtractorError('auth', false, { status: 401 }),
    ]) {
      const lines: string[] = [];
      expect(await runSmoke(new FakeExtractor(behavior), (l) => lines.push(l))).toBe(false);
      expect(lines.at(-1)).toBe('FAIL');
    }
  });

  it('the synthetic message is the spec example, and the output never holds the key', async () => {
    expect(SMOKE_MESSAGE).toBe(
      'For the record, my preferred package manager is pnpm. Can you update the README?',
    );
    const key = `sk-${'proj-'}${randomToken('alnum', 48, 'smoke-key')}`;
    const lines: string[] = [];
    await runSmoke(new FakeExtractor(() => new ExtractorError('network', true)), (l) =>
      lines.push(l),
    );
    expect(lines.join('\n')).not.toContain(key);
    expect(lines).toEqual(['error: network', 'FAIL']);
  });
});
