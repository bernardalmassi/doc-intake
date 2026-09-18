// The eval's comparison rules and calibration arithmetic (evals/score.ts).
// No model, no database.

import { describe, expect, it } from "vitest";
import type { RunOutcome } from "@/lib/extraction/run";
import { FIELD_NAMES } from "@/lib/extraction/schema";
import type { Fixture } from "../../evals/fixtures";
import { calibration, type FieldResult, normalizeReference, normalizeText, scoreRun, valueMatches } from "../../evals/score";

describe("comparison rules", () => {
  it("dates, enums and currency are exact; currency ignores case", () => {
    expect(valueMatches("document_date", "2026-09-12", "2026-09-12")).toBe(true);
    expect(valueMatches("document_date", "2026-09-12", "2026-12-09")).toBe(false);
    expect(valueMatches("document_type", "statement", "invoice")).toBe(false);
    expect(valueMatches("currency", "EUR", "eur")).toBe(true);
  });

  it("amounts compare as numbers", () => {
    expect(valueMatches("total_amount", "1250.00", "1250")).toBe(true);
    expect(valueMatches("total_amount", "1141.40", "1141.4")).toBe(true);
    expect(valueMatches("total_amount", "1141.40", "114140")).toBe(false);
    expect(valueMatches("total_amount", "0.01", "0.010")).toBe(true);
  });

  it("names and titles compare as normalized text, against listed alternatives", () => {
    expect(normalizeText("Alder & Finch Bakery Co.")).toBe("alder and finch bakery co");
    expect(valueMatches("recipient_name", "Alder & Finch Bakery Co.", "ALDER AND FINCH BAKERY CO")).toBe(true);
    expect(valueMatches("title", "Invoice", "INVOICE")).toBe(true);
    expect(valueMatches("sender_name", { value: "Keller Werkzeuge GmbH", accept: ["Keller Werkzeuge"] }, "Keller Werkzeuge")).toBe(true);
    // not a substring match
    expect(valueMatches("sender_name", "Keller Werkzeuge GmbH", "Keller")).toBe(false);
  });

  it("references keep only letters and digits, so a kept label is still wrong", () => {
    expect(normalizeReference("INV-2026-0417")).toBe("inv20260417");
    expect(valueMatches("reference_number", "NW-2026-0417", "nw 2026 0417")).toBe(true);
    expect(valueMatches("reference_number", "GU-26-18842", "Application GU-26-18842")).toBe(false);
  });

  it("summary is scored for presence only", () => {
    expect(valueMatches("summary", "A letter.", "Something else entirely")).toBe(true);
    expect(valueMatches("summary", "A letter.", null)).toBe(false);
  });

  it("an absent field is right only when extracted as absent", () => {
    expect(valueMatches("currency", null, null)).toBe(true);
    expect(valueMatches("currency", null, "USD")).toBe(false);
    expect(valueMatches("total_amount", "10.00", null)).toBe(false);
  });
});

function result(correct: boolean, confidence: number, band: "high" | "medium" | "low"): FieldResult {
  return { fixture: "f", provider: "openai", field: "title", expected: "x", got: "x", correct, confidence, band, flagged: false };
}

describe("calibration", () => {
  it("per band accuracy, ECE and Brier score on a known set", () => {
    const results = [
      result(true, 0.95, "high"),
      result(true, 0.95, "high"),
      result(false, 0.95, "high"),
      result(true, 0.4, "low"),
    ];
    const c = calibration(results);
    expect(c.n).toBe(4);
    const high = c.bands.find((b) => b.band === "high");
    expect(high).toMatchObject({ n: 3, accuracy: 2 / 3 });
    expect(high?.meanConfidence).toBeCloseTo(0.95, 10);
    expect(c.bands.find((b) => b.band === "medium")?.n).toBe(0);
    // bin 9: 3 fields, accuracy 2/3, confidence 0.95; bin 4: 1 field, 1 vs 0.4
    expect(c.ece).toBeCloseTo((3 / 4) * Math.abs(2 / 3 - 0.95) + (1 / 4) * 0.6, 10);
    expect(c.brier).toBeCloseTo((0.05 ** 2 * 2 + 0.95 ** 2 + 0.6 ** 2) / 4, 10);
  });

  it("ignores fields from failed runs, which have no confidence", () => {
    const failed: FieldResult = { ...result(false, 0, "low"), confidence: null, band: null };
    expect(calibration([failed, result(true, 1, "high")]).n).toBe(1);
  });
});

describe("scoring a run", () => {
  const fixture: Fixture = {
    id: "f",
    kind: "ordinary",
    description: "",
    pages: [],
    expected: Object.fromEntries(FIELD_NAMES.map((name) => [name, null])),
  };

  it("a failed run scores every field wrong, absent ones included", () => {
    const outcome: RunOutcome = {
      status: "failed",
      error: "x",
      rawResponse: null,
      provider: "openai",
      model: "gpt-5-nano",
      attempts: 1,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
    };
    const scored = scoreRun(fixture, "openai", outcome);
    expect(scored).toHaveLength(FIELD_NAMES.length);
    expect(scored.every((r) => !r.correct && r.confidence === null)).toBe(true);
  });
});
