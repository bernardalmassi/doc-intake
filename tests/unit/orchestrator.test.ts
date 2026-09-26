// The orchestrator (run.ts) with fake providers: no network, no keys, no
// database. It proves what the Extract action relies on:
//
//   - a timeout or 5xx on the primary falls back to the other provider, once
//     per run
//   - a call that was sent and got no answer (a timeout, anything thrown
//     without an HTTP status) counts at its measured input plus the output
//     cap, never at 0, and marks the cost as estimated; a run with tokens
//     from two models is priced at the dearer of the two
//   - a 4xx, a refusal or a truncated answer on the primary does not fall back
//   - when the fallback fails too, the run's error names both failures; when
//     there is no fallback to try, the error says so
//   - an invalid answer is retried once, on the provider that gave it,
//     carrying the previous answer and the validation error; if that is
//     invalid too the run fails cleanly with the last raw answer kept, and
//     no third call. The retry never switches provider, even on a timeout
//   - every billed call's tokens are summed: valid answers, invalid ones, and
//     refused or truncated ones, whose errors carry their usage
//   - over every combination of answers, a run makes at most three calls
//     (the database accepts four) and its error fits the 2000-character column
//   - no call is sent until its input has been counted and fits the per-call
//     limit for the document's pages: a first call over it is "too dense"
//     and sends nothing, a fallback that can't be measured or is over it
//     isn't used, and a retry over it isn't sent
//
// That the real SDKs' timeouts and 5xx responses become the fallback-eligible
// errors these fakes throw is proven in provider-errors.test.ts.

import { describe, expect, it } from "vitest";
import { classifyRunError, userFacingError } from "@/lib/errors";
import {
  CONFIDENCE_THRESHOLDS,
  dearestModelFor,
  EXTRACTION_LIMITS,
  inputTokensPerCall,
  MAX_OUTPUT_TOKENS,
  PRICING,
  type ProviderName,
} from "@/lib/extraction/config";
import { describeError, ProviderError } from "@/lib/extraction/providers/types";
import { runExtraction } from "@/lib/extraction/run";
import { answer, FAKE_COUNT, fakeProvider, pdfBytes, validJson } from "../helpers/fake-provider";
import { BAD_DATE, HAIKU, MAX_CALLS, NANO, NANO_SNAPSHOT, SERVED, scripted, scripts, STEPS } from "../helpers/scripted-providers";


// extraction_runs.error is checked to at most 2000 characters and attempts
// to between 0 and 4 (supabase/migrations/20260918000001_extraction_runs.sql);
// a close that breaks either is refused and the run is never recorded.
const DB_MAX_ERROR_LENGTH = 2000;
const DB_MAX_ATTEMPTS = 4;

const input = { bytes: pdfBytes("fake"), mimeType: "application/pdf" as const, filename: "fake.pdf", pages: 1 };

const timedOut = (provider: ProviderName) => new ProviderError(provider, "transport", "request timed out");
const serverError = (provider: ProviderName, status: number, message: string) =>
  new ProviderError(provider, "server", message, status);


describe("orchestrator (fake providers)", () => {
  it("an invalid answer is retried once with the validation error, then the run fails cleanly", async () => {
    const primary = fakeProvider("anthropic", "claude-haiku-4-5-20251001", [
      answer("{ this is not json"),
      answer('{"still": "wrong"}', "claude-haiku-4-5-20251001", 1200, 50),
    ]);
    const outcome = await runExtraction({ ...input, primary, fallback: null });

    expect(primary.requests).toHaveLength(2);
    expect(primary.requests[0].previousAttempt).toBeUndefined();
    expect(primary.requests[0].maxOutputTokens).toBe(MAX_OUTPUT_TOKENS);
    // the retry carries the previous answer and what was wrong with it
    expect(primary.requests[1].previousAttempt?.rawResponse).toBe("{ this is not json");
    expect(primary.requests[1].previousAttempt?.retryPrompt).toMatch(/not valid JSON/);

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(outcome.attempts).toBe(2);
    expect(outcome.error).toMatch(/after 1 retry/);
    expect(outcome.error).toMatch(/document_type is missing/);
    expect(outcome.rawResponse).toBe('{"still": "wrong"}');
    // both calls are paid for
    expect(outcome.inputTokens).toBe(2200);
    expect(outcome.outputTokens).toBe(150);
    expect(outcome.provider).toBe("anthropic");
  });

  it("a valid answer is gated by confidence", async () => {
    const text = validJson({
      title: { value: "Invoice 42", confidence: 0.99 },
      total_amount: { value: "10.00", confidence: 0.7 },
      due_date: { value: "2026-10-01", confidence: 0.2 },
    });
    const primary = fakeProvider("openai", "gpt-5-nano", [answer(text, "gpt-5-nano-2025-08-07", 500, 80)]);
    const outcome = await runExtraction({ ...input, primary, fallback: null });

    expect(outcome.status).toBe("succeeded");
    if (outcome.status !== "succeeded") return;
    expect(outcome.attempts).toBe(1);
    expect(outcome.model).toBe("gpt-5-nano-2025-08-07");
    const byName = Object.fromEntries(outcome.fields.map((f) => [f.name, f]));
    expect(byName.title).toMatchObject({ band: "high", clarifying_question: null });
    expect(byName.total_amount.band).toBe("medium");
    expect(byName.total_amount.clarifying_question).toMatch(/10\.00/);
    expect(byName.due_date).toMatchObject({ band: "low", value: "2026-10-01" });
    expect(outcome.documentStatus).toBe("needs_review");
    expect(CONFIDENCE_THRESHOLDS.medium).toBeLessThanOrEqual(0.7);
  });

  it("a timeout or 5xx on the primary falls back to the other provider", async () => {
    const primary = fakeProvider("anthropic", "claude-haiku-4-5-20251001", [
      new ProviderError("anthropic", "transport", "request timed out"),
    ]);
    const fallback = fakeProvider("openai", "gpt-5-nano", [answer(validJson(), "gpt-5-nano-2025-08-07", 700, 60)]);
    const outcome = await runExtraction({ ...input, primary, fallback });

    expect(primary.requests).toHaveLength(1);
    expect(fallback.requests).toHaveLength(1);
    // the timed-out call counts at its measured input and the output cap,
    // and both models' tokens at the dearer one's rates
    expect(outcome).toMatchObject({
      status: "succeeded",
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      attempts: 2,
      inputTokens: FAKE_COUNT + 700,
      outputTokens: MAX_OUTPUT_TOKENS + 60,
      costEstimated: true,
    });

    // a 5xx was refused, not processed: nothing counted for it
    const server = fakeProvider("openai", "gpt-5-nano", [new ProviderError("openai", "server", "bad gateway", 502)]);
    const second = fakeProvider("anthropic", "claude-haiku-4-5-20251001", [answer(validJson())]);
    const outcome2 = await runExtraction({ ...input, primary: server, fallback: second });
    expect(outcome2).toMatchObject({ status: "succeeded", provider: "anthropic", attempts: 2, inputTokens: 1000, costEstimated: false });
  });

  it("a 4xx or a refusal fails without falling back", async () => {
    const primary = fakeProvider("anthropic", "claude-haiku-4-5-20251001", [
      new ProviderError("anthropic", "client", "invalid request", 400),
    ]);
    const fallback = fakeProvider("openai", "gpt-5-nano", [answer(validJson())]);
    const outcome = await runExtraction({ ...input, primary, fallback });
    expect(fallback.requests).toHaveLength(0);
    expect(outcome).toMatchObject({ status: "failed", attempts: 1, inputTokens: 0, rawResponse: null });
    if (outcome.status === "failed") expect(outcome.error).toMatch(/anthropic client 400/);
  });
});

