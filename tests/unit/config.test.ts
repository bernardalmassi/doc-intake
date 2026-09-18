// Cost arithmetic in config.ts: a known token count at the prices on file,
// snapshot ids priced by their prefix, the per-run clamp, and refusals for
// an unpriced model or a bad count. It mirrors what close_extraction_run
// computes in SQL; that the two agree, and that the price table matches the
// database's, is checked against the real project in tests/extraction.test.ts.
// Needs no database.

import { describe, expect, it } from "vitest";
import { computeCostUsd, EXTRACTION_LIMITS, PRICING } from "@/lib/extraction/config";

describe("configuration", () => {
  it("cost is computed from the pricing table for a known token count", () => {
    // Haiku 4.5: $1 per million in, $5 per million out
    expect(PRICING["claude-haiku-4-5-20251001"]).toMatchObject({ inputUsdPerMillion: 1, outputUsdPerMillion: 5 });
    expect(computeCostUsd("claude-haiku-4-5-20251001", 10_000, 500)).toBe(0.0125);
    // gpt-5-nano: $0.05 in, $0.40 out; the served snapshot id carries a date
    expect(computeCostUsd("gpt-5-nano-2025-08-07", 200_000, 1_000)).toBe(0.0104);
    expect(computeCostUsd("gpt-5-nano", 0, 0)).toBe(0);
    // clamped to the per-run maximum
    expect(computeCostUsd("claude-haiku-4-5-20251001", 5_000_000, 100_000)).toBe(
      computeCostUsd("claude-haiku-4-5-20251001", EXTRACTION_LIMITS.maxInputTokensPerRun, EXTRACTION_LIMITS.maxOutputTokensPerRun),
    );
    expect(() => computeCostUsd("no-such-model", 1, 1)).toThrow(/no price on file/);
    expect(() => computeCostUsd("gpt-5-nano", -1, 1)).toThrow();
  });
});
