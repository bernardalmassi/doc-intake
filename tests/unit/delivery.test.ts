// The worker's delivery of one claimed run (src/lib/extraction/delivery.ts)
// with fakes: no network, no keys, no database. It proves what the worker
// relies on (docs/worker-design.md, section 10):
//
//   - a download failure, or one that outlasts its time limit (aborted
//     then), a magic-byte mismatch, pages that can't be
//     counted, more than 100 pages, and a count other than the one the run
//     was enqueued with each finish the run as failed with no provider
//     built or called: no model, 0 tokens, so 0 USD
//   - a clean preflight makes exactly the calls runExtraction makes on its
//     own, over every combination of answers (the matrix in
//     orchestrator.test.ts), so at most three
//   - a finish that gets no answer, or a transient refusal, is sent again
//     unchanged with doubling waits until the invocation's deadline, each
//     attempt with its own time limit: a paid result is never replaced by a
//     blip
//   - only a definite refusal repeats the finish as failedCloseAttempts
//     plans it: the failure with the run's usage, then at the dearest price
//     on file marked estimated; a 42501 after a lost answer stops there

import { describe, expect, it, vi } from "vitest";
import { buildPdf } from "../../evals/pdf";
import { classifyRunError, isCostEstimated } from "@/lib/errors";
import {
  dearestModelFor,
  DOWNLOAD_TIMEOUT_MS,
  EXTRACTION_LIMITS,
  FINISH_ATTEMPT_TIMEOUT_MS,
  FINISH_MIN_ATTEMPT_MS,
  FINISH_RETRY_FIRST_DELAY_MS,
  FINISH_RETRY_MAX_DELAY_MS,
  inputTokensPerCall,
  largestCountWithin,
  MAX_OUTPUT_TOKENS,
  PRICING,
  withCountMargin,
} from "@/lib/extraction/config";
import { deliver, isTransientFinishRefusal, preflight, type ClaimedRun, type DownloadedFile, type Finish, type ProviderPair } from "@/lib/extraction/delivery";
import { ProviderError } from "@/lib/extraction/providers/types";
import { runExtraction, toFinishParams } from "@/lib/extraction/run";
import { log } from "@/lib/log";
import { answer, fakeProvider, pdfBytes, validJson } from "../helpers/fake-provider";
import { MAX_CALLS, scripted, scripts } from "../helpers/scripted-providers";

const onePage = buildPdf([[{ kind: "text", x: 72, y: 720, text: "Invoice 1" }]]);
const pages = (n: number) => buildPdf(Array.from({ length: n }, (_, i) => [{ kind: "text", x: 72, y: 720, text: `Page ${i + 1}` }]));
// the PNG signature and nothing else: an image is one page
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

const RUN: ClaimedRun = {
  runId: "11111111-1111-4111-8111-111111111111",
  claimToken: "22222222-2222-4222-8222-222222222222",
  tenantId: "33333333-3333-4333-8333-333333333333",
  documentId: "44444444-4444-4444-8444-444444444444",
  mimeType: "application/pdf",
  pageCount: 1,
};

type FinishParams = ReturnType<typeof toFinishParams>;

// a deadline that no test reaches unless it means to
const FAR = Date.now() + 3_600_000;

// Records every finish and answers with the refusals given, in order, then
// accepts.
function finisher(refusals: (ReturnType<Finish> extends Promise<infer R> ? R | "throw" : never)[] = []) {
  const calls: FinishParams[] = [];
  const finish: Finish = async (params) => {
    calls.push(params);
    const next = refusals.shift();
    if (next === "throw") throw new TypeError("fetch failed");
    return next ?? null;
  };
  return { calls, finish };
}

// Providers that must never be built: a preflight failure stops before them.
const noProviders = (): ProviderPair => {
  throw new Error("providers were built for a run that failed its preflight");
};

function file(bytes: Uint8Array): () => Promise<DownloadedFile> {
  return async () => ({ ok: true, bytes });
}

