// Fake providers and canned model answers, for running the orchestrator
// (runExtraction) with no network, no keys and no model. Shared by the
// database-free tests in tests/unit/ and by the run lifecycle tests in
// tests/extraction.test.ts, which close real runs with the outcomes.
//
// A plain module, not a test file: Vitest doesn't collect it, and it
// imports nothing that needs a secret, a database or "server-only".

import { type ProviderName, withCountMargin } from "@/lib/extraction/config";
import type { ExtractionProvider, ExtractionRequest, ProviderResponse } from "@/lib/extraction/providers/types";
import { FIELD_NAMES } from "@/lib/extraction/schema";

export type FakeProvider = ExtractionProvider & { requests: ExtractionRequest[]; counted: ExtractionRequest[] };

// What a fake's token count says when nothing else does: well under the
// per-call limit for one page (11 927), as real one-page fixtures are.
export const FAKE_COUNT = 1000;

// What a call counted at FAKE_COUNT is charged when it gets no answer: the
// count with its margin (withCountMargin in config.ts), plus the output cap.
export const FAKE_CHARGE = withCountMargin(FAKE_COUNT);

// Answers from a script, one entry per call, in order: a response is
// returned, an error is thrown (a ProviderError to act as the real provider
// would, anything else to act as a bug). Every request is recorded. Running
// out of script throws too, so a test that expected fewer calls fails on
// its request count.
//
// Its token count (run.ts measures every call first) answers from `counts`
// in order if given (a number, or an error to throw), otherwise FAKE_COUNT.
// Every counted request is recorded too.
export function fakeProvider(
  name: ProviderName,
  model: string,
  answers: (ProviderResponse | Error)[],
  counts?: (number | Error)[],
): FakeProvider {
  const script = [...answers];
  const countScript = counts ? [...counts] : null;
  const requests: ExtractionRequest[] = [];
  const counted: ExtractionRequest[] = [];
  return {
    name,
    model,
    requests,
    counted,
    async countInputTokens(request) {
      counted.push(request);
      if (countScript) {
        const next = countScript.shift();
        if (next === undefined) throw new Error(`fake ${name} provider has no count left`);
        if (next instanceof Error) throw next;
        return next;
      }
      return FAKE_COUNT;
    },
    async extract(request) {
      requests.push(request);
      const next = script.shift();
      if (!next) throw new Error(`fake ${name} provider has no answer left`);
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

export function answer(
  text: string,
  model = "claude-haiku-4-5-20251001",
  inputTokens = 1000,
  outputTokens = 100,
): ProviderResponse {
  return { text, inputTokens, outputTokens, model };
}

// A schema-valid answer: every field absent at confidence 0.9, except the
// overrides.
export function validJson(overrides: Record<string, { value: string | null; confidence: number }> = {}) {
  const fields: Record<string, unknown> = {};
  for (const name of FIELD_NAMES) {
    fields[name] = { value: null, confidence: 0.9, source_text: null, clarifying_question: null };
  }
  for (const [name, override] of Object.entries(overrides)) {
    fields[name] = { ...override, source_text: override.value, clarifying_question: null };
  }
  return JSON.stringify(fields);
}

// A tiny file that starts with the PDF signature, which is all the magic
// byte check and the bucket's MIME list look at.
export function pdfBytes(marker: string) {
  return new TextEncoder().encode(
    `%PDF-1.4\n% doc-intake extraction test ${marker}\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n`,
  );
}