describe("measuring before every call", () => {
  // what the estimate assumes one call of a one-page document reads
  const ONE_PAGE = inputTokensPerCall(1);

  it("counts every call with the request it then sends, and sends one that fits", async () => {
    const primary = fakeProvider("anthropic", HAIKU, [answer("{ nope", HAIKU, 1000, 100), answer(validJson(), HAIKU, 1300, 150)]);
    const outcome = await runExtraction({ ...input, primary, fallback: null });

    expect(outcome).toMatchObject({ status: "succeeded", attempts: 2 });
    // the first call and the retry, each counted just before it was sent
    expect(primary.counted).toHaveLength(2);
    expect(primary.counted).toEqual(primary.requests);
  });

  it("sends a call whose input is exactly the limit, and is 4 500 tokens plus 3 000 a page, at most 304 500", async () => {
    expect(ONE_PAGE).toBe(7500);
    expect(inputTokensPerCall(20)).toBe(64_500);
    expect(inputTokensPerCall(100)).toBe(EXTRACTION_LIMITS.maxInputTokensPerCall);
    const primary = fakeProvider("anthropic", HAIKU, [answer(validJson())], [ONE_PAGE]);
    const outcome = await runExtraction({ ...input, primary, fallback: null });
    expect(outcome.status).toBe("succeeded");
    expect(primary.requests).toHaveLength(1);
  });

  it("sends nothing for a document whose first call measures over the limit: too dense, at 0, and no fallback", async () => {
    const primary = fakeProvider("anthropic", HAIKU, [answer(validJson())], [ONE_PAGE + 1]);
    const fallback = fakeProvider("openai", NANO, [answer(validJson(), NANO_SNAPSHOT)]);
    const outcome = await runExtraction({ ...input, primary, fallback });

    expect(primary.requests).toHaveLength(0);
    expect(fallback.counted).toHaveLength(0);
    expect(fallback.requests).toHaveLength(0);
    // no call, no model, no tokens: finish_extraction_run records 0 USD
    expect(outcome).toMatchObject({ status: "failed", provider: null, model: null, attempts: 0, inputTokens: 0, outputTokens: 0 });
    if (outcome.status === "failed") {
      expect(outcome.error).toBe(`too dense: its input (${ONE_PAGE + 1} tokens) is over the ${ONE_PAGE} a call may read for 1 page`);
      expect(classifyRunError(outcome.error)).toBe("extraction.too_dense");
      expect(userFacingError("extraction.too_dense").retryable).toBe(false);
    }
  });

  it("measures against the document's own pages", async () => {
    const counted = inputTokensPerCall(3);
    const sent = fakeProvider("anthropic", HAIKU, [answer(validJson())], [counted]);
    expect((await runExtraction({ ...input, pages: 3, primary: sent, fallback: null })).status).toBe("succeeded");
    const refused = fakeProvider("anthropic", HAIKU, [answer(validJson())], [counted]);
    expect((await runExtraction({ ...input, pages: 2, primary: refused, fallback: null })).status).toBe("failed");
    expect(refused.requests).toHaveLength(0);
  });

  it("switches to the fallback when the primary's count gets no answer, and measures the fallback too", async () => {
    const primary = fakeProvider("anthropic", HAIKU, [answer(validJson())], [timedOut("anthropic")]);
    const fallback = fakeProvider("openai", NANO, [answer(validJson(), NANO_SNAPSHOT, 700, 60)], [2700]);
    const outcome = await runExtraction({ ...input, primary, fallback });

    expect(primary.requests).toHaveLength(0);
    expect(fallback.counted).toHaveLength(1);
    expect(outcome).toMatchObject({ status: "succeeded", provider: "openai", attempts: 1, inputTokens: 700 });
  });

  it.each([
    ["a count rejected (400)", new ProviderError("anthropic", "client", "Could not process PDF", 400), "extraction.provider_rejected"],
    ["a count answered with a 429", new ProviderError("anthropic", "client", "rate limited", 429), "extraction.provider_unavailable"],
    ["a count with no usable number", new ProviderError("anthropic", "client", "the token count endpoint returned no usable count"), "unknown"],
  ])("%s sends nothing and doesn't fall back", async (_, failure, code) => {
    const primary = fakeProvider("anthropic", HAIKU, [answer(validJson())], [failure]);
    const fallback = fakeProvider("openai", NANO, [answer(validJson(), NANO_SNAPSHOT)]);
    const outcome = await runExtraction({ ...input, primary, fallback });

    expect(primary.requests).toHaveLength(0);
    expect(fallback.counted).toHaveLength(0);
    expect(outcome).toMatchObject({ status: "failed", provider: null, model: null, attempts: 0, inputTokens: 0 });
    if (outcome.status === "failed") expect(classifyRunError(outcome.error)).toBe(code);
  });

  it.each([
    ["can't be measured", [new ProviderError("openai", "transport", "request timed out")], "its input could not be measured (openai transport: request timed out)"],
    ["measures over the limit", [ONE_PAGE + 1], `its input (${ONE_PAGE + 1} tokens) is over the ${ONE_PAGE} a call may read for 1 page`],
  ] as const)("a fallback that %s isn't used for the run", async (_, counts, why) => {
    const primary = fakeProvider("anthropic", HAIKU, [timedOut("anthropic")]);
    const fallback = fakeProvider("openai", NANO, [answer(validJson(), NANO_SNAPSHOT)], [...counts]);
    const outcome = await runExtraction({ ...input, primary, fallback });

    expect(primary.requests).toHaveLength(1);
    expect(fallback.requests).toHaveLength(0);
    expect(outcome).toMatchObject({ status: "failed", provider: "anthropic", attempts: 1 });
    if (outcome.status === "failed") {
      expect(outcome.error).toBe(`anthropic transport: request timed out; the fallback provider was not used: ${why}`);
      expect(classifyRunError(outcome.error)).toBe("extraction.provider_timeout");
    }
  });

  it("doesn't send a retry that measures over the limit: the run fails with the invalid answer it has", async () => {
    const primary = fakeProvider("anthropic", HAIKU, [answer("{ nope", HAIKU, 1000, 100), answer(validJson())], [ONE_PAGE, ONE_PAGE + 1]);
    const outcome = await runExtraction({ ...input, primary, fallback: null });

    expect(primary.requests).toHaveLength(1);
    expect(primary.counted).toHaveLength(2);
    expect(outcome).toMatchObject({ status: "failed", attempts: 1, inputTokens: 1000, outputTokens: 100, rawResponse: "{ nope" });
    if (outcome.status === "failed") {
      expect(outcome.error).toMatch(/\) failed: the retry was not sent: its input \(7501 tokens\) is over the 7500 a call may read for 1 page$/);
      expect(classifyRunError(outcome.error)).toBe("extraction.invalid_answer");
    }
  });

  it("over every combination of answers, counts before every call and never sends one it didn't count", async () => {
    for (const withFallback of [true, false]) {
      for (const steps of scripts(MAX_CALLS)) {
        const counts: ProviderName[] = [];
        const { calls, primary, fallback } = scripted(steps, withFallback);
        const counting = (provider: typeof primary) => ({
          ...provider,
          countInputTokens: async (request: Parameters<typeof provider.countInputTokens>[0]) => {
            counts.push(provider.name);
            return provider.countInputTokens(request);
          },
        });
        await runExtraction({ ...input, primary: counting(primary), fallback: fallback && counting(fallback) });
        expect(counts, steps.join(", ")).toEqual(calls.map((c) => c.provider));
      }
    }
  });
});

