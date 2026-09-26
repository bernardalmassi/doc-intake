// When close_extraction_run refuses a run's outcome, the Extract action
// closes the run again as failed, as failedCloseAttempts plans it, so the
// document doesn't sit in processing until the reaper: with its usage, then
// at an estimated cost, never with its usage dropped. These check the plan;
// tests/extraction.test.ts checks the database accepts it after a refusal
// and that the estimate counts toward the spend ceiling.

import { describe, expect, it } from "vitest";
import { classifyRunError, isCostEstimated } from "@/lib/errors";
import { computeCostUsd, dearestModelFor, PRICING } from "@/lib/extraction/config";
import { failedCloseAttempts, toCloseParams, type RunOutcome } from "@/lib/extraction/run";

const usage = {
  provider: "anthropic" as const,
  model: "claude-haiku-4-5-20251001",
  attempts: 2,
  inputTokens: 1200,
  outputTokens: 300,
  latencyMs: 4200,
  costEstimated: false,
};

const succeeded = {
  ...usage,
  status: "succeeded",
  documentStatus: "extracted",
  fields: [
    {
      name: "title",
      value: "Invoice 7",
      confidence: 0.95,
      band: "high",
      source_text: "Invoice 7",
      clarifying_question: null,
    },
  ],
} as unknown as RunOutcome;

const failed: RunOutcome = {
  ...usage,
  status: "failed",
  error: "anthropic transport: request timed out",
  rawResponse: "{\"partial\":",
};

describe("failedCloseAttempts", () => {
  it("closes a refused success as failed, first with its usage, then at an estimated cost", () => {
    const attempts = failedCloseAttempts(succeeded, "22023");
    expect(attempts).toHaveLength(2);
    const [withUsage, estimated] = attempts;

    expect(withUsage).toMatchObject({ status: "failed", rawResponse: null, ...usage });
    // the same tokens, at the dearest price on file
    expect(estimated).toMatchObject({
      status: "failed",
      rawResponse: null,
      provider: "anthropic",
      model: "claude-sonnet-5",
      attempts: usage.attempts,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    });
    expect(isCostEstimated(withUsage.status === "failed" ? withUsage.error : null)).toBe(false);
    expect(isCostEstimated(estimated.status === "failed" ? estimated.error : null)).toBe(true);
    for (const attempt of attempts) {
      expect(attempt.status === "failed" && classifyRunError(attempt.error)).toBe("extraction.result_not_saved");
      const params = toCloseParams("run", "token", attempt);
      expect(params.p_status).toBe("failed");
      expect(params.p_fields).toBeNull();
      expect(params.p_error).toContain("22023");
    }
  });

  it("never closes a run that called a provider without its usage", () => {
    const outcomes: RunOutcome[] = [
      succeeded,
      failed,
      { ...failed, model: "claude-unpriced-9" },
      { ...failed, provider: "openai", model: "gpt-5-nano-2025-08-07", inputTokens: 0, outputTokens: 0 },
      { ...failed, inputTokens: 0, outputTokens: 5 },
    ];
    for (const outcome of outcomes) {
      for (const attempt of failedCloseAttempts(outcome, "22023")) {
        expect(attempt.model).not.toBeNull();
        expect(attempt.provider).not.toBeNull();
        expect(attempt.attempts).toBe(outcome.attempts);
        expect(attempt.inputTokens).toBe(outcome.inputTokens);
        expect(attempt.outputTokens).toBe(outcome.outputTokens);
      }
    }
  });

  it("charges the estimate at a price the database has, and never less than any priced model", () => {
    const counts = [
      [0, 0],
      [1200, 300],
      [800_000, 0],
      [0, 8192],
      [5_000_000, 100_000],
    ];
    for (const [inputTokens, outputTokens] of counts) {
      const [, estimated] = failedCloseAttempts({ ...failed, model: "claude-unpriced-9", inputTokens, outputTokens }, "22023");
      expect(PRICING[estimated.model!]?.provider).toBe(estimated.provider);
      const charged = computeCostUsd(estimated.model!, inputTokens, outputTokens);
      for (const model of Object.keys(PRICING)) {
        expect(charged).toBeGreaterThanOrEqual(computeCostUsd(model, inputTokens, outputTokens));
      }
    }
    expect(dearestModelFor(1200, 300)).toBe("claude-sonnet-5");
  });

  it("keeps a failed run's own error, so the page shows why it failed", () => {
    const attempts = failedCloseAttempts(failed, null);
    expect(attempts).toHaveLength(2);
    const [withUsage, estimated] = attempts;
    expect(withUsage.status === "failed" && withUsage.error).toBe(failed.status === "failed" && failed.error);
    expect(estimated.status === "failed" && estimated.error).toBe(
      `cost estimated at the dearest price on file (no answer; served by claude-haiku-4-5-20251001): ${failed.status === "failed" && failed.error}`,
    );
    for (const attempt of attempts) {
      expect(attempt.status === "failed" && attempt.rawResponse).toBeNull();
      expect(attempt.status === "failed" && classifyRunError(attempt.error)).toBe("extraction.provider_timeout");
    }
  });

  it("quotes only an identifier-shaped model id and SQLSTATE in the estimate's error", () => {
    const hostile = { ...succeeded, model: "x) visit https://evil.example (" } as RunOutcome;
    const [, estimated] = failedCloseAttempts(hostile, "PGRST(1)");
    const error = estimated.status === "failed" ? estimated.error : "";
    expect(error).toBe(
      "cost estimated at the dearest price on file (unrecognised; served by unrecognised): the result could not be recorded: PGRST(1)",
    );
    expect(isCostEstimated(error)).toBe(true);
    expect(classifyRunError(error)).toBe("extraction.result_not_saved");
  });

  it("tries once when there is no usage to drop", () => {
    const noCall: RunOutcome = { ...failed, provider: null, model: null, attempts: 0, inputTokens: 0, outputTokens: 0 };
    expect(failedCloseAttempts(noCall, null)).toHaveLength(1);
  });

  it("says when the database never answered, without any of its text", () => {
    const [attempt] = failedCloseAttempts(succeeded, null);
    expect(attempt.status === "failed" && attempt.error).toBe("the result could not be recorded: no answer from the database");
  });
});

describe("isCostEstimated", () => {
  it("reads the marker only at the start, in its full shape", () => {
    expect(isCostEstimated("cost estimated at the dearest price on file (22023; served by m): anthropic transport: x")).toBe(true);
    expect(isCostEstimated("anthropic transport: cost estimated at the dearest price on file (22023; served by m): x")).toBe(false);
    expect(isCostEstimated("cost estimated at the dearest price on file: x")).toBe(false);
    expect(isCostEstimated(null)).toBe(false);
    // the stale-run reaper's estimate (20260918000003)
    const reaped =
      "cost estimated at claude-haiku-4-5-20251001 prices (abandoned; at most 3 calls of 7500 tokens in and 2048 out, for 1 page): " +
      "abandoned: still running after 10 minutes; failed by a later open";
    expect(isCostEstimated(reaped)).toBe(true);
    expect(classifyRunError(reaped)).toBe("extraction.abandoned");
  });
});
