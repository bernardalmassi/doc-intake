// The per-call input bound (inputTokensPerCall in config.ts, the same
// columns of public.extraction_limits, 20260925000005) against what the
// providers really count and bill. No network: the counts were taken with
// Anthropic's free token counting endpoint by `npm run eval -- --count`
// (evals/count.ts) into evals/token-counts.json, and what each provider
// billed is in evals/recordings/.
//
//   - the counts are of today's requests (the prompt, the schema, the
//     fixtures' bytes and the retry turn, fingerprinted as the recordings
//     are): a change to any of them makes the counts stale
//   - the figures in config.ts are the counts' maxima plus 25%
//   - every count, both image cases and every recorded call fit the bound,
//     so no ordinary document, photo, scan or validation retry is refused
//     as too dense (V1)
//   - the counter can reach nothing but the count endpoint

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FIXTURES } from "../../evals/fixtures";
import { loadRecording, PROVIDERS } from "../../evals/harness";
import { countOnlyFetch } from "../../evals/count";
import {
  CALIBRATION_HEADROOM,
  COUNT_ENDPOINT,
  countedModels,
  deriveFigures,
  fingerprintFor,
  loadTokenCounts,
  observedMaxima,
  RECOUNT_HINT,
  repositoryRequests,
} from "../../evals/token-counts";
import { EXTRACTION_LIMITS, inputTokensPerCall, selectableAnthropicModels } from "@/lib/extraction/config";

const counts = loadTokenCounts();

function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

describe("the token counts the bound is calibrated from", () => {
  it("cover every Anthropic model the app may select", () => {
    expect(Object.keys(counts.counts).sort()).toEqual(selectableAnthropicModels());
    expect(countedModels()).toEqual(selectableAnthropicModels());
    expect(counts.endpoint).toBe(COUNT_ENDPOINT);
  });

  it(`are of today's requests (else ${RECOUNT_HINT})`, () => {
    const today = repositoryRequests();
    const counted = Object.entries(counts.requests).filter(([, described]) => described.kind !== "image");
    expect(counted.map(([id]) => id).sort()).toEqual(today.map((r) => r.id).sort());
    for (const model of countedModels()) {
      for (const request of today) {
        const { provider, ...parts } = fingerprintFor(model, request.request).parts;
        expect(provider).toBeTruthy();
        expect(counts.requests[request.id], `${request.id} on ${model}`).toEqual({ kind: request.kind, pages: request.pages, parts });
        expect(counts.counts[model][request.id], `${request.id} on ${model}`).toBeGreaterThan(0);
      }
    }
  });

  it("include a full-resolution phone photo and a 150 dpi scan, each sent with today's prompt", () => {
    const [photo, scan] = counts.images;
    expect(photo).toMatchObject({ mimeType: "image/jpeg" });
    expect(photo.width * photo.height).toBeGreaterThanOrEqual(12_000_000);
    // A4 at 150 dpi: 8.27 x 11.69 inches
    expect(scan).toMatchObject({ mimeType: "image/png", width: 1240, height: 1754 });
    const prompt = counts.requests.prompt.parts;
    for (const image of counts.images) {
      const described = counts.requests[image.id];
      expect(described).toMatchObject({ kind: "image", pages: 1 });
      expect(described.parts.file).toBe(sha256(`${image.mimeType}\n${image.sha256}`));
      expect({ ...described.parts, file: prompt.file }).toEqual(prompt);
      for (const model of countedModels()) expect(counts.counts[model][image.id]).toBeGreaterThan(0);
    }
  });
});

describe("the per-call input bound", () => {
  it("is the counts' maxima plus 25%", () => {
    const observed = observedMaxima(counts);
    expect(CALIBRATION_HEADROOM).toBe(1.25);
    expect(deriveFigures(observed)).toEqual({
      promptInputTokens: EXTRACTION_LIMITS.promptInputTokens,
      inputTokensPerPage: EXTRACTION_LIMITS.inputTokensPerPage,
      retryInputTokens: EXTRACTION_LIMITS.retryInputTokens,
    });
    // what decided each (migration 20260925000005 quotes these)
    expect(observed).toEqual({
      prompt: { tokens: 4798, model: "claude-sonnet-5" },
      perPage: { tokens: 4743, model: "claude-sonnet-5", id: "image:phone-photo-3024x4032.jpg" },
      retry: { tokens: 1418, model: "claude-sonnet-5", id: "retry:invoice-gbp-numeric-dates" },
    });
    // a call of the most pages a document may have
    expect(EXTRACTION_LIMITS.maxInputTokensPerCall).toBe(
      EXTRACTION_LIMITS.promptInputTokens + EXTRACTION_LIMITS.maxPagesPerDocument * EXTRACTION_LIMITS.inputTokensPerPage,
    );
  });

  it("lets every counted fixture, image and retry through, on every model", () => {
    for (const [model, byId] of Object.entries(counts.counts)) {
      for (const [id, tokens] of Object.entries(byId)) {
        const { kind, pages } = counts.requests[id];
        if (kind === "prompt") continue;
        const bound = inputTokensPerCall(pages, kind === "retry");
        expect(tokens, `${id} on ${model}: ${tokens} tokens against ${bound}`).toBeLessThanOrEqual(bound);
      }
    }
  });

  it("lets through every call the recordings hold, as each provider billed it", () => {
    for (const fixture of FIXTURES) {
      for (const provider of PROVIDERS) {
        for (const call of loadRecording(fixture, provider).calls) {
          const billed = call.response?.inputTokens ?? call.error?.usage?.inputTokens;
          if (billed === undefined) continue;
          const retry = call.fingerprint.parts.previousAttempt !== sha256("null");
          const bound = inputTokensPerCall(fixture.pages.length, retry);
          expect(billed, `${fixture.id} (${provider})`).toBeLessThanOrEqual(bound);
        }
      }
    }
  });

  it("gives the retry room for the answer it resends", () => {
    expect(inputTokensPerCall(1, true) - inputTokensPerCall(1)).toBe(EXTRACTION_LIMITS.retryInputTokens);
    expect(inputTokensPerCall(100, true)).toBe(EXTRACTION_LIMITS.maxInputTokensPerCall + EXTRACTION_LIMITS.retryInputTokens);
  });
});

describe("the token counter", () => {
  it("can reach the count endpoint and nothing else", async () => {
    for (const [url, method] of [
      ["https://api.anthropic.com/v1/messages", "POST"],
      ["https://api.anthropic.com/v1/messages/count_tokens?beta=true", "POST"],
      [COUNT_ENDPOINT, "GET"],
      ["https://api.openai.com/v1/responses/input_tokens", "POST"],
    ] as const) {
      await expect(countOnlyFetch(url, { method }), `${method} ${url}`).rejects.toThrow(/only calls/);
    }
  });
});