describe("a call that was sent and got no answer", () => {
  it.each([
    ["timed out", timedOut("anthropic")],
    ["lost its connection", new ProviderError("anthropic", "transport", "connection failed")],
    ["threw with no HTTP status", new TypeError("terminated")],
    ["came back with no usage", new ProviderError("anthropic", "client", "the response carried no usage, so its cost is unknown")],
  ])("%s: counts at its measured input plus the output cap, never at 0", async (_, failure) => {
    const primary = fakeProvider("anthropic", HAIKU, [failure], [5321]);
    const outcome = await runExtraction({ ...input, primary, fallback: null });

    expect(primary.requests).toHaveLength(1);
    expect(outcome).toMatchObject({
      status: "failed",
      provider: "anthropic",
      // the model it was sent to: no answer said which served it
      model: HAIKU,
      attempts: 1,
      inputTokens: 5321,
      outputTokens: MAX_OUTPUT_TOKENS,
      costEstimated: true,
    });
  });

  it.each([
    ["a 5xx", serverError("anthropic", 503, "service unavailable")],
    ["a 4xx", new ProviderError("anthropic", "client", "invalid request", 400)],
    ["a 429", new ProviderError("anthropic", "client", "rate limited", 429)],
  ])("%s was refused, not processed: it counts nothing", async (_, failure) => {
    const primary = fakeProvider("anthropic", HAIKU, [failure], [5321]);
    const outcome = await runExtraction({ ...input, primary, fallback: null });
    expect(outcome).toMatchObject({ status: "failed", attempts: 1, inputTokens: 0, outputTokens: 0, costEstimated: false });
  });

  it("prices a run with two models' tokens at the dearer one, whichever went first", async () => {
    // the cheap primary times out, the dear fallback answers
    const primary = fakeProvider("openai", NANO, [timedOut("openai")], [2700]);
    const fallback = fakeProvider("anthropic", HAIKU, [answer(validJson(), HAIKU, 6000, 500)], [6000]);
    const outcome = await runExtraction({ ...input, primary, fallback });
    expect(outcome).toMatchObject({
      status: "succeeded",
      provider: "anthropic",
      model: HAIKU,
      inputTokens: 2700 + 6000,
      outputTokens: MAX_OUTPUT_TOKENS + 500,
      costEstimated: true,
    });
  });

  it("prices two models' tokens at the dearest on file when one of them has no price here", async () => {
    const primary = fakeProvider("anthropic", HAIKU, [timedOut("anthropic")]);
    const fallback = fakeProvider("openai", NANO, [answer(validJson(), "gpt-9-unpriced", 700, 60)]);
    const outcome = await runExtraction({ ...input, primary, fallback });
    const dearest = dearestModelFor(FAKE_COUNT + 700, MAX_OUTPUT_TOKENS + 60);
    expect(outcome).toMatchObject({ status: "succeeded", provider: PRICING[dearest].provider, model: dearest, costEstimated: true });
  });
});

