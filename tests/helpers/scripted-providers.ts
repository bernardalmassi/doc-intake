// Providers that follow one shared script of steps, for exhausting every
// combination of answers a run can get: tests/unit/orchestrator.test.ts runs
// the orchestrator over all of them, and tests/unit/delivery.test.ts runs
// the worker's delivery over the same matrix to show it makes exactly the
// same calls.
//
// A plain module, not a test file: Vitest doesn't collect it, and it
// imports nothing that needs a secret, a database or "server-only".

import { MAX_VALIDATION_RETRIES, type ProviderName } from "@/lib/extraction/config";
import { ProviderError, type ExtractionProvider } from "@/lib/extraction/providers/types";
import { validJson } from "./fake-provider";

export const HAIKU = "claude-haiku-4-5-20251001";
export const NANO = "gpt-5-nano";
export const NANO_SNAPSHOT = "gpt-5-nano-2025-08-07";

// a date that doesn't exist, so the answer is JSON but fails the schema
export const BAD_DATE = validJson({ document_date: { value: "2026-02-30", confidence: 0.9 } });

// What a provider does on one call: answer (valid or not); answer
// unusably but billed (refusal, truncated), so the error carries usage;
// or fail with no answer (timeout, 5xx, 4xx).
export type Step = "valid" | "not json" | "fails schema" | "refusal" | "truncated" | "timeout" | "5xx" | "4xx";
export const STEPS: readonly Step[] = ["valid", "not json", "fails schema", "refusal", "truncated", "timeout", "5xx", "4xx"];
const ANSWERS: Partial<Record<Step, string>> = { valid: validJson(), "not json": "{ nope", "fails schema": BAD_DATE };
const BILLED: readonly Step[] = ["valid", "not json", "fails schema", "refusal", "truncated"];
// the model each fake reports having served, which differs from its
// configured id for OpenAI, as the real API's does
export const SERVED: Record<ProviderName, string> = { anthropic: HAIKU, openai: NANO_SNAPSHOT };

// the first call, the validation retries, and one switch to the fallback
export const MAX_CALLS = 1 + MAX_VALIDATION_RETRIES + 1;

export type Call = {
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
export function scripted(steps: readonly Step[], withFallback: boolean) {
  const calls: Call[] = [];
  const make = (name: ProviderName, model: string): ExtractionProvider => ({
    name,
    model,
    // every call is measured first (run.ts), well under the one-page limit
    async countInputTokens() {
      return 1000 + calls.length;
    },
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

export function* scripts(length: number): Generator<Step[]> {
  if (length === 0) {
    yield [];
    return;
  }
  for (const head of scripts(length - 1)) {
    for (const step of STEPS) yield [...head, step];
  }
}
