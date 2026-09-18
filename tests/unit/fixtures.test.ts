// The eval fixtures: the committed PDFs and expected-fields files are
// exactly what the generator produces (regenerate with
// `npm run eval -- --write-fixtures`), the PDF writer's output is
// structurally sound, and every expected value is one the validator would
// accept. No model, no database.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FIELD_NAMES, validateExtraction } from "@/lib/extraction/schema";
import { detectMimeType } from "@/lib/extraction/sniff";
import { expectedValue, FIXTURES } from "../../evals/fixtures";
import { documentPath, expectedPath, generateExpectedJson, generatePdf } from "../../evals/harness";
import { buildPdf, type PdfPage, WHITE } from "../../evals/pdf";

const latin1 = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");

describe("committed fixture files", () => {
  it("fixture ids are unique", () => {
    expect(new Set(FIXTURES.map((f) => f.id)).size).toBe(FIXTURES.length);
  });

  for (const fixture of FIXTURES) {
    it(`${fixture.id}: the PDF and expected fields match the generator byte for byte`, () => {
      const committed = new Uint8Array(readFileSync(documentPath(fixture)));
      expect(Buffer.compare(Buffer.from(committed), Buffer.from(generatePdf(fixture)))).toBe(0);
      expect(readFileSync(expectedPath(fixture), "utf8")).toBe(generateExpectedJson(fixture));
      expect(detectMimeType(committed)).toBe("application/pdf");
    });

    it(`${fixture.id}: expects every field, in formats the validator accepts`, () => {
      expect(Object.keys(fixture.expected).sort()).toEqual([...FIELD_NAMES].sort());
      const answer = Object.fromEntries(
        FIELD_NAMES.map((name) => [
          name,
          { value: expectedValue(fixture.expected[name]) ?? "", confidence: 1, source_text: "", clarifying_question: "" },
        ]),
      );
      expect(validateExtraction(JSON.stringify(answer))).toMatchObject({ ok: true });
      for (const target of fixture.attack?.targets ?? []) expect(FIELD_NAMES).toContain(target);
      expect(fixture.kind === "injection").toBe(fixture.attack !== undefined);
    });
  }
});

describe("the PDF writer", () => {
  const pages: PdfPage[] = [
    [
      { kind: "text", x: 72, y: 700, text: "Total (net) \\ 1.234,56 \u20ac", size: 12 },
      { kind: "text", x: 72, y: 680, text: "hidden", color: WHITE },
      { kind: "line", x1: 72, y1: 670, x2: 540, y2: 670 },
      { kind: "rect", x: 72, y: 600, width: 100, height: 20, color: [0.9, 0.9, 0.9] },
    ],
    [{ kind: "text", x: 300, y: 400, text: "page two", align: "right" }],
  ];
  const bytes = buildPdf(pages);
  const body = latin1(bytes);

  it("writes a PDF 1.4 header, a binary marker and an EOF", () => {
    expect(body.startsWith("%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n")).toBe(true);
    expect(body.endsWith("%%EOF\n")).toBe(true);
  });

  it("every xref offset points at its object, and startxref at the table", () => {
    const startxref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(body)?.[1]);
    expect(body.slice(startxref, startxref + 4)).toBe("xref");
    const table = /xref\n0 (\d+)\n([\s\S]*?)trailer/.exec(body.slice(startxref));
    expect(table).not.toBeNull();
    const count = Number(table![1]);
    const entries = table![2].match(/[\s\S]{20}/g) ?? [];
    expect(entries).toHaveLength(count);
    expect(entries[0]).toBe("0000000000 65535 f \n");
    entries.slice(1).forEach((entry, i) => {
      const offset = Number(entry.slice(0, 10));
      expect(body.slice(offset, offset + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`);
    });
    expect(body).toMatch(new RegExp(`trailer\\n<< /Size ${count} /Root 1 0 R >>`));
  });

  it("stream lengths are exact", () => {
    for (const match of body.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) {
      const start = match.index! + match[0].length;
      expect(body.slice(start + Number(match[1]), start + Number(match[1]) + "endstream".length)).toBe("endstream");
    }
  });

  it("escapes string delimiters and encodes the euro sign in WinAnsi", () => {
    expect(body).toContain("(Total \\(net\\) \\\\ 1.234,56 \u0080) Tj");
    expect(body).toContain("1 1 1 rg");
    expect(body).toContain("/Count 2");
  });

  it("refuses characters it can't encode and is deterministic", () => {
    expect(() => buildPdf([[{ kind: "text", x: 0, y: 0, text: "\u4e2d" }]])).toThrow(/WinAnsi/);
    // same input, same bytes: nothing depends on the clock or the machine
    const copy = JSON.parse(JSON.stringify(pages)) as PdfPage[];
    expect(Buffer.compare(Buffer.from(bytes), Buffer.from(buildPdf(copy)))).toBe(0);
  });
});
