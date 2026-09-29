// Fig. 1 on the landing page quotes one live run. The run's own numbers
// can't be checked from here, but everything the figure shows about them
// can: the eleven values pass the app's validation unchanged, the gating
// gives each the band and percentage shown, the question is the one the
// gating writes, and the cost is what the database's formula gives the
// token counts. If validation, gating or the price changes, the figure is
// stale and this fails.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DETAIL, FIELDS, PAGE, QUESTION, QUESTION_LEAD, RUN, SCAN_FILE } from "@/app/_landing/fig-1";
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

  it("crops the hero's detail from the page, around a Low field and every one of its marks", () => {
    expect(DETAIL.x + DETAIL.width <= PAGE.width && DETAIL.y + DETAIL.height <= PAGE.height).toBe(true);
    const field = FIELDS.find((f) => f.name === DETAIL.field);
    expect(field?.band).toBe("low");
    for (const [x, y, width] of field?.marks ?? []) {
      expect(x >= DETAIL.x && x + width <= DETAIL.x + DETAIL.width, `${x},${y}`).toBe(true);
      expect(y >= DETAIL.y && y <= DETAIL.y + DETAIL.height, `${x},${y}`).toBe(true);
    }
    // The hero's one sentence is the gating's own, not a paraphrase.
    expect(QUESTION.startsWith(QUESTION_LEAD)).toBe(true);
    expect(QUESTION_LEAD).toBe(
      "The payment terms are 30 days, but the due date is 91 days after the document date.",
    );
  });

  it("shows the PDF's own page image, which carries nothing but the picture", () => {
    const file = readFileSync("src/app/_landing/invoice-scan-page-1.jpg");
    // The bytes taken out of test-invoice-messy-scan.pdf. Any re-encoding,
    // by any tool, changes them.
    expect(file.length).toBe(SCAN_FILE.bytes);
    expect(createHash("sha256").update(file).digest("hex")).toBe(SCAN_FILE.sha256);

    // Every segment before the picture's data. Allowed: the JFIF header
    // (APP0), the tables and the frame header. Not allowed: APP1 (Exif,
    // XMP), APP2 (a colour profile, which names the display it came from),
    // APP13 (Photoshop), any other APPn, or a comment.
    expect(file.subarray(0, 2).toString("hex")).toBe("ffd8");
    const allowed = new Set([0xe0, 0xdb, 0xc0, 0xc4, 0xdd]);
    let frame: { width: number; height: number } | null = null;
    let at = 2;
    for (;;) {
      expect(file[at], `marker at ${at}`).toBe(0xff);
      const marker = file[at + 1] ?? 0;
      if (marker === 0xda) break; // the picture's data starts
      expect(allowed.has(marker), `segment 0x${marker.toString(16)}`).toBe(true);
      const length = file.readUInt16BE(at + 2);
      if (marker === 0xe0) expect(file.subarray(at + 4, at + 8).toString("latin1")).toBe("JFIF");
      if (marker === 0xc0) frame = { height: file.readUInt16BE(at + 5), width: file.readUInt16BE(at + 7) };
      at += 2 + length;
    }
    expect(frame).toEqual(PAGE);

    // "A4 at 200 dpi": A4 is 210 x 297 mm.
    expect(Math.round(PAGE.width / (210 / 25.4))).toBe(SCAN_FILE.dotsPerInch);
    expect(Math.round(PAGE.height / (297 / 25.4))).toBe(SCAN_FILE.dotsPerInch);
  });

  it("states the cost the database would record for its token counts", () => {
    const cost = computeCostUsd(RUN.model, RUN.inputTokens, RUN.outputTokens);
    expect(Math.round(cost * 10_000) / 10_000).toBe(RUN.costUsd);
  });
});
