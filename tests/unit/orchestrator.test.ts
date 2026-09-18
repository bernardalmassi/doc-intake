// The orchestrator (run.ts) with fake providers: no network, no keys, no
// database. It proves what the Extract action relies on:
//
//   - a timeout or 5xx on the primary falls back to the other provider, once
//     per run, and the run is recorded as the fallback's
//   - a 4xx, a refusal or a truncated answer on the primary does not fall back
//   - when the fallback fails too, the run's error names both failures; when
//     there is no fallback to try, the error says so
//   - an invalid answer is retried once, on the provider that gave it,
//     carrying the previous answer and the validation error; if that is
//     invalid too the run fails cleanly with the last raw answer kept, and
//     no third call. The retry never switches provider, even on a timeout
//   - every billed call's tokens are summed: valid answers, invalid ones, and
//     refused or truncated ones, whose errors carry their usage; all of them
//     come from one model, the one the database prices the run at
//   - over every combination of answers, a run makes at most three calls
//     (the database accepts four) and its error fits the 2000-character column
//
// That the real SDKs' timeouts and 5xx responses become the fallback-eligible
// errors these fakes throw is proven in provider-errors.test.ts.

import { describe, expect, it } from "vitest";
import { CONFIDENCE_THRESHOLDS, MAX_OUTPUT_TOKENS, MAX_VALIDATION_RETRIES, type ProviderName } from "@/lib/extraction/config";
import type { ExtractionProvider } from "@/lib/extraction/providers/types";
import { describeError, ProviderError } from "@/lib/extraction/providers/types";
import { runExtraction } from "@/lib/extraction/run";
import { answer, fakeProvider, pdfBytes, validJson } from "../helpers/fake-provider";

const HAIKU = "claude-haiku-4-5-20251001";
const NANO = "gpt-5-nano";
const NANO_SNAPSHOT = "gpt-5-nano-2025-08-07";

// extraction_runs.error is checked to at most 2000 characters and attempts
// to between 0 and 4 (supabase/migrations/20260918000001_extraction_runs.sql);
// a close that breaks either is refused and the run is never recorded.
const DB_MAX_ERROR_LENGTH = 2000;
const DB_MAX_ATTEMPTS = 4;

const input = { bytes: pdfBytes("fake"), mimeType: "application/pdf" as const, filename: "fake.pdf" };

const timedOut = (provider: ProviderName) => new ProviderError(provider, "transport", "request timed out");
const serverError = (provider: ProviderName, status: number, message: string) =>
  new ProviderError(provider, "server", message, status);

// a date that doesn't exist, so the answer is JSON but fails the schema
const BAD_DATE = validJson({ document_date: { value: "2026-02-30", confidence: 0.9 } });

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
    expect(outcome).toMatchObject({ status: "succeeded", provider: "openai", attempts: 2, inputTokens: 700 });

    const server = fakeProvider("openai", "gpt-5-nano", [new ProviderError("openai", "server", "bad gateway", 502)]);
    const second = fakeProvider("anthropic", "claude-haiku-4-5-20251001", [answer(validJson())]);
    const outcome2 = await runExtraction({ ...input, primary: server, fallback: second });
    expect(outcome2).toMatchObject({ status: "succeeded", provider: "anthropic", attempts: 2 });
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

