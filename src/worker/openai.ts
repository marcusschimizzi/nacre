import { z } from 'zod';
import type { TokenUsage } from '../shared/pricing.js';
import {
  ASSERTION_TYPES,
  type ExtractInput,
  type Extractor,
  ExtractorError,
  type ExtractResult,
  type RawClaim,
} from './extractor.js';
import {
  OUTPUT_SCHEMA,
  PROMPT_HASH,
  PROMPT_ID,
  renderUserMessage,
  SYSTEM_PROMPT,
} from './prompts/extract-claims.v1.js';

/**
 * The OpenAI adapter (spec §12.3): the Responses API with strict `json_schema` output and low
 * reasoning effort, over plain `fetch` (no SDK). No retries here: the job's retries are the retry
 * layer. The key goes in the Authorization header and nowhere else: not in an error, a log field or
 * `settings`. Errors carry a fixed code; provider text and model output never reach a message.
 */

export const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';

export interface OpenAiExtractorOptions {
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

// What a provider's error.type or error.code must look like before it may go in a log field.
const PLAIN_CODE = /^[a-z0-9_.-]{1,64}$/;

const usageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  input_tokens_details: z.object({ cached_tokens: z.number().int().nonnegative() }).nullish(),
  output_tokens: z.number().int().nonnegative(),
});

// Only the fields read below; anything else in the response is ignored.
const responseSchema = z
  .object({
    status: z.string().nullish(),
    model: z.string().nullish(),
    error: z.unknown().nullish(),
    output: z
      .array(
        z
          .object({
            type: z.string(),
            content: z
              .array(z.object({ type: z.string(), text: z.string().optional() }).loose())
              .nullish(),
          })
          .loose(),
      )
      .nullish(),
    usage: usageSchema.nullish(),
  })
  .loose();

const nonEmpty = z.string().min(1);

const claimSchema = z.strictObject({
  text: nonEmpty,
  subject: nonEmpty,
  attribute: nonEmpty,
  value: nonEmpty,
  value_kind: z.enum(['entity', 'literal']),
  assertion_type: z.enum(ASSERTION_TYPES),
  quote: nonEmpty,
  time_phrase: z
    .string()
    .nullable()
    .transform((v) => (v === '' ? null : v)),
  confidence: z.number().min(0).max(1),
  confidence_reason: z.string(),
});

const outputSchema = z.strictObject({ claims: z.array(claimSchema) });

/** Lowercase snake_case: runs of anything but a-z and 0-9 become `_`, trimmed at both ends. */
export function normalizeAttribute(attribute: string): string {
  return attribute
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

export class OpenAiExtractor implements Extractor {
  readonly id = 'fastpass-v1';
  readonly provider = 'openai';
  readonly promptId = PROMPT_ID;
  readonly promptHash = PROMPT_HASH;
  readonly model: string;
  readonly settings: Readonly<Record<string, string | number | boolean>>;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor({ apiKey, model, fetchImpl = fetch, timeoutMs = 60_000 }: OpenAiExtractorOptions) {
    this.model = model;
    this.settings = { model, reasoning_effort: 'low', response_format: 'json_schema_strict' };
    this.#apiKey = apiKey;
    this.#fetch = fetchImpl;
    this.#timeoutMs = timeoutMs;
  }

  async extract(input: ExtractInput, opts: { signal: AbortSignal }): Promise<ExtractResult> {
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    let res: Response;
    try {
      res = await this.#fetch(OPENAI_RESPONSES_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.#apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(this.requestBody(input)),
        signal: AbortSignal.any([opts.signal, timeout]),
      });
    } catch {
      throw this.#transportError(opts.signal, timeout);
    }

    if (!res.ok) throw await httpError(res);

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      if (opts.signal.aborted || timeout.aborted) throw this.#transportError(opts.signal, timeout);
      // A 2xx whose body isn't JSON: the call may have been billed, but there is no usage to record.
      throw new ExtractorError('api_error', true, { status: res.status });
    }
    return parseResponse(body);
  }

  /** The request body; public so tests can assert its shape without a network. */
  requestBody(input: ExtractInput) {
    return {
      model: this.model,
      input: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: renderUserMessage(input) },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'extract_claims',
          strict: true,
          schema: OUTPUT_SCHEMA,
        },
      },
      // No temperature: reasoning models reject it (spec §6.3).
      reasoning: { effort: 'low' },
      // OpenAI keeps no copy of the message.
      store: false,
      max_output_tokens: 8000,
    };
  }

  #transportError(signal: AbortSignal, timeout: AbortSignal): ExtractorError {
    if (signal.aborted) return new ExtractorError('aborted', false);
    if (timeout.aborted) return new ExtractorError('timeout', true);
    return new ExtractorError('network', true);
  }
}

