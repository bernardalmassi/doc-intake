// When close_extraction_run refuses a run's outcome, the Extract action
// closes the run again as failed, as failedCloseAttempts plans it, so the
// document doesn't sit in processing until the reaper. These check the plan;
// tests/extraction.test.ts checks the database accepts it after a refusal.

import { describe, expect, it } from "vitest";
import { classifyRunError } from "@/lib/errors";
import { failedCloseAttempts, toCloseParams, type RunOutcome } from "@/lib/extraction/run";

const usage = {
  provider: "anthropic" as const,
  model: "claude-haiku-4-5-20251001",
  attempts: 2,
  inputTokens: 1200,
  outputTokens: 300,
  latencyMs: 4200,
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
  it("closes a refused success as failed, first with its usage, then without", () => {
    const attempts = failedCloseAttempts(succeeded, "22023");
    expect(attempts).toHaveLength(2);
    const [withUsage, withoutUsage] = attempts;

    expect(withUsage).toMatchObject({ status: "failed", rawResponse: null, ...usage });
    expect(withoutUsage).toMatchObject({
      status: "failed",
      rawResponse: null,
      provider: null,
      model: null,
      inputTokens: 0,
      outputTokens: 0,
    });
    for (const attempt of attempts) {
      expect(attempt.status === "failed" && classifyRunError(attempt.error)).toBe("extraction.result_not_saved");
      const params = toCloseParams("run", "token", attempt);
      expect(params.p_status).toBe("failed");
      expect(params.p_fields).toBeNull();
      expect(params.p_error).toContain("22023");
    }
  });

  it("keeps a failed run's own error, so the page shows why it failed", () => {
    const attempts = failedCloseAttempts(failed, null);
    expect(attempts).toHaveLength(2);
    for (const attempt of attempts) {
      expect(attempt.status === "failed" && attempt.error).toBe(failed.status === "failed" && failed.error);
      expect(attempt.status === "failed" && attempt.rawResponse).toBeNull();
    }
    expect(classifyRunError(failed.status === "failed" ? failed.error : null)).toBe("extraction.provider_timeout");
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