describe("fallback", () => {
  it("a timeout on the primary is answered by the fallback; the timed-out call counts at its most, priced at the dearer model", async () => {
    const primary = fakeProvider("anthropic", HAIKU, [timedOut("anthropic")]);
    const fallback = fakeProvider("openai", NANO, [
      answer(validJson({ title: { value: "Invoice 7", confidence: 0.95 } }), NANO_SNAPSHOT, 700, 60),
    ]);
    const outcome = await runExtraction({ ...input, primary, fallback });

    expect(primary.requests).toHaveLength(1);
    expect(fallback.requests).toHaveLength(1);
    // the fallback is asked exactly what the primary was; nothing is retried
    expect(fallback.requests[0]).toEqual(primary.requests[0]);
    expect(fallback.requests[0].previousAttempt).toBeUndefined();

    // The timed-out call reported nothing, but may have been billed: it
    // counts at its measured input and the output cap, at Haiku's rates.
    // Every token of the run is then priced at the dearer of the two
    // models, Haiku, so the cost is never less than what was spent, and it
    // is marked as an estimate.
    expect(outcome).toMatchObject({
      status: "succeeded",
      provider: "anthropic",
      model: HAIKU,
      attempts: 2,
      inputTokens: FAKE_COUNT + 700,
      outputTokens: MAX_OUTPUT_TOKENS + 60,
      costEstimated: true,
    });
    if (outcome.status === "succeeded") {
      expect(outcome.fields.find((f) => f.name === "title")?.value).toBe("Invoice 7");
    }
  });

  // 529 is Anthropic's "overloaded"; provider-errors.test.ts shows the real
  // SDK reports it as a 5xx
  it.each([500, 502, 503, 529])("a %i on the primary falls back", async (status) => {
    const primary = fakeProvider("anthropic", HAIKU, [serverError("anthropic", status, "overloaded")]);
    const fallback = fakeProvider("openai", NANO, [answer(validJson(), NANO_SNAPSHOT, 700, 60)]);
    const outcome = await runExtraction({ ...input, primary, fallback });

    expect(primary.requests).toHaveLength(1);
    expect(fallback.requests).toHaveLength(1);
    // the 5xx counted nothing: the fallback's answer alone
    expect(outcome).toMatchObject({ status: "succeeded", provider: "openai", attempts: 2, inputTokens: 700, costEstimated: false });
  });

  it.each([
    ["a timeout", timedOut("anthropic"), "anthropic transport: request timed out"],
    ["a 503", serverError("anthropic", 503, "service unavailable"), "anthropic server 503: service unavailable"],
  ])("%s with no fallback configured fails, saying there was none to try", async (_, failure, described) => {
    const primary = fakeProvider("anthropic", HAIKU, [failure]);
    const outcome = await runExtraction({ ...input, primary, fallback: null });

    expect(primary.requests).toHaveLength(1);
    expect(outcome).toMatchObject({ status: "failed", provider: "anthropic", model: HAIKU, attempts: 1, rawResponse: null });
    // a timeout may have been billed, a 503 was not
    const timedOutCall = failure.kind === "transport";
    expect(outcome.inputTokens).toBe(timedOutCall ? FAKE_COUNT : 0);
    expect(outcome.outputTokens).toBe(timedOutCall ? MAX_OUTPUT_TOKENS : 0);
    expect(outcome.costEstimated).toBe(timedOutCall);
    if (outcome.status === "failed") {
      expect(outcome.error).toBe(`${described}; no fallback provider is configured`);
    }
  });

  it.each([
    // a timeout, and a refusal that carries no usage, count at their most
    ["times out", timedOut("openai"), "openai transport: request timed out", true],
    ["returns a 502", serverError("openai", 502, "bad gateway"), "openai server 502: bad gateway", false],
    ["rejects the request", new ProviderError("openai", "client", "invalid request", 400), "openai client 400: invalid request", false],
    [
      "refuses the document",
      new ProviderError("openai", "refusal", "the model declined to process this document"),
      "openai refusal: the model declined to process this document",
      true,
    ],
  ])("when the fallback %s too, the error names both failures", async (_, failure, described, fallbackCounts) => {
    const primary = fakeProvider("anthropic", HAIKU, [timedOut("anthropic")]);
    const fallback = fakeProvider("openai", NANO, [failure]);
    const outcome = await runExtraction({ ...input, primary, fallback });

    expect(primary.requests).toHaveLength(1);
    expect(fallback.requests).toHaveLength(1);
    // the primary's timed-out call counts at its most, and with the
    // fallback's the run is priced at the dearer model, Haiku
    expect(outcome).toMatchObject({
      status: "failed",
      provider: "anthropic",
      model: HAIKU,
      attempts: 2,
      inputTokens: FAKE_COUNT * (fallbackCounts ? 2 : 1),
      outputTokens: MAX_OUTPUT_TOKENS * (fallbackCounts ? 2 : 1),
      costEstimated: true,
      rawResponse: null,
    });
    if (outcome.status === "failed") {
      expect(outcome.error).toBe(`anthropic transport: request timed out; fallback ${described}`);
    }
  });

  it("the fallback is used once per run: a timeout on both ends the run after two calls", async () => {
    // both have a good answer queued behind the timeout; neither is asked again
    const primary = fakeProvider("anthropic", HAIKU, [timedOut("anthropic"), answer(validJson())]);
    const fallback = fakeProvider("openai", NANO, [timedOut("openai"), answer(validJson(), NANO_SNAPSHOT)]);
    const outcome = await runExtraction({ ...input, primary, fallback });

    expect(primary.requests).toHaveLength(1);
    expect(fallback.requests).toHaveLength(1);
    // two calls with no answer, each at its most, priced at Haiku's rates
    expect(outcome).toMatchObject({
      status: "failed",
      provider: "anthropic",
      model: HAIKU,
      attempts: 2,
      inputTokens: 2 * FAKE_COUNT,
      outputTokens: 2 * MAX_OUTPUT_TOKENS,
      costEstimated: true,
    });
    if (outcome.status === "failed") {
      expect(outcome.error).toBe("anthropic transport: request timed out; fallback openai transport: request timed out");
    }
  });

  it.each([
    // refused with an HTTP status: not processed, nothing counted
    ["a 400", new ProviderError("anthropic", "client", "invalid request", 400), false],
    ["a 401", new ProviderError("anthropic", "client", "invalid x-api-key", 401), false],
    // A 429 means our account is over its rate limit or out of quota:
    // something to wait out or fix, not an outage for the other provider to
    // absorb. provider-errors.test.ts has the reasoning in full.
    ["a 429", new ProviderError("anthropic", "client", "rate limited", 429), false],
    // no HTTP status and no usage: it may have been billed, so it counts at
    // its most (interpret.ts attaches usage to a real refusal or truncation)
    ["a refusal", new ProviderError("anthropic", "refusal", "the model declined to process this document"), true],
    ["a truncated answer", new ProviderError("anthropic", "truncated", "the answer exceeded the 2048 output token cap"), true],
    ["a bug in the provider", new TypeError("Cannot read properties of undefined (reading 'content')"), true],
  ])("%s on the primary fails the run without trying the fallback", async (_, failure, countedAtMost) => {
    const primary = fakeProvider("anthropic", HAIKU, [failure]);
    const fallback = fakeProvider("openai", NANO, [answer(validJson(), NANO_SNAPSHOT)]);
    const outcome = await runExtraction({ ...input, primary, fallback });

    expect(primary.requests).toHaveLength(1);
    expect(fallback.requests).toHaveLength(0);
    expect(outcome).toMatchObject({
      status: "failed",
      provider: "anthropic",
      attempts: 1,
      inputTokens: countedAtMost ? FAKE_COUNT : 0,
      outputTokens: countedAtMost ? MAX_OUTPUT_TOKENS : 0,
      costEstimated: countedAtMost,
      rawResponse: null,
    });
    if (outcome.status === "failed") {
      expect(outcome.error).toBe(describeError(failure));
      expect(outcome.error).not.toMatch(/fallback/);
    }
  });
});

