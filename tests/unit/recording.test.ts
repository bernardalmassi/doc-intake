// Record and replay (evals/recording.ts), driven by a fake provider: a
// recording replays to the same outcome, any change to the request makes it
// stale, and the live budget refuses calls past its caps before they are
// made. No model, no database, no files written.

import { describe, expect, it } from "vitest";
import { computeCostUsd, DEFAULT_MODELS, MAX_OUTPUT_TOKENS } from "@/lib/extraction/config";
import {
  type ExtractionProvider,
  type ExtractionRequest,
  ProviderError,
  type ProviderResponse,
  type ProviderUsage,
} from "@/lib/extraction/providers/types";
import { runExtraction } from "@/lib/extraction/run";
import { buildJsonSchema, FIELD_NAMES, SYSTEM_PROMPT, userPrompt } from "@/lib/extraction/schema";
import {
  BudgetExceededError,
  CallBudget,
  endedAbnormally,
  fingerprintRequest,
  parseRecording,
  recordingProvider,
  replayProvider,
  serializeRecording,
  StaleRecordingError,
  toRecording,
} from "../../evals/recording";

const pdf = new TextEncoder().encode("%PDF-1.4\n% recording test\n%%EOF\n");

function answer(overrides: Record<string, string> = {}): string {
  return JSON.stringify(
    Object.fromEntries(
      FIELD_NAMES.map((name) => [
        name,
        { value: overrides[name] ?? "", confidence: 0.9, source_text: overrides[name] ?? "", clarifying_question: "" },
      ]),
    ),
  );
}

function fake(answers: (string | ProviderError)[]): ExtractionProvider & { requests: ExtractionRequest[] } {
  const requests: ExtractionRequest[] = [];
  return {
    name: "anthropic",
    model: DEFAULT_MODELS.anthropic,
    requests,
    async countInputTokens() {
      return 1000;
    },
    async extract(request): Promise<ProviderResponse> {
      requests.push(request);
      const next = answers.shift();
      if (next === undefined) throw new Error("fake has no answer left");
      if (next instanceof ProviderError) throw next;
      return { text: next, inputTokens: 5000, outputTokens: 400, model: DEFAULT_MODELS.anthropic };
    },
  };
}

function budget(maxCalls = 10, maxUsd = 0.5) {
  return new CallBudget(maxCalls, maxUsd, (model) => computeCostUsd(model, 20_000, MAX_OUTPUT_TOKENS));
}

const cost = (u: ProviderUsage) => computeCostUsd(u.model, u.inputTokens, u.outputTokens);

async function record(answers: (string | ProviderError)[], bytes = pdf) {
  const recorder = recordingProvider(fake(answers), budget(), cost, () => 0);
  const outcome = await runExtraction({ bytes, mimeType: "application/pdf", pages: 1, filename: "x.pdf", primary: recorder, fallback: null });
  const recording = parseRecording(serializeRecording(toRecording("unit", recorder, new Date(0))), "unit");
  return { outcome, recording };
}

async function replay(recording: ReturnType<typeof parseRecording>, bytes = pdf) {
  const provider = replayProvider(recording);
  const outcome = await runExtraction({ bytes, mimeType: "application/pdf", pages: 1, filename: "x.pdf", primary: provider, fallback: null });
  return { outcome, provider };
}

