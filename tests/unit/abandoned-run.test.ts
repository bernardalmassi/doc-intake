// What the stale-run reaper charges a run it abandons (migration
// 20260918000003, mirrored by abandonedRunCostUsd in config.ts): an
// estimate of the most that run could have consumed, from the page count
// the Extract action sent with the run, at Haiku 4.5's price. Checked here
// with no database: a one-page run stays under 10 % of the tenant ceiling,
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

  it("keeps an abandoned one-page run under 10 % of the tenant ceiling", () => {
    // 3 calls of 4 500 + 3 000 tokens in and 2 048 out, at 1 / 5 USD per million
    expect(abandonedRunUsage(1)).toEqual({ pages: 1, inputTokens: 22_500, outputTokens: 6_144 });
    expect(abandonedRunCostUsd(1)).toBe(0.05322);
    expect(abandonedRunCostUsd(1)).toBeLessThan(0.1 * CEILING);
  });

  it("grows with the page count instead of charging every run the same", () => {
    const costs = Array.from({ length: EXTRACTION_LIMITS.maxPagesPerDocument }, (_, i) => abandonedRunCostUsd(i + 1));
    // strictly more for each page until a call can take no more input
    const capped = Math.floor(
      (EXTRACTION_LIMITS.maxInputTokensPerCall - EXTRACTION_LIMITS.promptInputTokens) / EXTRACTION_LIMITS.inputTokensPerPage,
    );
    for (let pages = 2; pages <= capped; pages++) {
      expect(costs[pages - 1], `${pages} pages`).toBeGreaterThan(costs[pages - 2]);
    }
    expect(abandonedRunCostUsd(10)).toBeGreaterThan(2 * abandonedRunCostUsd(1));
    // a genuinely large document may cost most of the budget, and does
    expect(abandonedRunCostUsd(EXTRACTION_LIMITS.maxPagesPerDocument)).toBeGreaterThan(0.5 * CEILING);
    expect(abandonedRunCostUsd(EXTRACTION_LIMITS.maxPagesPerDocument)).toBeLessThan(CEILING);
    // an unknown count is charged as the most pages a document can have
    expect(abandonedRunCostUsd(null)).toBe(abandonedRunCostUsd(EXTRACTION_LIMITS.maxPagesPerDocument));
    expect(abandonedRunUsage(5000).pages).toBe(EXTRACTION_LIMITS.maxPagesPerDocument);
  });

  for (const fixture of FIXTURES) {
    it(`${fixture.id}: more than any recorded run of it`, async () => {
      const pages = countPdfPages(committedPdf(fixture));
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