describe("validation retry", () => {
  it.each([
    ["an answer that isn't JSON", "not json at all", /^Your previous answer failed validation:\nnot valid JSON/],
    ["JSON that fails the schema", BAD_DATE, /^Your previous answer failed validation:\ndocument_date\.value must be a real date/],
  ])("%s is retried once on the same provider; a second invalid answer fails the run", async (_, first, retryPrompt) => {
    const primary = fakeProvider("anthropic", HAIKU, [
      answer(first, HAIKU, 1000, 100),
      answer('{"document_type": 1}', HAIKU, 1100, 120),
      answer(validJson()),
    ]);
    const fallback = fakeProvider("openai", NANO, [answer(validJson(), NANO_SNAPSHOT)]);
    const outcome = await runExtraction({ ...input, primary, fallback });

    // an invalid answer is not a reason to switch, and there's no third call
    expect(primary.requests).toHaveLength(2);
    expect(fallback.requests).toHaveLength(0);
    // the retry is the same request plus the previous answer and what was
    // wrong with it
    const { previousAttempt, ...retried } = primary.requests[1];
    expect(retried).toEqual(primary.requests[0]);
    expect(previousAttempt?.rawResponse).toBe(first);
    expect(previousAttempt?.retryPrompt).toMatch(retryPrompt);

    // failed cleanly: the last raw answer is kept for review, both calls are
    // paid for
    expect(outcome).toMatchObject({
      status: "failed",
      provider: "anthropic",
      attempts: 2,
      inputTokens: 2100,
      outputTokens: 220,
      rawResponse: '{"document_type": 1}',
    });
    if (outcome.status === "failed") {
      expect(outcome.error).toMatch(/^response failed validation after 1 retry: document_type is missing or not an object/);
    }
  });

  it("an invalid answer then a valid one succeeds, and the invalid one's tokens still count", async () => {
    const primary = fakeProvider("anthropic", HAIKU, [
      answer("{ nope", HAIKU, 1000, 100),
      answer(validJson({ title: { value: "Invoice 9", confidence: 0.95 } }), HAIKU, 1300, 150),
    ]);
    const outcome = await runExtraction({ ...input, primary, fallback: null });

    expect(primary.requests).toHaveLength(2);
    expect(outcome).toMatchObject({
      status: "succeeded",
      provider: "anthropic",
      attempts: 2,
      inputTokens: 2300,
      outputTokens: 250,
    });
    if (outcome.status === "succeeded") {
      expect(outcome.fields.find((f) => f.name === "title")?.value).toBe("Invoice 9");
    }
  });

  it.each([
    ["times out", timedOut("anthropic"), "anthropic transport: request timed out"],
    ["returns a 503", serverError("anthropic", 503, "service unavailable"), "anthropic server 503: service unavailable"],
  ])("a retry that %s fails the run: once a provider has answered, the run never switches", async (_, failure, described) => {
    const timedOutRetry = failure.kind === "transport";
    // the fallback has a good answer ready and is never asked
    const primary = fakeProvider("anthropic", HAIKU, [answer("{ nope", HAIKU, 1000, 100), failure]);
    const fallback = fakeProvider("openai", NANO, [answer(validJson(), NANO_SNAPSHOT, 700, 60)]);
    const outcome = await runExtraction({ ...input, primary, fallback });

    expect(primary.requests).toHaveLength(2);
    expect(fallback.requests).toHaveLength(0);
    // Every token counted is the primary's model's. A retry that timed out
    // counts at its most on top of the first answer; a 503 counts nothing.
    expect(outcome).toMatchObject({
      status: "failed",
      provider: "anthropic",
      model: HAIKU,
      attempts: 2,
      inputTokens: 1000 + (timedOutRetry ? FAKE_COUNT : 0),
      outputTokens: 100 + (timedOutRetry ? MAX_OUTPUT_TOKENS : 0),
      costEstimated: timedOutRetry,
      rawResponse: "{ nope",
    });
    if (outcome.status === "failed") {
      // the validation error that caused the retry, then the retry's failure
      expect(outcome.error.startsWith("retry after invalid response (not valid JSON")).toBe(true);
      expect(outcome.error.endsWith(`) failed: ${described}`)).toBe(true);
    }
  });

  it("after a switch, the retry goes to the fallback, never back to the primary", async () => {
    const primary = fakeProvider("anthropic", HAIKU, [timedOut("anthropic"), answer(validJson())]);
    const fallback = fakeProvider("openai", NANO, [
      answer("{ nope", NANO_SNAPSHOT, 700, 60),
      answer(validJson(), NANO_SNAPSHOT, 800, 70),
    ]);
    const outcome = await runExtraction({ ...input, primary, fallback });

    expect(primary.requests).toHaveLength(1);
    expect(fallback.requests).toHaveLength(2);
    expect(fallback.requests[1].previousAttempt?.rawResponse).toBe("{ nope");
    // the fallback's two answers and the primary's timed-out call at its
    // most, priced at Haiku's rates
    expect(outcome).toMatchObject({
      status: "succeeded",
      provider: "anthropic",
      model: HAIKU,
      attempts: 3,
      inputTokens: FAKE_COUNT + 1500,
      outputTokens: MAX_OUTPUT_TOKENS + 130,
      costEstimated: true,
    });
  });

  it("a timeout on the retry with no fallback configured fails the same way, keeping the invalid answer", async () => {
    const primary = fakeProvider("anthropic", HAIKU, [answer("{ nope", HAIKU, 1000, 100), timedOut("anthropic")]);
    const outcome = await runExtraction({ ...input, primary, fallback: null });

    expect(primary.requests).toHaveLength(2);
    expect(outcome).toMatchObject({
      status: "failed",
      provider: "anthropic",
      attempts: 2,
      inputTokens: 1000 + FAKE_COUNT,
      outputTokens: 100 + MAX_OUTPUT_TOKENS,
      costEstimated: true,
      rawResponse: "{ nope",
    });
    if (outcome.status === "failed") {
      // a fallback wouldn't have been used here, so the error doesn't say
      // one was missing
      expect(outcome.error).toMatch(
        /^retry after invalid response \(not valid JSON \(error at character \d+\)\) failed: anthropic transport: request timed out$/,
      );
    }
  });

  it("a fallback that fails its own retry reports the retry's failure, not the primary's", async () => {
    const primary = fakeProvider("anthropic", HAIKU, [timedOut("anthropic")]);
    const fallback = fakeProvider("openai", NANO, [answer("{ nope", NANO_SNAPSHOT, 700, 60), timedOut("openai")]);
    const outcome = await runExtraction({ ...input, primary, fallback });

    expect(primary.requests).toHaveLength(1);
    expect(fallback.requests).toHaveLength(2);
    // both timed-out calls at their most, the invalid answer as billed, all
    // at Haiku's rates
    expect(outcome).toMatchObject({
      status: "failed",
      provider: "anthropic",
      model: HAIKU,
      attempts: 3,
      inputTokens: FAKE_COUNT + 700 + FAKE_COUNT,
      outputTokens: MAX_OUTPUT_TOKENS + 60 + MAX_OUTPUT_TOKENS,
      costEstimated: true,
      rawResponse: "{ nope",
    });
    if (outcome.status === "failed") {
      // the retry went only to the fallback; the primary's timeout is in the
      // log (extraction.fallback), not presented as part of this failure
      expect(outcome.error).toMatch(/^retry after invalid response \(.+\) failed: openai transport: request timed out$/);
      expect(outcome.error).not.toContain("anthropic");
    }
  });
});

