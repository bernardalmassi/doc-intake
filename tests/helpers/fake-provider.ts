// Fake providers and canned model answers, for running the orchestrator
// (runExtraction) with no network, no keys and no model. Shared by the
// database-free tests in tests/unit/ and by the run lifecycle tests in
// tests/extraction.test.ts, which close real runs with the outcomes.
//
// A plain module, not a test file: Vitest doesn't collect it, and it
// imports nothing that needs a secret, a database or "server-only".

import type { ProviderName } from "@/lib/extraction/config";
import type { ExtractionProvider, ExtractionRequest, ProviderResponse } from "@/lib/extraction/providers/types";
import { FIELD_NAMES } from "@/lib/extraction/schema";

export type FakeProvider = ExtractionProvider & { requests: ExtractionRequest[] };

// Answers from a script, one entry per call, in order: a response is
// returned, an error is thrown (a ProviderError to act as the real provider
// would, anything else to act as a bug). Every request is recorded. Running
// out of script throws too, so a test that expected fewer calls fails on
// its request count.
export function fakeProvider(
  name: ProviderName,
  model: string,
  answers: (ProviderResponse | Error)[],
): FakeProvider {
  const script = [...answers];
  const requests: ExtractionRequest[] = [];
  return {
    name,
    model,
    requests,
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
