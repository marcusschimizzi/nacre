import type { TokenUsage } from '../shared/pricing.js';

/**
 * The provider-agnostic extractor (spec §12.2, §12.3). Nothing here is OpenAI-shaped: slice 1 ships
 * the OpenAI adapter (`openai.ts`) and a fake for tests, and a later Anthropic adapter implements
 * the same interface without the worker changing.
 */

export type { TokenUsage };

export interface ExtractInput {
  observedAt: Date;
  observedTz: string | null;
  /** Oldest first, already cut to 1,000 code points each. */
  context: ReadonlyArray<{ role: 'user' | 'assistant'; text: string }>;
  target: { kind: 'message' | 'remember'; role: 'user' | 'assistant'; text: string };
}

export const ASSERTION_TYPES = [
  'stated',
  'preference',
  'instruction',
  'plan',
  'decision',
  'hypothesis',
  'quoted_third_party',
] as const;

export type AssertionType = (typeof ASSERTION_TYPES)[number];

/** One claim as the model returns it (spec §5.3), after schema validation, before verification. */
export interface RawClaim {
  text: string;
  subject: string;
  attribute: string;
  value: string;
  value_kind: 'entity' | 'literal';
  assertion_type: AssertionType;
  quote: string;
  time_phrase: string | null;
  confidence: number;
  confidence_reason: string;
}

export interface ExtractResult {
  claims: RawClaim[];
  /** The model's parsed JSON, stored as `extraction_runs.raw_output`. */
  rawOutput: unknown;
  usage: TokenUsage;
  /** The model string the provider returned (a pinned snapshot), or null. */
  modelVersion: string | null;
}

export interface Extractor {
  /** `extraction_runs.extractor`, e.g. 'fastpass-v1'. */
  readonly id: string;
  /** `model_calls.provider`, e.g. 'openai'. */
  readonly provider: string;
  /** The configured model, e.g. 'gpt-6-luna'; it is also the price table key. */
  readonly model: string;
  /** 'extract-claims'. */
  readonly promptId: string;
  /** sha256 hex of the prompt template (prompts/extract-claims.v1.ts). */
  readonly promptHash: string;
  /**
   * Everything else that changes outputs (model, effort, schema version); hashed with the worker's
   * chunk and context sizes into extraction_runs.config_hash.
   */
  readonly settings: Readonly<Record<string, string | number | boolean>>;
  extract(input: ExtractInput, opts: { signal: AbortSignal }): Promise<ExtractResult>;
}

export type ExtractorErrorCode =
  // retryable
  | 'timeout'
  | 'network'
  | 'rate_limited'
  | 'http_5xx'
  | 'http_retryable'
  | 'api_error'
  | 'incomplete'
  | 'schema_violation'
  // `auth` is special (the job waits and the loop pauses); the other two are permanent
  | 'auth'
  | 'http_4xx'
  | 'refusal'
  | 'aborted';

export interface ExtractorErrorExtra {
  status?: number;
  /** Set when the provider billed the call anyway (schema violation, refusal, incomplete). */
  usage?: TokenUsage;
  /** What the model returned, stored on the run; never logged. */
  rawOutput?: unknown;
  /** The provider's `error.type` or `error.code`, only when it is a short plain code. */
  providerCode?: string;
}

export class ExtractorError extends Error {
  constructor(
    readonly code: ExtractorErrorCode,
    readonly retryable: boolean,
    readonly extra: ExtractorErrorExtra = {},
  ) {
    // The message is the fixed code: never provider text, never content.
    super(code);
    this.name = 'ExtractorError';
  }
}
