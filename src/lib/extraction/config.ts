// Every number the extraction harness runs on, in one place. This module
// holds no secrets and is imported by tests, so it must not import
// "server-only" or read API keys.

// Spend ceilings and the rate limit. The database enforces these in
// check_extraction_limits (see supabase/migrations/20260925000002); the values
// here mirror public.extraction_limits so the app and tests can reason
// about them, and tests/extraction.test.ts fails if the two drift apart.
export const EXTRACTION_LIMITS = {
  tenantMonthlyCeilingUsd: 1.0,
  globalMonthlyCeilingUsd: 3.0,
  hourlyRunLimit: 5,
  // token counts reported at close are clamped to these (4 calls of at
  // most 200k in and MAX_OUTPUT_TOKENS out), so a forged run's cost is bounded
  maxInputTokensPerRun: 800_000,
  maxOutputTokensPerRun: 8_192,
  // a run still queued or running after this long (a claimed run: after
  // its claim) is ended by the queue's sweep or the next enqueue
  staleRunMinutes: 10,
  // how long a claimed queue message stays invisible: longer than the
  // worker route's maxDuration, no longer than staleRunMinutes
  // (20260925000002)
  workerVisibilitySeconds: 300,
  // What an abandoned run is charged (abandonedRunCostUsd below, migration
  // 20260918000003): the calls and output cap the orchestrator enforces,
  // an input bound from the document's page count, at the price of the
  // dearest model the app asks for. SECURITY.md, "Stale runs", has the
  // derivation.
  maxCallsPerRun: 3,
  maxOutputTokensPerCall: 2048,
  maxInputTokensPerCall: 304_500,
  promptInputTokens: 4500,
  inputTokensPerPage: 3000,
  // Anthropic's per-request PDF page limit; also what an unknown count is
  // charged as
  maxPagesPerDocument: 100,
  abandonedRunPriceModel: "claude-sonnet-5",
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

// Providers and models. EXTRACTION_PROVIDER picks the primary; the other is
// the fallback on timeout or 5xx. On the Anthropic side the default is
// Claude Sonnet 5 (EVALS.md, "Sonnet 5 against Haiku 4.5"); Claude Haiku
// 4.5 stays selectable with EXTRACTION_ANTHROPIC_MODEL, which accepts any
// Anthropic model priced below. The OpenAI side is the cheapest usable
// model. Every model here must take PDF and image input and support
// schema-constrained output.
export type ProviderName = "anthropic" | "openai";

export const PROVIDER_ENV_VAR = "EXTRACTION_PROVIDER";
export const DEFAULT_PROVIDER: ProviderName = "anthropic";

export const DEFAULT_MODELS: Record<ProviderName, string> = {
  anthropic: "claude-sonnet-5",
  openai: "gpt-5-nano",
};

export const ANTHROPIC_MODEL_ENV_VAR = "EXTRACTION_ANTHROPIC_MODEL";

// Anthropic models that EXTRACTION_ANTHROPIC_MODEL may name: those with a
// price on file, so finish_extraction_run can price every run.
export function selectableAnthropicModels(): string[] {
  return Object.entries(PRICING)
    .filter(([, price]) => price.provider === "anthropic")
    .map(([model]) => model)
    .sort();
}

// Thinking is off for Claude: a fixed-schema extraction doesn't need it,
// and Claude Sonnet 5 otherwise thinks adaptively at effort high by default,
// spending the per-call output cap on reasoning (thinking tokens are output
// tokens). Sent explicitly for every Claude model, Haiku included, so the
// request is the same whichever is selected.
export const ANTHROPIC_THINKING = { type: "disabled" } as const;

// Hard cap on what a single model call may generate. The schema has ten
// short fields; 2048 tokens is several times what a full answer needs.
export const MAX_OUTPUT_TOKENS = 2048;

// Per call. A run makes at most three calls (primary, one switch to the
// fallback before any answer, one validation retry; see run.ts), so the
// worst case wall time is three times this. The database's bounds on a run
// (attempts, the token clamp above) allow four.
export const PROVIDER_TIMEOUT_MS = 60_000;

// Per token count. Every call's input is counted first, with the
// provider's token counting endpoint (run.ts), so a run makes at most as
// many counts as calls; a count that fails or times out sends no call.
export const TOKEN_COUNT_TIMEOUT_MS = 15_000;

// The worker's finish (delivery.ts). A finish that gets no answer, or one of
// the database's transient refusals, is sent again after a wait that
// doubles from the first delay up to the last, each attempt given at most
// FINISH_ATTEMPT_TIMEOUT_MS, until WORKER_DEADLINE_MARGIN_MS before the end
// of the worker route's maxDuration. The margin leaves the function time to
// log and return before the host stops it.
export const FINISH_ATTEMPT_TIMEOUT_MS = 10_000;
export const FINISH_RETRY_FIRST_DELAY_MS = 500;
export const FINISH_RETRY_MAX_DELAY_MS = 8_000;
export const WORKER_DEADLINE_MARGIN_MS = 10_000;
// the shortest attempt worth making; less time than this left, no attempt
export const FINISH_MIN_ATTEMPT_MS = 1_000;

// One retry after a response that fails schema validation.
export const MAX_VALIDATION_RETRIES = 1;

// Reasoning models bill their reasoning as output tokens; keep it minimal
// for a fixed-schema extraction.
export const OPENAI_REASONING_EFFORT = "minimal" as const;

// Prices in USD per million tokens, standard tier, no caching, no batch,
// read from each provider's own pricing page on checkedOn. The database
// computes every run's cost from public.extraction_model_prices; this is a
// mirror of that table for the app and tests (the drift test compares
// them). Update the date whenever a row changes, in both places.
export type ModelPrice = {
  provider: ProviderName;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  checkedOn: string;
  source: string;
};

const ANTHROPIC_PRICING_PAGE = "https://platform.claude.com/docs/en/about-claude/models/overview";
const OPENAI_PRICING_PAGE = "https://developers.openai.com/api/docs/pricing";

export const PRICING: Record<string, ModelPrice> = {
  "claude-haiku-4-5-20251001": {
    provider: "anthropic",
    inputUsdPerMillion: 1.0,
    outputUsdPerMillion: 5.0,
    checkedOn: "2026-09-18",
    source: ANTHROPIC_PRICING_PAGE,
  },
  "claude-sonnet-5": {
    provider: "anthropic",
    inputUsdPerMillion: 2.0,
    outputUsdPerMillion: 10.0,
    checkedOn: "2026-09-18",
    source: ANTHROPIC_PRICING_PAGE,
  },
  "gpt-5-nano": {
    provider: "openai",
    inputUsdPerMillion: 0.05,
    outputUsdPerMillion: 0.4,
    checkedOn: "2026-09-18",
    source: OPENAI_PRICING_PAGE,
  },
  "gpt-5-mini": {
    provider: "openai",
    inputUsdPerMillion: 0.25,
    outputUsdPerMillion: 2.0,
    checkedOn: "2026-09-18",
    source: OPENAI_PRICING_PAGE,
  },
};

// Providers report the exact snapshot they served (for example
// gpt-5-nano-2025-08-07 for gpt-5-nano). Exact match first, then the
// longest priced id the reported id extends with a "-" suffix. Same rule
// as private.extraction_price_for_model.
export function priceForModel(model: string): ModelPrice {
  const exact = PRICING[model];
  if (exact) return exact;
  const prefix = Object.keys(PRICING)
    .filter((id) => model.startsWith(id + "-"))
    .sort((a, b) => b.length - a.length)[0];
  if (prefix) return PRICING[prefix];
  throw new Error(`no price on file for model ${model}; add it to PRICING in config.ts and to the migration`);
}

// The priced model that makes these token counts cost the most. When
// finish_extraction_run can't price the model a run was served by, the run
// is finished at this model's price instead of at no cost (failedCloseAttempts
// in run.ts): the dearest rate on file for the tokens the provider reported.
// The app only ever asks for models it prices, so whatever id comes back is
// one of them under another name, and can't cost more than this.
export function dearestModelFor(inputTokens: number, outputTokens: number): string {
  let dearest: { model: string; cost: number } | null = null;
  for (const [model, price] of Object.entries(PRICING).sort(([a], [b]) => a.localeCompare(b))) {
    const cost = inputTokens * price.inputUsdPerMillion + outputTokens * price.outputUsdPerMillion;
    if (dearest === null || cost > dearest.cost) dearest = { model, cost };
  }
  if (dearest === null) throw new Error("no model has a price on file");
  return dearest.model;
}

// What a run abandoned while running is charged (reap_extraction_run), and
// what every run in flight holds against the ceilings
// (check_extraction_limits), for a document of `pages` pages (null:
// unknown, charged as the most a document can have): at most
// maxCallsPerRun calls, each sending the prompt plus every page (and no
// more than a call can take), each capped at maxOutputTokensPerCall out, at
// abandonedRunPriceModel's price. The same formula as
// private.abandoned_estimate; the database's number is the one that counts.
export function abandonedRunUsage(pages: number | null): { inputTokens: number; outputTokens: number; pages: number } {
  const limits = EXTRACTION_LIMITS;
  const counted = Math.min(Math.max(1, pages ?? limits.maxPagesPerDocument), limits.maxPagesPerDocument);
  return {
    pages: counted,
    inputTokens: Math.min(limits.maxCallsPerRun * inputTokensPerCall(counted), limits.maxInputTokensPerRun),
    outputTokens: Math.min(limits.maxCallsPerRun * limits.maxOutputTokensPerCall, limits.maxOutputTokensPerRun),
  };
}

// The most one call may read for a document of `pages` pages (null:
// unknown, counted as the most a document can have): the prompt plus every
// page, and no more than a call can take. It is what the estimate above
// assumes each call reads, so the orchestrator measures every call's input
// with the provider's token counting endpoint before sending it and sends
// none that reads more (run.ts). The same formula as the input_per_call of
// private.abandoned_estimate.
export function inputTokensPerCall(pages: number | null): number {
  const limits = EXTRACTION_LIMITS;
  const counted = Math.min(Math.max(1, pages ?? limits.maxPagesPerDocument), limits.maxPagesPerDocument);
  return Math.min(limits.promptInputTokens + counted * limits.inputTokensPerPage, limits.maxInputTokensPerCall);
}

export function abandonedRunCostUsd(pages: number | null): number {
  const { inputTokens, outputTokens } = abandonedRunUsage(pages);
  return computeCostUsd(EXTRACTION_LIMITS.abandonedRunPriceModel, inputTokens, outputTokens);
}

// What finish_extraction_run will record for a run: the same clamp and
// rounding as private.extraction_charge, for display and for the drift
// test. The database's number is the one that counts.
export function computeCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  if (!Number.isInteger(inputTokens) || inputTokens < 0) {
    throw new Error(`input token count must be a non-negative integer, got ${inputTokens}`);
  }
  if (!Number.isInteger(outputTokens) || outputTokens < 0) {
    throw new Error(`output token count must be a non-negative integer, got ${outputTokens}`);
  }
  const price = priceForModel(model);
  const clampedIn = Math.min(inputTokens, EXTRACTION_LIMITS.maxInputTokensPerRun);
  const clampedOut = Math.min(outputTokens, EXTRACTION_LIMITS.maxOutputTokensPerRun);
  const micros = clampedIn * price.inputUsdPerMillion + clampedOut * price.outputUsdPerMillion;
  return Math.round((micros / 1_000_000) * 1e8) / 1e8;
}