async function httpError(res: Response): Promise<ExtractorError> {
  const status = res.status;
  const providerCode = await readProviderCode(res);
  const extra = { status, ...(providerCode ? { providerCode } : {}) };
  if (status === 401 || status === 403) return new ExtractorError('auth', false, extra);
  if (status === 429) return new ExtractorError('rate_limited', true, extra);
  if (status === 408 || status === 409) return new ExtractorError('http_retryable', true, extra);
  if (status >= 500) return new ExtractorError('http_5xx', true, extra);
  return new ExtractorError('http_4xx', false, extra);
}

/** `error.code`, else `error.type`, from an error body, when it is a short plain code. */
async function readProviderCode(res: Response): Promise<string | undefined> {
  try {
    const parsed = z
      .object({ error: z.object({ code: z.unknown(), type: z.unknown() }).partial() })
      .safeParse(await res.json());
    if (!parsed.success) return undefined;
    for (const value of [parsed.data.error.code, parsed.data.error.type]) {
      if (typeof value === 'string' && PLAIN_CODE.test(value)) return value;
    }
  } catch {
    // Not JSON: no code.
  }
  return undefined;
}

function toUsage(usage: z.infer<typeof usageSchema> | null | undefined): TokenUsage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.input_tokens,
    cachedTokens: usage.input_tokens_details?.cached_tokens ?? 0,
    outputTokens: usage.output_tokens,
  };
}

/** Steps 2 to 5 of the brief's response handling; exported for the fixture tests. */
export function parseResponse(body: unknown): ExtractResult {
  const parsed = responseSchema.safeParse(body);
  if (!parsed.success) throw new ExtractorError('api_error', true);
  const response = parsed.data;
  const usage = toUsage(response.usage);
  const billed = usage ? { usage } : {};

  if (response.status === 'incomplete') throw new ExtractorError('incomplete', true, billed);
  if (response.error != null) throw new ExtractorError('api_error', true, billed);

  const parts = (response.output ?? [])
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content ?? []);
  if (parts.some((p) => p.type === 'refusal')) {
    throw new ExtractorError('refusal', false, billed);
  }
  const text = parts.find((p) => p.type === 'output_text')?.text;
  if (text === undefined) throw new ExtractorError('schema_violation', true, billed);

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ExtractorError('schema_violation', true, { ...billed, rawOutput: text });
  }
  const output = outputSchema.safeParse(json);
  if (!output.success) {
    throw new ExtractorError('schema_violation', true, { ...billed, rawOutput: json });
  }
  const claims: RawClaim[] = [];
  for (const claim of output.data.claims) {
    const attribute = normalizeAttribute(claim.attribute);
    // One bad claim fails the chunk: under strict output it shouldn't happen, and a retry is cheap.
    if (!attribute)
      throw new ExtractorError('schema_violation', true, { ...billed, rawOutput: json });
    claims.push({ ...claim, attribute });
  }
  if (!usage) throw new ExtractorError('api_error', true, { rawOutput: json });
  return { claims, rawOutput: json, usage, modelVersion: response.model ?? null };
}