describe("unusable answers", () => {
  // what interpret.ts attaches to a refusal or a truncated answer
  const billed = (model: string, inputTokens: number, outputTokens: number) => ({ model, inputTokens, outputTokens });

  it.each([
    ["a refusal", "refusal" as const, "the model declined to process this document"],
    ["an answer cut off at the output cap", "truncated" as const, "the answer exceeded the 2048 output token cap"],
  ])("%s is billed, so its tokens are counted; the run fails without falling back", async (_, kind, message) => {
    const primary = fakeProvider("anthropic", HAIKU, [
      new ProviderError("anthropic", kind, message, undefined, billed(HAIKU, 50_000, 2048)),
    ]);
    const fallback = fakeProvider("openai", NANO, [answer(validJson(), NANO_SNAPSHOT)]);
    const outcome = await runExtraction({ ...input, primary, fallback });

    expect(fallback.requests).toHaveLength(0);
    expect(outcome).toMatchObject({
      status: "failed",
      provider: "anthropic",
      model: HAIKU,
      attempts: 1,
      inputTokens: 50_000,
      outputTokens: 2048,
      rawResponse: null,
    });
    if (outcome.status === "failed") expect(outcome.error).toBe(`anthropic ${kind}: ${message}`);
  });

  it("any failure that carries usage pins the run to its provider, even one that would otherwise fall back", async () => {
    // No provider reports usage on a 5xx today; if one did, switching would
    // mix two models' tokens in one run, so the orchestrator doesn't.
    const primary = fakeProvider("anthropic", HAIKU, [
      new ProviderError("anthropic", "server", "service unavailable", 503, billed(HAIKU, 3000, 10)),
    ]);
    const fallback = fakeProvider("openai", NANO, [answer(validJson(), NANO_SNAPSHOT)]);
    const outcome = await runExtraction({ ...input, primary, fallback });

    expect(fallback.requests).toHaveLength(0);
    expect(outcome).toMatchObject({ status: "failed", provider: "anthropic", model: HAIKU, inputTokens: 3000, outputTokens: 10 });
    if (outcome.status === "failed") expect(outcome.error).toBe("anthropic server 503: service unavailable");
  });

  it("a truncated retry is counted along with the invalid answer before it", async () => {
    const primary = fakeProvider("anthropic", HAIKU, [
      answer("{ nope", HAIKU, 1000, 100),
      new ProviderError("anthropic", "truncated", "the answer exceeded the 2048 output token cap", undefined, billed(HAIKU, 1100, 2048)),
    ]);
    const outcome = await runExtraction({ ...input, primary, fallback: null });

    expect(outcome).toMatchObject({ status: "failed", attempts: 2, inputTokens: 2100, outputTokens: 2148, rawResponse: "{ nope" });
  });

  it("after a switch, the fallback's unusable answer is counted, with the primary's timed-out call at its most", async () => {
    const primary = fakeProvider("anthropic", HAIKU, [timedOut("anthropic")]);
    const fallback = fakeProvider("openai", NANO, [
      new ProviderError("openai", "truncated", "the answer exceeded the 2048 output token cap", undefined, billed(NANO_SNAPSHOT, 40_000, 2048)),
    ]);
    const outcome = await runExtraction({ ...input, primary, fallback });

    expect(outcome).toMatchObject({
      status: "failed",
      provider: "anthropic",
      model: HAIKU,
      attempts: 2,
      inputTokens: FAKE_COUNT + 40_000,
      outputTokens: MAX_OUTPUT_TOKENS + 2048,
      costEstimated: true,
    });
    if (outcome.status === "failed") {
      expect(outcome.error).toBe(
        "anthropic transport: request timed out; fallback openai truncated: the answer exceeded the 2048 output token cap",
      );
    }
  });
});

