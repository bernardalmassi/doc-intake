// Validation of a model's answer (schema.ts): malformed answers are refused
// with a message specific enough to send back to the model on the retry,
// empty strings mean absent, and the schema sent to both providers contains
// no unions (Anthropic refuses more than 16). Needs no database.

import { describe, expect, it } from "vitest";
import { buildJsonSchema, FIELD_NAMES, validateExtraction } from "@/lib/extraction/schema";
import { validJson } from "../helpers/fake-provider";

describe("validation", () => {
  it("rejects malformed answers with a specific message", () => {
    expect(validateExtraction("not json")).toMatchObject({ ok: false, error: expect.stringMatching(/not valid JSON/) });
    expect(validateExtraction("[]")).toMatchObject({ ok: false, error: expect.stringMatching(/JSON object/) });
    const missing = validateExtraction("{}");
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toMatch(/document_type is missing/);

    const badDate = validateExtraction(validJson({ document_date: { value: "2026-02-30", confidence: 0.9 } }));
    expect(badDate).toMatchObject({ ok: false, error: expect.stringMatching(/document_date.*YYYY-MM-DD/) });
    const badAmount = validateExtraction(validJson({ total_amount: { value: "1,234.00", confidence: 0.9 } }));
    expect(badAmount).toMatchObject({ ok: false, error: expect.stringMatching(/total_amount/) });
    const badCurrency = validateExtraction(validJson({ currency: { value: "dollars", confidence: 0.9 } }));
    expect(badCurrency).toMatchObject({ ok: false, error: expect.stringMatching(/currency/) });
    const badEnum = validateExtraction(validJson({ document_type: { value: "memo", confidence: 0.9 } }));
    expect(badEnum).toMatchObject({ ok: false, error: expect.stringMatching(/document_type.*one of/) });
    const badConfidence = validateExtraction(validJson({ title: { value: "x", confidence: 1.5 } }));
    expect(badConfidence).toMatchObject({ ok: false, error: expect.stringMatching(/confidence/) });
  });

  it("treats empty strings as absent and the schema has no unions", () => {
    const text = validJson({ title: { value: "", confidence: 0.9 }, currency: { value: "   ", confidence: 0.5 } });
    const result = validateExtraction(text);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fields.find((f) => f.name === "title")).toMatchObject({ value: null, source_text: null });
      expect(result.fields.find((f) => f.name === "currency")?.value).toBeNull();
    }
    // Anthropic rejects schemas with more than 16 union-typed parameters
    expect(JSON.stringify(buildJsonSchema())).not.toMatch(/anyOf|oneOf|"null"/);
  });

  it("accepts a well-formed answer", () => {
    const result = validateExtraction(
      validJson({ document_date: { value: "2026-09-18", confidence: 0.95 }, total_amount: { value: "1234.56", confidence: 0.7 } }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fields).toHaveLength(FIELD_NAMES.length);
      expect(result.fields.find((f) => f.name === "total_amount")).toMatchObject({ value: "1234.56", confidence: 0.7 });
    }
  });
});
