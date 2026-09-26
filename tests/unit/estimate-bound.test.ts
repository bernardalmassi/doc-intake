// The money claim the in-flight estimate rests on (SECURITY.md, "The spend
// ledger and the ceilings"): no run can spend more than the estimate it holds
// against the ceilings while in flight (private.abandoned_estimate, mirrored
// by abandonedRunCostUsd), and no run is recorded at less than it may have
// spent. The orchestrator (run.ts) with fake providers that push every limit:
// each count says the most a call may read for the document's pages, each
// billed answer bills exactly that and the whole output cap, at the default
// Claude model, the dearest priced one. Over every combination of answers
// (the matrix in scripted-providers.ts), for page counts either side of where
// the run's own cap binds:
//
//   - what the calls may have cost the provider, each at its own model's
//     price (a call that got no answer at its measured input plus the output
//     cap), is at most the estimate
//   - what the database records, the outcome's tokens at the model it is
//     priced at, clamped as extraction_charge clamps them, is at least that,
//     and the clamp never cuts: the run's tokens fit the per-run maximums
//
// It assumes a provider bills the input its count endpoint measured: OpenAI
// documents its count as exact; Anthropic calls its count an estimate that
// may differ by a small amount (SECURITY.md, "What remains").
//
// Needs no database.

import { describe, expect, it } from "vitest";
import {
  abandonedRunCostUsd,
  computeCostUsd,
  DEFAULT_MODELS,
  EXTRACTION_LIMITS,
  inputTokensPerCall,
  MAX_OUTPUT_TOKENS,
  priceForModel,
  PRICING,
  type ProviderName,
} from "@/lib/extraction/config";
import { ProviderError, type ExtractionProvider } from "@/lib/extraction/providers/types";
import { runExtraction } from "@/lib/extraction/run";
import { pdfBytes } from "../helpers/fake-provider";
import { BAD_DATE, MAX_CALLS, scripts, type Step } from "../helpers/scripted-providers";
import { validJson } from "../helpers/fake-provider";

const ANSWERS: Partial<Record<Step, string>> = { valid: validJson(), "not json": "{ nope", "fails schema": BAD_DATE };

type Spent = { model: string; input: number; output: number };

// Both providers read one script. Every count is `perCall`; every billed call
// bills `perCall` in and the output cap out.
function atTheLimit(steps: readonly Step[], perCall: number, withFallback: boolean) {
  const spent: Spent[] = [];
  let calls = 0;
  const make = (name: ProviderName, model: string): ExtractionProvider => ({
    name,
    model,
    async countInputTokens() {
      return perCall;
    },
    async extract() {
      const step = steps[calls];
      calls += 1;
      const usage = { inputTokens: perCall, outputTokens: MAX_OUTPUT_TOKENS, model };
      switch (step) {
        case undefined:
          throw new Error("unexpected call");
        case "refusal":
          spent.push({ model, input: perCall, output: MAX_OUTPUT_TOKENS });
          throw new ProviderError(name, "refusal", "the model declined to process this document", undefined, usage);
        case "truncated":
          spent.push({ model, input: perCall, output: MAX_OUTPUT_TOKENS });
          throw new ProviderError(name, "truncated", "the answer exceeded the 2048 output token cap", undefined, usage);
        case "timeout":
          // may have been processed and billed in full
          spent.push({ model, input: perCall, output: MAX_OUTPUT_TOKENS });
          throw new ProviderError(name, "transport", "request timed out");
        case "5xx":
          throw new ProviderError(name, "server", "service unavailable", 503);
        case "4xx":
          throw new ProviderError(name, "client", "invalid request", 400);
        default:
          spent.push({ model, input: perCall, output: MAX_OUTPUT_TOKENS });
          return { text: ANSWERS[step] ?? "", ...usage };
      }
    },
  });
  return {
    spent,
    primary: make("anthropic", DEFAULT_MODELS.anthropic),
    fallback: withFallback ? make("openai", DEFAULT_MODELS.openai) : null,
  };
}

const cost = (spent: Spent[]) =>
  spent.reduce((sum, s) => {
    const price = priceForModel(s.model);
    return sum + (s.input * price.inputUsdPerMillion + s.output * price.outputUsdPerMillion) / 1_000_000;
  }, 0);

describe("a run and its in-flight estimate", () => {
  it("the default Claude model is the dearest price on file, which is what the estimate charges", () => {
    expect(EXTRACTION_LIMITS.abandonedRunPriceModel).toBe(DEFAULT_MODELS.anthropic);
    const dearest = PRICING[EXTRACTION_LIMITS.abandonedRunPriceModel];
    for (const price of Object.values(PRICING)) {
      expect(price.inputUsdPerMillion).toBeLessThanOrEqual(dearest.inputUsdPerMillion);
      expect(price.outputUsdPerMillion).toBeLessThanOrEqual(dearest.outputUsdPerMillion);
    }
  });

  it.each([1, 2, 20, 50, 87, 88, 100])(
    "at %i pages, no combination of answers spends more than the estimate or records less than it spent",
    async (pages) => {
      const perCall = inputTokensPerCall(pages);
      const estimate = abandonedRunCostUsd(pages);
      let runs = 0;
      for (const withFallback of [true, false]) {
        for (const steps of scripts(MAX_CALLS)) {
          const { spent, primary, fallback } = atTheLimit(steps, perCall, withFallback);
          const outcome = await runExtraction({ bytes: pdfBytes("bound"), mimeType: "application/pdf", pages, primary, fallback });
          const label = `${pages} pages: ${steps.join(", ")}, ${withFallback ? "with" : "without"} a fallback`;
          runs += 1;

          const real = cost(spent);
          // what the calls may have cost is within the estimate
          expect(real, label).toBeLessThanOrEqual(estimate + 1e-9);
          // the database's clamp never cuts a real run
          expect(outcome.inputTokens, label).toBeLessThanOrEqual(EXTRACTION_LIMITS.maxInputTokensPerRun);
          expect(outcome.outputTokens, label).toBeLessThanOrEqual(EXTRACTION_LIMITS.maxOutputTokensPerRun);
          // what is recorded is never less than what may have been spent
          if (outcome.model !== null) {
            const recorded = computeCostUsd(outcome.model, outcome.inputTokens, outcome.outputTokens);
            expect(recorded, label).toBeGreaterThanOrEqual(real - 1e-8);
            expect(recorded, label).toBeLessThanOrEqual(estimate + 1e-8);
          } else {
            expect(real, label).toBe(0);
          }
        }
      }
      expect(runs).toBe(2 * 8 ** MAX_CALLS);
    },
  );

  it("from 88 pages three calls at the per-call limit would pass the run's cap, so the third isn't sent", async () => {
    const perCall = inputTokensPerCall(100);
    expect(3 * perCall).toBeGreaterThan(EXTRACTION_LIMITS.maxInputTokensPerRun);
    // primary times out, fallback answers invalid: the retry would be the third
    const { spent, primary, fallback } = atTheLimit(["timeout", "not json", "valid"], perCall, true);
    const outcome = await runExtraction({ bytes: pdfBytes("cap"), mimeType: "application/pdf", pages: 100, primary, fallback });
    expect(spent).toHaveLength(2);
    expect(outcome).toMatchObject({ status: "failed", attempts: 2, inputTokens: 2 * perCall });
    if (outcome.status === "failed") {
      expect(outcome.error).toMatch(
        new RegExp(`\\) failed: the retry was not sent: its input \\(${perCall} tokens\\) would take the run's to ${3 * perCall}, over the ${EXTRACTION_LIMITS.maxInputTokensPerRun} a run may read$`),
      );
    }
  });
});