describe("fallback", () => {
  it("a timeout on the primary is answered by the fallback, and the run is the fallback's", async () => {
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

    // the provider and served model that answered, and only its tokens: the
    // timed-out call reported none
    expect(outcome).toMatchObject({
      status: "succeeded",
      provider: "openai",
      model: NANO_SNAPSHOT,
      attempts: 2,
      inputTokens: 700,
      outputTokens: 60,
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
    expect(outcome).toMatchObject({ status: "succeeded", provider: "openai", attempts: 2, inputTokens: 700 });
  });

  it.each([
    ["a timeout", timedOut("anthropic"), "anthropic transport: request timed out"],
    ["a 503", serverError("anthropic", 503, "service unavailable"), "anthropic server 503: service unavailable"],
  ])("%s with no fallback configured fails, saying there was none to try", async (_, failure, described) => {
    const primary = fakeProvider("anthropic", HAIKU, [failure]);
    const outcome = await runExtraction({ ...input, primary, fallback: null });

    expect(primary.requests).toHaveLength(1);
    expect(outcome).toMatchObject({ status: "failed", provider: "anthropic", model: HAIKU, attempts: 1, rawResponse: null });
    if (outcome.status === "failed") {
      expect(outcome.error).toBe(`${described}; no fallback provider is configured`);
    }
  });

  it.each([
    ["times out", timedOut("openai"), "openai transport: request timed out"],
    ["returns a 502", serverError("openai", 502, "bad gateway"), "openai server 502: bad gateway"],
    ["rejects the request", new ProviderError("openai", "client", "invalid request", 400), "openai client 400: invalid request"],
    [
      "refuses the document",
      new ProviderError("openai", "refusal", "the model declined to process this document"),
      "openai refusal: the model declined to process this document",
    ],
  ])("when the fallback %s too, the error names both failures", async (_, failure, described) => {
    const primary = fakeProvider("anthropic", HAIKU, [timedOut("anthropic")]);
    const fallback = fakeProvider("openai", NANO, [failure]);
    const outcome = await runExtraction({ ...input, primary, fallback });

    expect(primary.requests).toHaveLength(1);
    expect(fallback.requests).toHaveLength(1);
    // recorded as the fallback's run, the last provider called
    expect(outcome).toMatchObject({ status: "failed", provider: "openai", model: NANO, attempts: 2, rawResponse: null });
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
    expect(outcome).toMatchObject({ status: "failed", provider: "openai", attempts: 2 });
    if (outcome.status === "failed") {
      expect(outcome.error).toBe("anthropic transport: request timed out; fallback openai transport: request timed out");
    }
  });

  it.each([
    ["a 400", new ProviderError("anthropic", "client", "invalid request", 400)],
    ["a 401", new ProviderError("anthropic", "client", "invalid x-api-key", 401)],
    // A 429 means our account is over its rate limit or out of quota:
    // something to wait out or fix, not an outage for the other provider to
    // absorb. provider-errors.test.ts has the reasoning in full.
    ["a 429", new ProviderError("anthropic", "client", "rate limited", 429)],
    ["a refusal", new ProviderError("anthropic", "refusal", "the model declined to process this document")],
    ["a truncated answer", new ProviderError("anthropic", "truncated", "the answer exceeded the 2048 output token cap")],
    ["a bug in the provider", new TypeError("Cannot read properties of undefined (reading 'content')")],
  ])("%s on the primary fails the run without trying the fallback", async (_, failure) => {
    const primary = fakeProvider("anthropic", HAIKU, [failure]);
    const fallback = fakeProvider("openai", NANO, [answer(validJson(), NANO_SNAPSHOT)]);
    const outcome = await runExtraction({ ...input, primary, fallback });

    expect(primary.requests).toHaveLength(1);
    expect(fallback.requests).toHaveLength(0);
    expect(outcome).toMatchObject({ status: "failed", provider: "anthropic", attempts: 1, inputTokens: 0, rawResponse: null });
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
    // the fallback has a good answer ready and is never asked
    const primary = fakeProvider("anthropic", HAIKU, [answer("{ nope", HAIKU, 1000, 100), failure]);
    const fallback = fakeProvider("openai", NANO, [answer(validJson(), NANO_SNAPSHOT, 700, 60)]);
    const outcome = await runExtraction({ ...input, primary, fallback });

    expect(primary.requests).toHaveLength(2);
    expect(fallback.requests).toHaveLength(0);
    // Every token counted is the primary's model's, which is the model
    // close_extraction_run prices the whole run at. Had the retry gone to
    // the fallback, these Haiku tokens would have been priced as gpt-5-nano.
    expect(outcome).toMatchObject({
      status: "failed",
      provider: "anthropic",
      model: HAIKU,
      attempts: 2,
      inputTokens: 1000,
      outputTokens: 100,
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
    expect(outcome).toMatchObject({ status: "succeeded", provider: "openai", attempts: 3, inputTokens: 1500, outputTokens: 130 });
  });

  it("a timeout on the retry with no fallback configured fails the same way, keeping the invalid answer", async () => {
    const primary = fakeProvider("anthropic", HAIKU, [answer("{ nope", HAIKU, 1000, 100), timedOut("anthropic")]);
    const outcome = await runExtraction({ ...input, primary, fallback: null });

    expect(primary.requests).toHaveLength(2);
    expect(outcome).toMatchObject({ status: "failed", provider: "anthropic", attempts: 2, inputTokens: 1000, rawResponse: "{ nope" });
    if (outcome.status === "failed") {
      // a fallback wouldn't have been used here, so the error doesn't say
      // one was missing
      expect(outcome.error).toMatch(
        /^retry after invalid response \(not valid JSON \(error at character \d+\)\) failed: anthropic transport: request timed out$/,
      );
    }
  });

  it("a fallback that fails its own retry is reported after the primary's failure", async () => {
    const primary = fakeProvider("anthropic", HAIKU, [timedOut("anthropic")]);
    const fallback = fakeProvider("openai", NANO, [answer("{ nope", NANO_SNAPSHOT, 700, 60), timedOut("openai")]);
    const outcome = await runExtraction({ ...input, primary, fallback });

    expect(primary.requests).toHaveLength(1);
    expect(fallback.requests).toHaveLength(2);
    expect(outcome).toMatchObject({ status: "failed", provider: "openai", attempts: 3, inputTokens: 700, rawResponse: "{ nope" });
    if (outcome.status === "failed") {
      expect(outcome.error).toMatch(
        /failed: anthropic transport: request timed out; fallback openai transport: request timed out$/,
      );
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

  it("after a switch, the fallback's unusable answer is counted, and the served model recorded", async () => {
    const primary = fakeProvider("anthropic", HAIKU, [timedOut("anthropic")]);
    const fallback = fakeProvider("openai", NANO, [
      new ProviderError("openai", "truncated", "the answer exceeded the 2048 output token cap", undefined, billed(NANO_SNAPSHOT, 40_000, 2048)),
    ]);
    const outcome = await runExtraction({ ...input, primary, fallback });

    expect(outcome).toMatchObject({
      status: "failed",
      provider: "openai",
      model: NANO_SNAPSHOT,
      attempts: 2,
      inputTokens: 40_000,
      outputTokens: 2048,
    });
    if (outcome.status === "failed") {
      expect(outcome.error).toBe(
        "anthropic transport: request timed out; fallback openai truncated: the answer exceeded the 2048 output token cap",
      );
    }
  });
});

describe("bounds", () => {
  // What a provider does on one call: answer (valid or not); answer
  // unusably but billed (refusal, truncated), so the error carries usage;
  // or fail with no answer (timeout, 5xx, 4xx).
  type Step = "valid" | "not json" | "fails schema" | "refusal" | "truncated" | "timeout" | "5xx" | "4xx";
  const STEPS: readonly Step[] = ["valid", "not json", "fails schema", "refusal", "truncated", "timeout", "5xx", "4xx"];
  const ANSWERS: Partial<Record<Step, string>> = { valid: validJson(), "not json": "{ nope", "fails schema": BAD_DATE };
  const BILLED: readonly Step[] = ["valid", "not json", "fails schema", "refusal", "truncated"];
  // the model each fake reports having served, which differs from its
  // configured id for OpenAI, as the real API's does
  const SERVED: Record<ProviderName, string> = { anthropic: HAIKU, openai: NANO_SNAPSHOT };

  // the first call, the validation retries, and one switch to the fallback
  const MAX_CALLS = 1 + MAX_VALIDATION_RETRIES + 1;

  type Call = {
    provider: ProviderName;
    step: Step | undefined;
    // the text returned, or null if the call threw
    answer: string | null;
    inputTokens: number;
    outputTokens: number;
  };

  // Both providers read one shared script, so the nth call gets the nth
  // step whichever provider makes it. A call past the end of the script is
  // recorded and then fails, so an extra call shows up in the count.
  function scripted(steps: readonly Step[], withFallback: boolean) {
    const calls: Call[] = [];
    const make = (name: ProviderName, model: string): ExtractionProvider => ({
      name,
      model,
      async extract() {
        const n = calls.length;
        const step: Step | undefined = steps[n];
        const text = (step !== undefined && ANSWERS[step]) || null;
        // distinct counts per call, so a wrong sum can't match by chance
        const usage =
          step !== undefined && BILLED.includes(step)
            ? { inputTokens: 1000 + n, outputTokens: 100 + n, model: SERVED[name] }
            : { inputTokens: 0, outputTokens: 0, model: SERVED[name] };
        calls.push({ provider: name, step, answer: text, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
        switch (step) {
          case undefined:
            throw new Error(`unexpected call ${n + 1}`);
          case "refusal":
            throw new ProviderError(name, "refusal", "the model declined to process this document", undefined, usage);
          case "truncated":
            throw new ProviderError(name, "truncated", "the answer exceeded the 2048 output token cap", undefined, usage);
          case "timeout":
            throw new ProviderError(name, "transport", "request timed out");
          case "5xx":
            throw new ProviderError(name, "server", "service unavailable", 503);
          case "4xx":
            throw new ProviderError(name, "client", "invalid request", 400);
          default:
            return { text: text ?? "", ...usage };
        }
      },
    });
    return { calls, primary: make("anthropic", HAIKU), fallback: withFallback ? make("openai", NANO) : null };
  }

  function* scripts(length: number): Generator<Step[]> {
    if (length === 0) {
      yield [];
      return;
    }
    for (const head of scripts(length - 1)) {
      for (const step of STEPS) yield [...head, step];
    }
  }

  it("over every combination of answers, a run makes at most three calls, switches only before an answer and counts every token against one model", async () => {
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

        // every billed call is counted, valid, invalid or unusable, and all
        // of them come from one provider, whose served model is recorded
        expect(outcome.inputTokens, label).toBe(calls.reduce((sum, c) => sum + c.inputTokens, 0));
        expect(outcome.outputTokens, label).toBe(calls.reduce((sum, c) => sum + c.outputTokens, 0));
        const billedBy = new Set(calls.filter((c) => c.inputTokens > 0).map((c) => c.provider));
        expect(billedBy.size, label).toBeLessThanOrEqual(1);
        for (const name of billedBy) {
          expect(outcome.provider, label).toBe(name);
          expect(outcome.model, label).toBe(SERVED[name]);
        }
        expect(outcome.provider, label).toBe(calls[calls.length - 1].provider);

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
            // after a switch, the error names both providers' failures
            if (calls.some((c) => c.provider === "openai")) {
              expect(outcome.error, label).toMatch(/anthropic \w+( \d+)?: .+; fallback openai \w+( \d+)?: /);
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

    // the longest error there is: the primary's failure, the fallback's
    // invalid answer, and the fallback's failed retry
    const primary = fakeProvider("anthropic", HAIKU, [serverError("anthropic", 502, page(502))]);
    const fallback = fakeProvider("openai", NANO, [answer(noisy, NANO_SNAPSHOT), serverError("openai", 503, page(503))]);
    const outcome = await runExtraction({ ...input, primary, fallback });

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(noisy.length + page(502).length + page(503).length).toBeGreaterThan(3 * DB_MAX_ERROR_LENGTH);
    expect(outcome.error.length).toBeLessThanOrEqual(DB_MAX_ERROR_LENGTH);
    expect(outcome.error).toMatch(
      /^retry after invalid response \(the object has 300 unexpected keys; .+\.\.\.\) failed: anthropic server 502: <html><body><h1>502 Bad Gateway<\/h1>.+\.\.\.; fallback openai server 503: <html><body><h1>503 Bad Gateway<\/h1>.+\.\.\.$/,
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