describe("bounds", () => {
  it("over every combination of answers, a run makes at most three calls, switches only before an answer and counts every call that may have been billed", async () => {
    let runs = 0;
    let longest = 0;
    for (const withFallback of [true, false]) {
      for (const steps of scripts(MAX_CALLS)) {
        const { calls, primary, fallback } = scripted(steps, withFallback);
        const outcome = await runExtraction({ ...input, primary, fallback });
        const label = `${steps.join(", ")}, ${withFallback ? "with" : "without"} a fallback`;
        runs += 1;
        longest = Math.max(longest, calls.length);

        expect(calls.length, label).toBeLessThanOrEqual(MAX_CALLS);
        expect(outcome.attempts, label).toBe(calls.length);

        // The only switch is from the primary's first call, after a timeout
        // or a 5xx, to the fallback's first call. Once anything is billed
        // the run stays put, so the validation retry never switches.
        for (let i = 1; i < calls.length; i++) {
          if (calls[i].provider !== calls[i - 1].provider) {
            expect(i, label).toBe(1);
            expect(calls[0].provider, label).toBe("anthropic");
            expect(["timeout", "5xx"], label).toContain(calls[0].step);
          }
        }
        if (!withFallback) expect(calls.every((c) => c.provider === "anthropic"), label).toBe(true);

        // Every billed call is counted, valid, invalid or unusable, as the
        // provider reported it; a call that timed out counts at its
        // measured input (the scripted count is 1000 + its index) plus the
        // output cap; a 5xx or 4xx counts nothing.
        const charged = calls.map((c, i) =>
          c.step === "timeout" ? { input: 1000 + i, output: MAX_OUTPUT_TOKENS } : { input: c.inputTokens, output: c.outputTokens },
        );
        expect(outcome.inputTokens, label).toBe(charged.reduce((sum, c) => sum + c.input, 0));
        expect(outcome.outputTokens, label).toBe(charged.reduce((sum, c) => sum + c.output, 0));
        const timedOut = calls.some((c) => c.step === "timeout");
        expect(outcome.costEstimated, label).toBe(timedOut);
        const chargedBy = new Set(calls.filter((_, i) => charged[i].input > 0).map((c) => c.provider));
        if (chargedBy.size === 0) {
          // nothing counted: the provider last called
          expect(outcome.provider, label).toBe(calls[calls.length - 1].provider);
        } else if (chargedBy.size === 1) {
          const [name] = chargedBy;
          expect(outcome.provider, label).toBe(name);
          expect([SERVED[name], name === "anthropic" ? HAIKU : NANO], label).toContain(outcome.model);
        } else {
          // tokens from two models only when the primary's first call got
          // no answer and the fallback took over: all at the dearer's rates
          expect(steps[0], label).toBe("timeout");
          expect(outcome, label).toMatchObject({ provider: "anthropic", model: HAIKU, costEstimated: true });
        }

        // a run succeeds exactly when its last call answered validly
        const last = calls[calls.length - 1];
        expect(outcome.status, label).toBe(last.step === "valid" ? "succeeded" : "failed");
        if (outcome.status === "failed") {
          expect(outcome.error.trim().length, label).toBeGreaterThan(0);
          expect(outcome.error.length, label).toBeLessThanOrEqual(DB_MAX_ERROR_LENGTH);
          // the last answer received, if any, is kept for review
          const answers = calls.flatMap((c) => (c.answer === null ? [] : [c.answer]));
          expect(outcome.rawResponse, label).toBe(answers.length > 0 ? answers[answers.length - 1] : null);
          if (last.answer === null) {
            if (calls.some((c) => c.provider === "openai")) {
              if (calls.length === 2) {
                // the fallback's first call failed too: both failures are named
                expect(outcome.error, label).toMatch(/^anthropic \w+( \d+)?: .+; fallback openai \w+( \d+)?: /);
              } else {
                // a failed retry reports its own failure, on the provider that answered
                expect(outcome.error, label).toMatch(/^retry after invalid response \(.+\) failed: openai \w+( \d+)?: /);
              }
            }
            // "no fallback configured" only where a fallback would have been
            // used: a first call that got no answer
            const wouldHaveSwitched = calls.length === 1 && (last.step === "timeout" || last.step === "5xx");
            expect(outcome.error.endsWith("; no fallback provider is configured"), label).toBe(
              !withFallback && wouldHaveSwitched,
            );
          }
        }

        // the worst case is exactly: primary gets no answer, the fallback
        // answers invalidly, the fallback is retried
        if (calls.length === MAX_CALLS) {
          expect(withFallback, label).toBe(true);
          expect(["timeout", "5xx"], label).toContain(steps[0]);
          expect(["not json", "fails schema"], label).toContain(steps[1]);
          expect(calls.map((c) => c.provider), label).toEqual(["anthropic", "openai", "openai"]);
        }
      }
    }
    expect(runs).toBe(2 * STEPS.length ** MAX_CALLS);
    // the bound is reached, so it is the real worst case, and the database
    // accepts it
    expect(longest).toBe(3);
    expect(longest).toBeLessThanOrEqual(DB_MAX_ATTEMPTS);
  });

  it("the run's error fits the 2000-character column however long the pieces, and keeps the head of each", async () => {
    // 300 unknown keys and ten missing fields: the keys are counted, not
    // named (the validation error never quotes the model), but the error is
    // still longer than one piece may be
    const noisy = JSON.stringify(Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`unknown_field_${i}`, i])));
    // a proxy's HTML error page as the message, several thousand characters
    const page = (status: number) => `<html><body><h1>${status} Bad Gateway</h1>${"<p>upstream error</p>".repeat(300)}</body></html>`;

    // the most outside text in one run: the primary's failure, the
    // fallback's invalid answer, and the fallback's failed retry (the error
    // reports the last two)
    const primary = fakeProvider("anthropic", HAIKU, [serverError("anthropic", 502, page(502))]);
    const fallback = fakeProvider("openai", NANO, [answer(noisy, NANO_SNAPSHOT), serverError("openai", 503, page(503))]);
    const outcome = await runExtraction({ ...input, primary, fallback });

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(noisy.length + page(502).length + page(503).length).toBeGreaterThan(3 * DB_MAX_ERROR_LENGTH);
    expect(outcome.error.length).toBeLessThanOrEqual(DB_MAX_ERROR_LENGTH);
    expect(outcome.error).toMatch(
      /^retry after invalid response \(the object has 300 unexpected keys; .+\.\.\.\) failed: openai server 503: <html><body><h1>503 Bad Gateway<\/h1>.+\.\.\.$/,
    );
    expect(outcome.rawResponse).toBe(noisy);
  });

  it("a long validation error can't push the retry's failure out of the error", async () => {
    const noisy = JSON.stringify(Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`unknown_field_${i}`, i])));
    const primary = fakeProvider("anthropic", HAIKU, [answer(noisy), timedOut("anthropic")]);
    const outcome = await runExtraction({ ...input, primary, fallback: null });

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(outcome.error.length).toBeLessThanOrEqual(DB_MAX_ERROR_LENGTH);
    expect(outcome.error).toMatch(/\.\.\.\) failed: anthropic transport: request timed out$/);
  });
});
