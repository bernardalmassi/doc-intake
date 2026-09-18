// Page counts for the abandoned-run estimate (src/lib/extraction/pages.ts):
// the eval's generated PDFs, a PDF 1.5 file whose page tree sits in a
// compressed object stream, images, unreadable input, and a compression
// bomb that must stay capped.

import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { countPages, countPdfPages } from "@/lib/extraction/pages";
import { FIXTURES, fixtureById } from "../../evals/fixtures";
import { committedPdf } from "../../evals/harness";

const ascii = (text: string) => new TextEncoder().encode(text);

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// A PDF whose page objects and page tree are only inside a Flate object
// stream, as PDF 1.5+ writers produce.
function objectStreamPdf(pages: number): Uint8Array {
  const kids = Array.from({ length: pages }, (_, i) => `${10 + i} 0 R`).join(" ");
  const objects =
    `<< /Type /Pages /Kids [${kids}] /Count ${pages} >>\n` +
    Array.from({ length: pages }, () => "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>").join("\n");
  const packed = deflateSync(ascii(objects));
  return concat(
    ascii(`%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n5 0 obj\n<< /Type /ObjStm /N ${pages + 1} /First 40 /Filter /FlateDecode /Length ${packed.length} >>\nstream\n`),
    packed,
    ascii("\nendstream\nendobj\n%%EOF\n"),
  );
}

describe("page counts", () => {
  it("reads every eval fixture: the contract has two pages, the rest one", () => {
    for (const fixture of FIXTURES) {
      expect(countPdfPages(committedPdf(fixture)), fixture.id).toBe(fixture.id === "contract-services" ? 2 : 1);
    }
    expect(countPages(committedPdf(fixtureById("contract-services")), "application/pdf")).toBe(2);
  });

  it("finds pages kept only in a compressed object stream", () => {
    expect(countPdfPages(objectStreamPdf(1))).toBe(1);
    expect(countPdfPages(objectStreamPdf(37))).toBe(37);
  });

  it("counts an image as one page", () => {
    expect(countPages(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "image/png")).toBe(1);
    expect(countPages(new Uint8Array([0xff, 0xd8, 0xff]), "image/jpeg")).toBe(1);
  });

  it("returns null when it can read no page at all", () => {
    expect(countPdfPages(ascii("%PDF-1.4\nnothing here\n%%EOF"))).toBeNull();
    expect(countPdfPages(new Uint8Array(0))).toBeNull();
  });

  it("caps decompression: a bomb inflating to 64 MB is cut off and the count still comes back", () => {
    const bomb = deflateSync(new Uint8Array(64 * 1024 * 1024));
    const pdf = concat(
      ascii(`%PDF-1.7\n1 0 obj << /Type /Pages /Count 3 >> endobj\n5 0 obj\n<< /Type /ObjStm /N 1 /First 0 /Filter /FlateDecode /Length ${bomb.length} >>\nstream\n`),
      bomb,
      ascii("\nendstream\nendobj\n%%EOF\n"),
    );
    const started = Date.now();
    expect(countPdfPages(pdf)).toBe(3);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
