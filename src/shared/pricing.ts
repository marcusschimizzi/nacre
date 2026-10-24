/**
 * The pinned price table (spec §12.3): USD per 1 M tokens, OpenAI Standard tier, checked Oct 21,
 * 2026. `model_calls.cost_usd` is computed from it, and the daily budget (§12.2) sums that column,
 * so a price change here is a code change with a date, never a lookup at runtime.
 */
export const MODEL_PRICES = {
  'gpt-6-luna': { input: 0.1, cachedInput: 0.01, output: 0.5 },
  'gpt-5.6-luna': { input: 0.2, cachedInput: 0.02, output: 1.2 },
} as const satisfies Record<string, { input: number; cachedInput: number; output: number }>;

export type PricedModel = keyof typeof MODEL_PRICES;

export const PRICED_MODELS = Object.keys(MODEL_PRICES) as PricedModel[];

export const isPricedModel = (model: string): model is PricedModel =>
  Object.hasOwn(MODEL_PRICES, model);

export interface TokenUsage {
  /** All input tokens, cached ones included. */
  inputTokens: number;
  cachedTokens: number;
  /** All output tokens, reasoning ones included. */
  outputTokens: number;
}

/**
 * The cost of one call, rounded to 6 decimals (`numeric(10,6)`). Priced by the configured model
 * (the alias), not the snapshot string the provider returns. Throws for a model with no price.
 */
export function costUsd(model: string, usage: TokenUsage): number {
  if (!isPricedModel(model)) throw new Error(`no price for model ${model}`);
  const price = MODEL_PRICES[model];
  const uncached = usage.inputTokens - usage.cachedTokens;
  const micro =
    uncached * price.input +
    usage.cachedTokens * price.cachedInput +
    usage.outputTokens * price.output;
  // Tokens × USD-per-million = micro-dollars; rounding there avoids float noise in the 6th place.
  return Math.round(micro) / 1e6;
}
