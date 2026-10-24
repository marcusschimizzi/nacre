import { pathToFileURL } from 'node:url';
import { costUsd, isPricedModel, PRICED_MODELS } from '../shared/pricing.js';
import { type Extractor, ExtractorError } from './extractor.js';
import { OpenAiExtractor } from './openai.js';
import { verifyQuote } from './quote.js';

/**
 * The manual live check (task 5 brief §12): one real extraction of a built-in synthetic message,
 * about $0.0004. Marcus runs it; CI never does. It touches no database and never prints the key or
 * a request header.
 *
 *   pnpm extract:smoke                                       # locally, key from .env
 *   railway ssh --service worker -- node dist/worker/smoke.js # in the worker, where the key is
 */

export const SMOKE_MESSAGE =
  'For the record, my preferred package manager is pnpm. Can you update the README?';

/** Runs one extraction and prints the result; true for PASS. */
export async function runSmoke(
  extractor: Extractor,
  print: (line: string) => void,
): Promise<boolean> {
  let result: Awaited<ReturnType<Extractor['extract']>>;
  try {
    result = await extractor.extract(
      {
        observedAt: new Date(),
        observedTz: 'America/Chicago',
        context: [],
        target: { kind: 'message', role: 'user', text: SMOKE_MESSAGE },
      },
      { signal: AbortSignal.timeout(90_000) },
    );
  } catch (err) {
    const code = err instanceof ExtractorError ? err.code : 'unexpected_error';
    const status =
      err instanceof ExtractorError && err.extra.status ? ` (HTTP ${err.extra.status})` : '';
    print(`error: ${code}${status}`);
    print('FAIL');
    return false;
  }

  const { usage } = result;
  print(`model: ${result.modelVersion ?? '(none returned)'}`);
  print(
    `tokens: input ${usage.inputTokens} (cached ${usage.cachedTokens}), output ${usage.outputTokens}`,
  );
  print(`cost: $${costUsd(extractor.model, usage).toFixed(6)}`);
  print(`claims: ${result.claims.length}`);
  let verified = 0;
  for (const [i, claim] of result.claims.entries()) {
    const check = verifyQuote(SMOKE_MESSAGE, claim.quote);
    if (check.ok) verified++;
    print(
      `  ${i + 1}. ${claim.attribute} = ${claim.value} (${claim.assertion_type}): ${check.ok ? check.matchKind : check.reason}`,
    );
  }
  const pass = result.claims.length > 0 && verified === result.claims.length;
  print(pass ? 'PASS' : 'FAIL');
  return pass;
}

async function main(): Promise<number> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('OPENAI_API_KEY is not set.');
    return 2;
  }
  const model = process.env.LLM_MODEL || 'gpt-6-luna';
  if (!isPricedModel(model)) {
    console.error(`LLM_MODEL must be one of: ${PRICED_MODELS.join(', ')}`);
    return 2;
  }
  const pass = await runSmoke(new OpenAiExtractor({ apiKey, model }), (line) => console.log(line));
  return pass ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
