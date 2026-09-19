// Fig. 1 on the landing page quotes one live run. The run's own numbers
// can't be checked from here, but everything the figure shows about them
// can: the eleven values pass the app's validation unchanged, the gating
// gives each the band and percentage shown, the question is the one the
// gating writes, and the cost is what the database's formula gives the
// token counts. If validation, gating or the price changes, the figure is
// stale and this fails.

import { describe, expect, it } from "vitest";
import { FIELDS, PAGE, QUESTION, RUN } from "@/app/_landing/fig-1";
import { computeCostUsd } from "@/lib/extraction/config";
import { FIELDS as SCHEMA_FIELDS, gateFields, validateExtraction } from "@/lib/extraction/schema";

// The model's answer as the figure shows it. The two dates' own
// confidence isn't in the report; anything above the gate's cap ends at
// the same 59%, so they go in at 0.95.
function answer(): string {
  const entries = FIELDS.map((f) => [
    f.name,
    {
      value: f.value,
      confidence: f.band === "low" ? 0.95 : f.confidencePercent / 100,
      source_text: f.sourceText ?? "",
      clarifying_question: "",
    },
  ]);
  return JSON.stringify(Object.fromEntries(entries));
}

describe("Fig. 1", () => {
  it("has every field of the schema, in the schema's order", () => {
    expect(FIELDS.map((f) => f.name)).toEqual(SCHEMA_FIELDS.map((f) => f.name));
    expect(FIELDS.map((f) => f.label)).toEqual(SCHEMA_FIELDS.map((f) => f.label));
  });

  it("shows values that pass validation unchanged, with the bands the gating gives them", () => {
    const validated = validateExtraction(answer());
    if (!validated.ok) throw new Error(validated.error);
    const gated = gateFields(validated.fields);
    expect(gated.documentStatus).toBe("needs_review");
    for (const shown of FIELDS) {
      const field = gated.fields.find((g) => g.name === shown.name);
      expect(field?.value, shown.name).toBe(shown.value);
      expect(field?.band, shown.name).toBe(shown.band);
      expect(Math.round((field?.confidence ?? 0) * 100), shown.name).toBe(shown.confidencePercent);
      expect(field?.clarifying_question ?? null, shown.name).toBe(shown.band === "low" ? QUESTION : null);
    }
  });

  it("marks only places on the page, and every quoted field somewhere", () => {
    for (const field of FIELDS) {
      expect(field.marks.length > 0, field.name).toBe(field.sourceText !== null);
      for (const [x, y, width] of field.marks) {
        expect(x >= 0 && y >= 0 && x + width <= PAGE.width && y <= PAGE.height, field.name).toBe(true);
      }
    }
  });

  it("states the cost the database would record for its token counts", () => {
    const cost = computeCostUsd(RUN.model, RUN.inputTokens, RUN.outputTokens);
    expect(Math.round(cost * 10_000) / 10_000).toBe(RUN.costUsd);
  });
});
