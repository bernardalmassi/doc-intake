// What the stale-run reaper charges a run it abandons (migration
// 20260918000003, mirrored by abandonedRunCostUsd in config.ts): an
// estimate of the most that run could have consumed, from the page count
// the Extract action sent with the run, at the price of the dearest model
// the app asks for. Checked here with no database: a one-page run costs the
// measured figure and a handful of them (the hourly run limit) can't
// exhaust a tenant,
// the charge grows with pages instead of being flat (a large document may
// legitimately cost most of the budget), and for every recorded eval run
// the estimate is more than what the real run cost. The SQL itself is
// tested by supabase/tests/extraction_stale_runs.sql (npm run test:db).

import { describe, expect, it } from "vitest";
import { FIXTURES } from "../../evals/fixtures";
import { committedPdf, PROVIDERS, replayFixture } from "../../evals/harness";
import {
  abandonedRunCostUsd,
  abandonedRunUsage,
  computeCostUsd,
  DEFAULT_MODELS,
  EXTRACTION_LIMITS,
  MAX_OUTPUT_TOKENS,
  MAX_VALIDATION_RETRIES,
  PRICING,
} from "@/lib/extraction/config";
import { countPdfPages } from "@/lib/extraction/pages";

const CEILING = EXTRACTION_LIMITS.tenantMonthlyCeilingUsd;

describe("the abandoned-run estimate", () => {
  it("uses the call count and output cap the orchestrator enforces", () => {
    // primary, one switch to the fallback, one validation retry
    expect(EXTRACTION_LIMITS.maxCallsPerRun).toBe(2 + MAX_VALIDATION_RETRIES);
    expect(EXTRACTION_LIMITS.maxOutputTokensPerCall).toBe(MAX_OUTPUT_TOKENS);
  });

  it("prices at the dearest model the app asks for", () => {
    const { inputTokens, outputTokens } = abandonedRunUsage(1);
    const dearestDefault = Object.values(DEFAULT_MODELS).sort(
      (a, b) => computeCostUsd(b, inputTokens, outputTokens) - computeCostUsd(a, inputTokens, outputTokens),
    )[0];
    expect(EXTRACTION_LIMITS.abandonedRunPriceModel).toBe(dearestDefault);
    expect(PRICING[EXTRACTION_LIMITS.abandonedRunPriceModel]).toBeDefined();
  });

  it("charges an abandoned one-page run the measured figure, and a handful of them can't exhaust a tenant", () => {
    // 3 calls of 4 500 + 3 000 tokens in and 2 048 out, at Claude Sonnet 5's
    // 2 / 10 USD per million (0.05322 when Haiku 4.5 was the default)
    expect(abandonedRunUsage(1)).toEqual({ pages: 1, inputTokens: 22_500, outputTokens: 6_144 });
    expect(abandonedRunCostUsd(1)).toBe(0.10644);
    // The rule (SECURITY.md, "Stale runs"): a tenant can start at most the
    // hourly run limit's worth of runs an hour, and that many abandoned
    // one-page runs must leave it able to run
    expect(EXTRACTION_LIMITS.hourlyRunLimit * abandonedRunCostUsd(1)).toBeLessThan(CEILING);
  });

  // SECURITY.md, "Stale runs": the table of what a run in flight holds and
  // an abandoned run is charged, row by row, at Sonnet 5 prices (now) and
  // Haiku 4.5 prices (before 20260918000004)
  it.each([
    [1, 22_500, 0.10644, 0.05322],
    [2, 31_500, 0.12444, 0.06222],
    [10, 103_500, 0.26844, 0.13422],
    [20, 193_500, 0.44844, 0.22422],
    [50, 463_500, 0.98844, 0.49422],
    [88, 800_000, 1.66144, 0.83072],
    [100, 800_000, 1.66144, 0.83072],
    [null, 800_000, 1.66144, 0.83072],
  ] as const)("SECURITY.md's table: %s pages hold %i tokens in and 6 144 out, %f USD (Haiku %f)", (pages, input, sonnet, haiku) => {
    expect(abandonedRunUsage(pages)).toMatchObject({ inputTokens: input, outputTokens: 6_144 });
    expect(abandonedRunCostUsd(pages)).toBe(sonnet);
    expect(computeCostUsd("claude-haiku-4-5-20251001", input, 6_144)).toBe(haiku);
  });

  it("grows with the page count instead of charging every run the same", () => {
    const costs = Array.from({ length: EXTRACTION_LIMITS.maxPagesPerDocument }, (_, i) => abandonedRunCostUsd(i + 1));
    // strictly more for each page until a cap binds: a call's input
    // (max_input_tokens_per_call), or the run's (max_input_tokens_per_run)
    const L = EXTRACTION_LIMITS;
    const perCallFull = Math.floor((L.maxInputTokensPerCall - L.promptInputTokens) / L.inputTokensPerPage);
    const perRunFull = Math.floor((L.maxInputTokensPerRun / L.maxCallsPerRun - L.promptInputTokens) / L.inputTokensPerPage);
    const capped = Math.min(perCallFull, perRunFull, L.maxPagesPerDocument);
    // the per-call cap no longer binds before the page limit (20260919000001)
    expect(perCallFull).toBe(L.maxPagesPerDocument);
    for (let pages = 2; pages <= capped; pages++) {
      expect(costs[pages - 1], `${pages} pages`).toBeGreaterThan(costs[pages - 2]);
    }
    expect(abandonedRunCostUsd(10)).toBeGreaterThan(2 * abandonedRunCostUsd(1));
    // a genuinely large document may cost most of the budget, or at Sonnet 5
    // prices more than all of it (1.66144 USD from 88 pages, where the
    // per-run clamp binds), and does
    expect(abandonedRunCostUsd(EXTRACTION_LIMITS.maxPagesPerDocument)).toBe(1.66144);
    expect(abandonedRunCostUsd(EXTRACTION_LIMITS.maxPagesPerDocument)).toBeGreaterThan(0.5 * CEILING);
    // an unknown count is charged as the most pages a document can have
    expect(abandonedRunCostUsd(null)).toBe(abandonedRunCostUsd(EXTRACTION_LIMITS.maxPagesPerDocument));
    expect(abandonedRunUsage(5000).pages).toBe(EXTRACTION_LIMITS.maxPagesPerDocument);
  });

  for (const fixture of FIXTURES) {
    it(`${fixture.id}: more than any recorded run of it`, async () => {
      const pages = await countPdfPages(committedPdf(fixture));
      expect(pages).not.toBeNull();
      const estimate = abandonedRunCostUsd(pages);
      for (const provider of PROVIDERS) {
        // what close_extraction_run recorded for the real run: its summed
        // tokens at the price of the model that served it
        const { outcome } = await replayFixture(fixture, provider);
        const real = computeCostUsd(outcome.model!, outcome.inputTokens, outcome.outputTokens);
        expect(real, `${provider} recorded cost`).toBeGreaterThan(0);
        expect(estimate, `${provider}: estimate ${estimate} vs real ${real}`).toBeGreaterThan(real);
      }
    });
  }
});