describe("record and replay", () => {
  it("a recording replays to the same outcome, retry included", async () => {
    const recorded = await record(["not json", answer({ title: "Invoice 42", total_amount: "42.00" })]);
    expect(recorded.recording.calls).toHaveLength(2);
    expect(recorded.recording).toMatchObject({
      provider: "anthropic",
      requestedModel: DEFAULT_MODELS.anthropic,
      reportedModel: DEFAULT_MODELS.anthropic,
    });

    const replayed = await replay(recorded.recording);
    replayed.provider.assertComplete();
    const strip = <T extends { latencyMs: number }>(o: T) => ({ ...o, latencyMs: 0 });
    expect(strip(replayed.outcome)).toEqual(strip(recorded.outcome));
    expect(replayed.outcome.status).toBe("succeeded");
  });

  it("a recorded provider error replays as the same error", async () => {
    const recorded = await record([new ProviderError("anthropic", "server", "overloaded", 529)]);
    expect(recorded.recording.calls[0].error).toEqual({ kind: "server", status: 529, message: "overloaded", usage: null });
    const replayed = await replay(recorded.recording);
    replayed.provider.assertComplete();
    expect(replayed.outcome).toMatchObject({ status: "failed", error: expect.stringMatching(/anthropic server 529/) });
  });

  it("a billed refusal keeps its usage through record and replay", async () => {
    const usage = { inputTokens: 5000, outputTokens: 12, model: DEFAULT_MODELS.anthropic };
    const recorded = await record([new ProviderError("anthropic", "refusal", "declined", undefined, usage)]);
    expect(recorded.recording.calls[0].error?.usage).toEqual(usage);
    const replayed = await replay(recorded.recording);
    replayed.provider.assertComplete();
    expect(replayed.outcome).toMatchObject({ status: "failed", inputTokens: 5000, outputTokens: 12 });
    expect(replayed.outcome.inputTokens).toBe(recorded.outcome.inputTokens);
  });

  it("a different document is stale, and says which part changed", async () => {
    const { recording } = await record([answer()]);
    const replayed = await replay(recording, new TextEncoder().encode("%PDF-1.4\n% another file\n%%EOF\n"));
    expect(replayed.outcome.status).toBe("failed");
    expect(() => replayed.provider.assertComplete()).toThrow(StaleRecordingError);
    expect(() => replayed.provider.assertComplete()).toThrow(/fixture document.*npm run eval -- --live/);
  });

  it("a changed prompt, schema or cap is stale", async () => {
    const { recording } = await record([answer()]);
    const request: ExtractionRequest = {
      bytes: pdf,
      mimeType: "application/pdf",
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: userPrompt(),
      schema: buildJsonSchema(),
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    };
    // the unchanged request is accepted
    await expect(replayProvider(recording).extract(request)).resolves.toBeDefined();
    const changes: [Partial<ExtractionRequest>, RegExp][] = [
      [{ systemPrompt: `${SYSTEM_PROMPT} ` }, /system prompt/],
      [{ userPrompt: "Extract the fields." }, /user prompt/],
      [{ schema: { ...buildJsonSchema(), required: [] } }, /output schema/],
      [{ maxOutputTokens: MAX_OUTPUT_TOKENS + 1 }, /output token cap/],
      [{ previousAttempt: { rawResponse: "{}", retryPrompt: "again" } }, /retry turn/],
    ];
    for (const [change, message] of changes) {
      await expect(replayProvider(recording).extract({ ...request, ...change })).rejects.toThrow(message);
    }
  });

  it("the fingerprint ignores key order in the schema but not the model", () => {
    const request: ExtractionRequest = {
      bytes: pdf,
      mimeType: "application/pdf",
      systemPrompt: "s",
      userPrompt: "u",
      schema: { a: 1, b: { c: 2, d: 3 } },
      maxOutputTokens: 10,
    };
    const reordered = { ...request, schema: { b: { d: 3, c: 2 }, a: 1 } };
    expect(fingerprintRequest("openai", "gpt-5-nano", request).hash).toBe(
      fingerprintRequest("openai", "gpt-5-nano", reordered).hash,
    );
    expect(fingerprintRequest("openai", "gpt-5-nano", request).hash).not.toBe(
      fingerprintRequest("openai", "gpt-5-mini", request).hash,
    );
  });

  it("more or fewer calls than recorded is stale", async () => {
    const { recording } = await record([answer()]);
    const short = { ...recording, calls: [] };
    const replayedShort = await replay(short);
    expect(() => replayedShort.provider.assertComplete()).toThrow(/only 0 were recorded/);

    const long = { ...recording, calls: [...recording.calls, ...recording.calls] };
    const replayedLong = await replay(long);
    expect(() => replayedLong.provider.assertComplete()).toThrow(/made 1 calls but 2 were recorded/);
  });

  it("a run that ended on a timeout, 5xx, refusal or truncation is due for re-recording", async () => {
    const good = await record([answer()]);
    expect(endedAbnormally(good.recording)).toBe(false);
    for (const kind of ["transport", "server", "refusal", "truncated"] as const) {
      const bad = await record([new ProviderError("anthropic", kind, "x")]);
      expect(endedAbnormally(bad.recording), kind).toBe(true);
    }
    // a 4xx is the request's fault and would fail the same way again
    expect(endedAbnormally((await record([new ProviderError("anthropic", "client", "bad", 400)])).recording)).toBe(false);
  });

  it("a malformed recording is refused", () => {
    expect(() => parseRecording("{}", "x")).toThrow(StaleRecordingError);
    expect(() => parseRecording(JSON.stringify({ version: 1, calls: [{ fingerprint: { hash: "h" }, response: null, error: null }] }), "x")).toThrow(
      /neither or both/,
    );
  });
});