describe("the preflight", () => {
  it.each([
    ["the download fails", { ok: false, reason: "download.not_found" }, RUN, "extraction.download_failed"],
    ["the bytes aren't a PDF", { ok: true, bytes: new TextEncoder().encode("hello, not a PDF") }, RUN, "extraction.file_type_mismatch"],
    ["a PDF declared as a PNG", { ok: true, bytes: onePage }, { ...RUN, mimeType: "image/png" }, "extraction.file_type_mismatch"],
    ["no declared type", { ok: true, bytes: onePage }, { ...RUN, mimeType: null }, "extraction.file_type_mismatch"],
    ["a PDF whose pages can't be counted", { ok: true, bytes: pdfBytes("no page tree") }, RUN, "document.pages_unreadable"],
    [
      "a PDF with no pages",
      {
        ok: true,
        bytes: new TextEncoder().encode(
          "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\ntrailer << /Root 1 0 R >>\n%%EOF\n",
        ),
      },
      RUN,
      "document.no_pages",
    ],
    [
      "more pages than the limit",
      { ok: true, bytes: pages(EXTRACTION_LIMITS.maxPagesPerDocument + 1) },
      { ...RUN, pageCount: EXTRACTION_LIMITS.maxPagesPerDocument },
      "document.too_many_pages",
    ],
    ["a count other than the enqueued one", { ok: true, bytes: onePage }, { ...RUN, pageCount: 2 }, "extraction.page_count_mismatch"],
    ["a run enqueued with no count", { ok: true, bytes: onePage }, { ...RUN, pageCount: null }, "extraction.page_count_mismatch"],
  ] as const)("fails the run with no provider call when %s", async (_label, downloaded, run, code) => {
    const { calls, finish } = finisher();
    const result = await deliver({ run, download: async () => downloaded, providers: noProviders, finish, log, deadline: FAR });

    expect(result.outcome).toMatchObject({ status: "failed", provider: null, model: null, attempts: 0, inputTokens: 0, outputTokens: 0 });
    expect(result.outcome.status === "failed" && classifyRunError(result.outcome.error)).toBe(code);
    expect(result.recorded).toBe(result.outcome);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      p_run_id: run.runId,
      p_claim_token: run.claimToken,
      p_status: "failed",
      p_provider: null,
      p_model: null,
      p_input_tokens: 0,
      p_output_tokens: 0,
      p_attempts: 0,
      p_cost_estimated: false,
      p_fields: null,
    });
  });

  it("passes a document whose type and page count are what the run says", async () => {
    expect(await preflight({ ok: true, bytes: onePage }, RUN)).toMatchObject({ ok: true, mimeType: "application/pdf", pages: 1 });
    expect(await preflight({ ok: true, bytes: pages(3) }, { ...RUN, pageCount: 3 })).toMatchObject({ ok: true, pages: 3 });
    const max = EXTRACTION_LIMITS.maxPagesPerDocument;
    expect(await preflight({ ok: true, bytes: pages(max) }, { ...RUN, pageCount: max })).toMatchObject({ ok: true, pages: max });
    expect(await preflight({ ok: true, bytes: png }, { ...RUN, mimeType: "image/png" })).toMatchObject({ ok: true, mimeType: "image/png", pages: 1 });
  });

  it("builds the providers only once the preflight has passed, and sends no filename", async () => {
    let built = 0;
    const primary = fakeProvider("openai", "gpt-5-nano", [answer(validJson(), "gpt-5-nano-2025-08-07")]);
    const { calls, finish } = finisher();
    const result = await deliver({
      run: RUN,
      download: file(onePage),
      providers: () => {
        built += 1;
        return { primary, fallback: null };
      },
      finish,
      log,
      deadline: FAR,
    });
    expect(built).toBe(1);
    expect(result.outcome.status).toBe("succeeded");
    expect(primary.requests).toHaveLength(1);
    expect(Object.keys(primary.requests[0])).not.toContain("filename");
    expect(calls[0]).toMatchObject({ p_status: "succeeded", p_model: "gpt-5-nano-2025-08-07", p_cost_estimated: false });
  });

  it("fails the run, not the worker, when the providers can't be built", async () => {
    const { calls, finish } = finisher();
    const result = await deliver({
      run: RUN,
      download: file(onePage),
      providers: () => {
        throw new Error("extraction is not configured: ANTHROPIC_API_KEY is not set");
      },
      finish,
      log,
      deadline: FAR,
    });
    expect(result.outcome.status === "failed" && classifyRunError(result.outcome.error)).toBe("extraction.not_configured");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ p_status: "failed", p_model: null, p_attempts: 0 });
  });
});

