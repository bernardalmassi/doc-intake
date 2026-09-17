// Every number the extraction harness runs on, in one place. This module
// holds no secrets and is imported by tests, so it must not import
// "server-only" or read API keys.

// Spend ceilings and the rate limit. The database enforces these in
// open_extraction_run (see supabase/migrations/20260918000001); the values
// here mirror public.extraction_limits so the app and tests can reason
// about them, and tests/extraction.test.ts fails if the two drift apart.
export const EXTRACTION_LIMITS = {
  tenantMonthlyCeilingUsd: 1.0,
  globalMonthlyCeilingUsd: 3.0,
  hourlyRunLimit: 5,
} as const;

// Confidence gating. A field at or above `high` is written as is; at or
// above `medium` it is written with one clarifying question; below that the
// whole document goes to needs_review.
export const CONFIDENCE_THRESHOLDS = {
  high: 0.85,
  medium: 0.6,
} as const;

export type ConfidenceBand = "high" | "medium" | "low";

export function confidenceBand(confidence: number): ConfidenceBand {
  if (confidence >= CONFIDENCE_THRESHOLDS.high) return "high";
  if (confidence >= CONFIDENCE_THRESHOLDS.medium) return "medium";
  return "low";
}

// Providers and models. The cheapest model on each side that takes PDF and
// image input and supports schema-constrained output. EXTRACTION_PROVIDER
// picks the primary; the other is the fallback on timeout or 5xx.
export type ProviderName = "anthropic" | "openai";

export const PROVIDER_ENV_VAR = "EXTRACTION_PROVIDER";
export const DEFAULT_PROVIDER: ProviderName = "anthropic";

export const DEFAULT_MODELS: Record<ProviderName, string> = {
  anthropic: "claude-haiku-4-5-20251001",
  openai: "gpt-5-nano",
};

// Hard cap on what a single model call may generate. The schema has ten
// short fields; 2048 tokens is several times what a full answer needs.
export const MAX_OUTPUT_TOKENS = 2048;

// Per call. A run may make up to four calls (primary, fallback, and one
// validation retry on each), so the worst case wall time is four times this.
export const PROVIDER_TIMEOUT_MS = 60_000;

// One retry after a response that fails schema validation.
export const MAX_VALIDATION_RETRIES = 1;

// Reasoning models bill their reasoning as output tokens; keep it minimal
// for a fixed-schema extraction.
export const OPENAI_REASONING_EFFORT = "minimal" as const;

// Prices in USD per million tokens, standard tier, no caching, no batch.
// Checked against each provider's own pricing page on PRICING_CHECKED_ON.
// Update the date whenever a row changes.
export const PRICING_CHECKED_ON = "2026-09-18";

export type ModelPrice = {
  provider: ProviderName;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  source: string;
};

export const PRICING: Record<string, ModelPrice> = {
  "claude-haiku-4-5-20251001": {
    provider: "anthropic",
    inputUsdPerMillion: 1.0,
    outputUsdPerMillion: 5.0,
    source: "https://platform.claude.com/docs/en/about-claude/models/overview",
  },
  "claude-sonnet-5": {
    provider: "anthropic",
    inputUsdPerMillion: 2.0,
    outputUsdPerMillion: 10.0,
    source: "https://platform.claude.com/docs/en/about-claude/models/overview",
  },
  "gpt-5-nano": {
    provider: "openai",
    inputUsdPerMillion: 0.05,
    outputUsdPerMillion: 0.4,
    source: "https://developers.openai.com/api/docs/pricing",
  },
  "gpt-5-mini": {
    provider: "openai",
    inputUsdPerMillion: 0.25,
    outputUsdPerMillion: 2.0,
    source: "https://developers.openai.com/api/docs/pricing",
  },
};

// Providers report the exact snapshot they served (for example
// gpt-5-nano-2025-08-07 for gpt-5-nano). Price by the id we asked for, and
// accept a reported id that starts with it.
export function priceForModel(model: string): ModelPrice {
  const exact = PRICING[model];
  if (exact) return exact;
  const prefix = Object.keys(PRICING).find((id) => model.startsWith(id + "-"));
  if (prefix) return PRICING[prefix];
  throw new Error(`no price on file for model ${model}; add it to PRICING in config.ts`);
}

// Cost of one call, rounded to the numeric(12, 8) the runs table stores.
export function computeCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  if (!Number.isInteger(inputTokens) || inputTokens < 0) {
    throw new Error(`input token count must be a non-negative integer, got ${inputTokens}`);
  }
  if (!Number.isInteger(outputTokens) || outputTokens < 0) {
    throw new Error(`output token count must be a non-negative integer, got ${outputTokens}`);
  }
  const price = priceForModel(model);
  const micros = inputTokens * price.inputUsdPerMillion + outputTokens * price.outputUsdPerMillion;
  return Math.round((micros / 1_000_000) * 1e8) / 1e8;
}