describe("the live budget", () => {
  it("refuses the call past the call cap, before it is made", async () => {
    const inner = fake([answer(), answer()]);
    const capped = budget(1);
    const recorder = recordingProvider(inner, capped, cost);
    const request: ExtractionRequest = {
      bytes: pdf,
      mimeType: "application/pdf",
      systemPrompt: "s",
      userPrompt: "u",
      schema: {},
      maxOutputTokens: 10,
    };
    await recorder.extract(request);
    await expect(recorder.extract(request)).rejects.toThrow(BudgetExceededError);
    expect(inner.requests).toHaveLength(1);
    expect(capped.exceeded).toBeInstanceOf(BudgetExceededError);
  });

  it("refuses a call that could take the spend past the cost cap", () => {
    const worst = computeCostUsd("claude-haiku-4-5-20251001", 20_000, MAX_OUTPUT_TOKENS);
    const tight = budget(100, worst * 2.5);
    tight.reserve("claude-haiku-4-5-20251001");
    tight.spend(worst);
    tight.reserve("claude-haiku-4-5-20251001");
    tight.spend(worst);
    // 2 x worst spent, a third worst-case call would pass 2.5 x worst
    expect(() => tight.reserve("claude-haiku-4-5-20251001")).toThrow(/cost cap/);
    expect(tight.calls).toBe(2);
  });

  it("charges a call that got no answer at its measured input and the output cap, and one refused with a status at 0", async () => {
    const b = budget();
    const recorder = recordingProvider(
      fake([new ProviderError("anthropic", "transport", "request timed out")]),
      b,
      cost,
      () => 0,
    );
    await runExtraction({ bytes: pdf, mimeType: "application/pdf", pages: 1, primary: recorder, fallback: null });
    // the fake's count is 1000 (the object literal above)
    expect(b.spentUsd).toBe(computeCostUsd(DEFAULT_MODELS.anthropic, 1000, MAX_OUTPUT_TOKENS));
    expect(recorder.calls).toHaveLength(1);

    const refused = budget();
    const rejecting = recordingProvider(fake([new ProviderError("anthropic", "client", "invalid request", 400)]), refused, cost, () => 0);
    await runExtraction({ bytes: pdf, mimeType: "application/pdf", pages: 1, primary: rejecting, fallback: null });
    expect(refused.spentUsd).toBe(0);
  });

  it("fails closed when the served model can't be priced: the pass aborts, nothing is free", async () => {
    // the provider answers, but reports a model the price table doesn't know
    const inner: ExtractionProvider = {
      name: "anthropic",
      model: DEFAULT_MODELS.anthropic,
      async countInputTokens() {
        return 1000;
      },
      async extract() {
        return { text: answer(), inputTokens: 5000, outputTokens: 400, model: "claude-unpriced-9" };
      },
    };
    const b = budget();
    const recorder = recordingProvider(inner, b, cost);
    const outcome = await runExtraction({ bytes: pdf, mimeType: "application/pdf", pages: 1, filename: "x.pdf", primary: recorder, fallback: null });
    // runExtraction reports it as a failed run; the live runner checks the
    // budget after every run and stops on this
    expect(outcome.status).toBe("failed");
    expect(b.exceeded).toBeInstanceOf(BudgetExceededError);
    expect(b.exceeded?.message).toMatch(/cannot price claude-unpriced-9/);
    expect(recorder.calls).toHaveLength(0);
    expect(() => b.reserve("claude-haiku-4-5-20251001")).toThrow(BudgetExceededError);
  });

  it("fails closed when the requested model can't be priced before the call", async () => {
    const inner = fake([answer()]);
    const b = budget();
    await expect(
      recordingProvider({ ...inner, model: "no-such-model", extract: inner.extract }, b, cost).extract({
        bytes: pdf,
        mimeType: "application/pdf",
        systemPrompt: "s",
        userPrompt: "u",
        schema: {},
        maxOutputTokens: 10,
      }),
    ).rejects.toThrow(/cannot estimate the cost of a call to no-such-model/);
    expect(inner.requests).toHaveLength(0);
    expect(b.exceeded).toBeInstanceOf(BudgetExceededError);
  });

  it("marks the budget exceeded when a real call costs more than the cap", () => {
    const small = budget(10, 0.01);
    small.spend(0.02);
    expect(small.exceeded).toBeInstanceOf(BudgetExceededError);
    expect(() => small.reserve("gpt-5-nano")).toThrow(BudgetExceededError);
  });
});