describe("the download", () => {
  it("that outlasts its time limit fails the run at 0 with no provider built, and is aborted", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const { calls, finish } = finisher();
      const delivering = deliver({
        run: RUN,
        // never answers until it is aborted, and not even then
        download: (s) => {
          signal = s;
          return new Promise<DownloadedFile>(() => {});
        },
        providers: noProviders,
        finish,
        log,
        deadline: Date.now() + 3_600_000,
      });
      await vi.advanceTimersByTimeAsync(DOWNLOAD_TIMEOUT_MS - 1);
      expect(calls).toHaveLength(0);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const result = await delivering;

      expect(signal?.aborted).toBe(true);
      expect(result.outcome).toMatchObject({ status: "failed", provider: null, model: null, attempts: 0, inputTokens: 0, outputTokens: 0 });
      expect(result.outcome.status === "failed" && result.outcome.error).toBe(`could not download the file: timed out after ${DOWNLOAD_TIMEOUT_MS / 1000} s`);
      expect(result.outcome.status === "failed" && classifyRunError(result.outcome.error)).toBe("extraction.download_failed");
      expect(calls).toEqual([expect.objectContaining({ p_status: "failed", p_model: null, p_input_tokens: 0, p_cost_estimated: false })]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("that finishes inside its time limit goes on to the preflight and the model", async () => {
    vi.useFakeTimers();
    try {
      const primary = fakeProvider("openai", "gpt-5-nano", [answer(validJson(), "gpt-5-nano-2025-08-07")]);
      const { calls, finish } = finisher();
      const delivering = deliver({
        run: RUN,
        download: () => new Promise<DownloadedFile>((resolve) => setTimeout(() => resolve({ ok: true, bytes: onePage }), DOWNLOAD_TIMEOUT_MS - 1)),
        providers: () => ({ primary, fallback: null }),
        finish,
        log,
        deadline: Date.now() + 3_600_000,
      });
      await vi.advanceTimersByTimeAsync(DOWNLOAD_TIMEOUT_MS);
      await delivering;
      expect(primary.requests).toHaveLength(1);
      expect(calls[0]).toMatchObject({ p_status: "succeeded" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the per-call input limit", () => {
  it("is the one for the pages the worker counted: a call at it is sent, one over it isn't, and the run fails at 0", async () => {
    // the largest count whose margin fits the limit is sent, one more isn't
    const limit = largestCountWithin(inputTokensPerCall(3));
    const sent = fakeProvider("openai", "gpt-5-nano", [answer(validJson(), "gpt-5-nano-2025-08-07")], [limit]);
    const ok = finisher();
    const run = { ...RUN, pageCount: 3 };
    await deliver({ run, download: file(pages(3)), providers: () => ({ primary: sent, fallback: null }), finish: ok.finish, log, deadline: FAR });
    expect(sent.requests).toHaveLength(1);
    expect(ok.calls[0]).toMatchObject({ p_status: "succeeded" });

    const dense = fakeProvider("openai", "gpt-5-nano", [answer(validJson(), "gpt-5-nano-2025-08-07")], [limit + 1]);
    const refused = finisher();
    const result = await deliver({ run, download: file(pages(3)), providers: () => ({ primary: dense, fallback: null }), finish: refused.finish, log, deadline: FAR });
    expect(dense.requests).toHaveLength(0);
    expect(result.outcome.status === "failed" && classifyRunError(result.outcome.error)).toBe("extraction.too_dense");
    expect(refused.calls[0]).toMatchObject({ p_status: "failed", p_provider: null, p_model: null, p_attempts: 0, p_input_tokens: 0, p_output_tokens: 0 });
  });
});

describe("a call that got no answer", () => {
  it("is finished at its measured input with the count's margin plus the output cap, marked estimated, and stays so if the finish is refused", async () => {
    const primary = fakeProvider("anthropic", "claude-sonnet-5", [new ProviderError("anthropic", "transport", "request timed out")], [4321]);
    const { calls, finish } = finisher([{ code: "22023" }]);
    await deliver({ run: RUN, download: file(onePage), providers: () => ({ primary, fallback: null }), finish, log, deadline: FAR });

    const expected = {
      p_status: "failed",
      p_provider: "anthropic",
      p_model: "claude-sonnet-5",
      p_attempts: 1,
      p_input_tokens: withCountMargin(4321),
      p_output_tokens: MAX_OUTPUT_TOKENS,
      p_cost_estimated: true,
    };
    expect(calls[0]).toMatchObject(expected);
    // the refused finish is repeated with the same usage, still an estimate
    expect(calls[1]).toMatchObject(expected);
  });
});

describe("a clean preflight", () => {
  it("makes exactly the calls runExtraction makes on its own, over every combination of answers", async () => {
    let runs = 0;
    for (const withFallback of [true, false]) {
      for (const steps of scripts(MAX_CALLS)) {
        const label = `${steps.join(", ")}, ${withFallback ? "with" : "without"} a fallback`;
        const alone = scripted(steps, withFallback);
        const expected = await runExtraction({ bytes: onePage, mimeType: "application/pdf", pages: 1, primary: alone.primary, fallback: alone.fallback });

        const delivered = scripted(steps, withFallback);
        const { calls: finishes, finish } = finisher();
        const result = await deliver({
          run: RUN,
          download: file(onePage),
          providers: () => ({ primary: delivered.primary, fallback: delivered.fallback }),
          finish,
          log,
          deadline: FAR,
        });
        runs += 1;

        expect(delivered.calls, label).toEqual(alone.calls);
        expect(delivered.calls.length, label).toBeLessThanOrEqual(MAX_CALLS);
        // the same outcome, whatever the clock said
        expect({ ...result.outcome, latencyMs: 0 }, label).toEqual({ ...expected, latencyMs: 0 });
        // one finish, with what the run did
        expect(finishes, label).toHaveLength(1);
        expect(finishes[0].p_attempts, label).toBe(delivered.calls.length);
        expect(finishes[0].p_input_tokens, label).toBe(expected.inputTokens);
      }
    }
    expect(runs).toBe(2 * 8 ** MAX_CALLS);
  });
});

describe("a refused finish", () => {
  const priced = () => fakeProvider("openai", "gpt-5-nano", [answer(validJson(), "gpt-5-nano-2025-08-07", 1000, 100)]);

  it("repeats only the finish: the same run as failed with its usage, never another model call", async () => {
    const primary = priced();
    const { calls, finish } = finisher([{ code: "22023", status: 400 }]);
    const result = await deliver({ run: RUN, download: file(onePage), providers: () => ({ primary, fallback: null }), finish, log, deadline: FAR });

    expect(primary.requests).toHaveLength(1);
    expect(result.finishCalls).toBe(2);
    expect(calls[0]).toMatchObject({ p_status: "succeeded" });
    expect(calls[1]).toMatchObject({
      p_status: "failed",
      p_model: "gpt-5-nano-2025-08-07",
      p_input_tokens: 1000,
      p_output_tokens: 100,
      p_cost_estimated: false,
      p_fields: null,
    });
    expect(classifyRunError(calls[1].p_error)).toBe("extraction.result_not_saved");
    expect(result.recorded).toMatchObject({ status: "failed" });
  });

  it("then at the dearest price on file, marked estimated, if that is refused too", async () => {
    const primary = priced();
    const { calls, finish } = finisher([{ code: "22023" }, { code: "22023" }]);
    const result = await deliver({ run: RUN, download: file(onePage), providers: () => ({ primary, fallback: null }), finish, log, deadline: FAR });

    expect(primary.requests).toHaveLength(1);
    expect(calls).toHaveLength(3);
    const dearest = dearestModelFor(1000, 100);
    expect(calls[2]).toMatchObject({
      p_status: "failed",
      p_provider: PRICING[dearest].provider,
      p_model: dearest,
      p_input_tokens: 1000,
      p_output_tokens: 100,
      p_cost_estimated: true,
    });
    expect(isCostEstimated(calls[2].p_error)).toBe(true);
    expect(result.recorded?.model).toBe(dearest);
  });

  it("leaves the run to the sweep when every plan is definitely refused", async () => {
    const primary = priced();
    const { calls, finish } = finisher([{ code: "22023" }, { code: "22023" }, { code: "22023" }]);
    const result = await deliver({ run: RUN, download: file(onePage), providers: () => ({ primary, fallback: null }), finish, log, deadline: FAR });

    expect(primary.requests).toHaveLength(1);
    expect(calls).toHaveLength(3);
    expect(result).toMatchObject({ recorded: null, unconfirmed: false });
  });

  it("finishes a run that called no model once more at most, with nothing to estimate", async () => {
    const { calls, finish } = finisher([{ code: "23514" }, { code: "23514" }]);
    const result = await deliver({ run: { ...RUN, pageCount: 2 }, download: file(onePage), providers: noProviders, finish, log, deadline: FAR });
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.p_model === null && c.p_cost_estimated === false)).toBe(true);
    expect(result.recorded).toBeNull();
  });

  it("keeps a failed run's own error when it is finished again", async () => {
    const primary = fakeProvider("anthropic", "claude-sonnet-5", [new ProviderError("anthropic", "client", "Could not process PDF", 400)]);
    const { calls, finish } = finisher([{ code: "23514" }]);
    await deliver({ run: RUN, download: file(onePage), providers: () => ({ primary, fallback: null }), finish, log, deadline: FAR });
    expect(calls).toHaveLength(2);
    expect(calls[1].p_error).toBe(calls[0].p_error);
    expect(classifyRunError(calls[1].p_error)).toBe("extraction.provider_rejected");
  });
});

describe("a finish that gets no answer", () => {
  const priced = () => fakeProvider("openai", "gpt-5-nano", [answer(validJson(), "gpt-5-nano-2025-08-07", 1000, 100)]);

  // A clock that only moves when the delivery waits.
  function fakeClock(start = 1_000_000) {
    let now = start;
    const waits: number[] = [];
    return { now: () => now, sleep: async (ms: number) => void (waits.push(ms), (now += ms)), waits, advance: (ms: number) => (now += ms) };
  }

  it.each([
    ["throws (no response at all)", "throw" as const],
    ["comes back with code '' (postgrest-js: no response, or aborted)", { code: "", status: 0 }],
    ["gets a gateway's 502 with no database error", { code: null, status: 502 }],
    ["finds the database unreachable (PGRST001)", { code: "PGRST001", status: 503 }],
    ["hits a deadlock (40P01)", { code: "40P01", status: 500 }],
    ["hits a statement timeout (57014)", { code: "57014", status: 500 }],
  ])("is sent again, unchanged, when it %s: a paid result is never replaced by a blip", async (_, blip) => {
    const primary = priced();
    const clock = fakeClock();
    const { calls, finish } = finisher([blip, blip]);
    const result = await deliver({
      run: RUN,
      download: file(onePage),
      providers: () => ({ primary, fallback: null }),
      finish,
      log,
      deadline: clock.now() + 60_000,
      clock,
    });

    expect(primary.requests).toHaveLength(1);
    expect(calls).toHaveLength(3);
    // every one the success, with its fields
    for (const call of calls) expect(call).toEqual(calls[0]);
    expect(calls[0]).toMatchObject({ p_status: "succeeded", p_model: "gpt-5-nano-2025-08-07" });
    expect(result).toMatchObject({ recorded: result.outcome, unconfirmed: false });
    // waits that double
    expect(clock.waits).toEqual([FINISH_RETRY_FIRST_DELAY_MS, 2 * FINISH_RETRY_FIRST_DELAY_MS]);
  });

  it("backs off up to the longest wait, and stops at the deadline without replacing the outcome", async () => {
    const primary = priced();
    const clock = fakeClock();
    const finish: Finish = async () => {
      calls.push(1);
      return { code: "", status: 0 };
    };
    const calls: number[] = [];
    const deadline = clock.now() + 60_000;
    const result = await deliver({ run: RUN, download: file(onePage), providers: () => ({ primary, fallback: null }), finish, log, deadline, clock });

    // no failedCloseAttempts: nothing definite refused the result
    expect(result).toMatchObject({ recorded: null, unconfirmed: false });
    expect(result.finishCalls).toBe(calls.length);
    // 0.5, 1, 2, 4, 8, 8, ... seconds
    expect(clock.waits[0]).toBe(FINISH_RETRY_FIRST_DELAY_MS);
    for (let i = 1; i < clock.waits.length; i++) expect(clock.waits[i]).toBe(Math.min(2 * clock.waits[i - 1], FINISH_RETRY_MAX_DELAY_MS));
    expect(clock.waits.at(-1)).toBe(FINISH_RETRY_MAX_DELAY_MS);
    // every attempt started with at least the shortest attempt's time left,
    // and the last wait would have left too little for another
    expect(deadline - clock.now()).toBeGreaterThanOrEqual(FINISH_MIN_ATTEMPT_MS);
    expect(deadline - clock.now()).toBeLessThan(FINISH_MIN_ATTEMPT_MS + FINISH_RETRY_MAX_DELAY_MS);
    expect(calls.length).toBe(clock.waits.length + 1);
  });

  it("gives each attempt its own time limit, never past the deadline", async () => {
    vi.useFakeTimers();
    try {
      const primary = priced();
      const signals: AbortSignal[] = [];
      const finish: Finish = (_params, signal) => {
        signals.push(signal);
        // hangs until it is aborted, as a request with no answer does
        return new Promise((resolve) => signal.addEventListener("abort", () => resolve({ code: "", status: 0 }), { once: true }));
      };
      const start = Date.now();
      const delivering = deliver({
        run: RUN,
        download: file(onePage),
        providers: () => ({ primary, fallback: null }),
        finish,
        log,
        deadline: start + FINISH_ATTEMPT_TIMEOUT_MS + 3_000,
      });
      await vi.advanceTimersByTimeAsync(FINISH_ATTEMPT_TIMEOUT_MS - 1);
      expect(signals).toHaveLength(1);
      expect(signals[0].aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(signals[0].aborted).toBe(true);
      // the next attempt gets only what is left before the deadline
      await vi.advanceTimersByTimeAsync(FINISH_RETRY_FIRST_DELAY_MS);
      expect(signals).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(3_000 - FINISH_RETRY_FIRST_DELAY_MS - 1);
      expect(signals[1].aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(signals[1].aborted).toBe(true);
      const result = await delivering;
      expect(result).toMatchObject({ recorded: null, finishCalls: 2 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("goes to failedCloseAttempts only once a refusal is definite", async () => {
    const primary = priced();
    const clock = fakeClock();
    const { calls, finish } = finisher([{ code: "", status: 0 }, { code: "22023", status: 400 }]);
    const result = await deliver({ run: RUN, download: file(onePage), providers: () => ({ primary, fallback: null }), finish, log, deadline: clock.now() + 60_000, clock });

    expect(calls.map((c) => c.p_status)).toEqual(["succeeded", "succeeded", "failed"]);
    expect(result.recorded).toMatchObject({ status: "failed" });
  });

  it("stops without replacing anything when the token is gone after a finish whose answer was lost", async () => {
    // the first finish committed, but its answer never arrived; the second
    // finds the token deleted by it
    const primary = priced();
    const clock = fakeClock();
    const { calls, finish } = finisher(["throw", { code: "42501", status: 403 }]);
    const result = await deliver({ run: RUN, download: file(onePage), providers: () => ({ primary, fallback: null }), finish, log, deadline: clock.now() + 60_000, clock });

    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.p_status === "succeeded")).toBe(true);
    expect(result).toMatchObject({ recorded: null, unconfirmed: true });
  });

  it("treats a 42501 as definite when no answer was lost before it", async () => {
    const primary = priced();
    const { calls, finish } = finisher([{ code: "42501", status: 403 }, { code: "42501" }, { code: "42501" }]);
    const result = await deliver({ run: RUN, download: file(onePage), providers: () => ({ primary, fallback: null }), finish, log, deadline: FAR });
    expect(calls.map((c) => c.p_status)).toEqual(["succeeded", "failed", "failed"]);
    expect(result).toMatchObject({ recorded: null, unconfirmed: false });
  });

  it("classifies refusals: no answer and the database's transient errors are retried, anything else is definite", () => {
    for (const blip of [{ code: "" }, { status: 0 }, { code: null, status: 504 }, {}, { code: "PGRST000" }, { code: "PGRST003" }, { code: "08006" }, { code: "40001" }, { code: "40P01" }, { code: "55P03" }, { code: "57014" }, { code: "57P01" }, { code: "53300" }]) {
      expect(isTransientFinishRefusal(blip), JSON.stringify(blip)).toBe(true);
    }
    for (const refusal of [{ code: "42501", status: 403 }, { code: "22023", status: 400 }, { code: "55000" }, { code: "23514" }, { code: "PGRST202", status: 404 }, { code: "53400" }, { code: null, status: 400 }, { code: "XX000", status: 500 }]) {
      expect(isTransientFinishRefusal(refusal), JSON.stringify(refusal)).toBe(false);
    }
  });
});
