// Page counts (src/lib/extraction/page-count.ts), with node:zlib as the
// server uses it (pages.ts) and with DecompressionStream as the upload form
// uses it in the browser (src/lib/page-count-browser.ts): the eval's
// generated PDFs, a PDF 1.5 file whose page tree sits in a compressed
// object stream, one over the page limit, images, unreadable input, and a
// compression bomb that must stay capped. Both must give the same count,
// since both enforce the same limit.

import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { EXTRACTION_LIMITS } from "@/lib/extraction/config";
import { countPages, countPdfPages } from "@/lib/extraction/pages";
import { countPdfPagesInBrowser } from "@/lib/page-count-browser";
import { describeRejection } from "@/app/app/[slug]/messages";
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

// both counters, which must agree
async function both(bytes: Uint8Array): Promise<number | null> {
  const server = await countPdfPages(bytes);
  const browser = await countPdfPagesInBrowser(new Blob([bytes.slice()]));
  expect(browser, "the browser count").toBe(server);
  return server;
}

describe("page counts", () => {
  it("reads every eval fixture: the contract has two pages, the rest one", async () => {
    for (const fixture of FIXTURES) {
      expect(await both(committedPdf(fixture)), fixture.id).toBe(fixture.id === "contract-services" ? 2 : 1);
    }
    expect(await countPages(committedPdf(fixtureById("contract-services")), "application/pdf")).toBe(2);
  });

  it("finds pages kept only in a compressed object stream", async () => {
    expect(await both(objectStreamPdf(1))).toBe(1);
    expect(await both(objectStreamPdf(37))).toBe(37);
  });

  it("counts one page over the limit, which the upload form and the Extract action refuse", async () => {
    const limit = EXTRACTION_LIMITS.maxPagesPerDocument;
    expect(await both(objectStreamPdf(limit))).toBe(limit);
    expect(await both(objectStreamPdf(limit + 1))).toBe(limit + 1);
  });

  it("counts an image as one page", async () => {
    expect(await countPages(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "image/png")).toBe(1);
    expect(await countPages(new Uint8Array([0xff, 0xd8, 0xff]), "image/jpeg")).toBe(1);
  });

  it("returns null when it can read no page at all", async () => {
    expect(await both(ascii("%PDF-1.4\nnothing here\n%%EOF"))).toBeNull();
    expect(await both(new Uint8Array(0))).toBeNull();
  });

  it("caps decompression: a bomb inflating to 64 MB is cut off and the count still comes back", async () => {
    const bomb = deflateSync(new Uint8Array(64 * 1024 * 1024));
    const pdf = concat(
      ascii(`%PDF-1.7\n1 0 obj << /Type /Pages /Count 3 >> endobj\n5 0 obj\n<< /Type /ObjStm /N 1 /First 0 /Filter /FlateDecode /Length ${bomb.length} >>\nstream\n`),
      bomb,
      ascii("\nendstream\nendobj\n%%EOF\n"),
    );
    const started = Date.now();
    expect(await both(pdf)).toBe(3);
    expect(Date.now() - started).toBeLessThan(4000);
  });
});

describe("the upload form's page rejections", () => {
  it("names the count and the limit, or says the pages couldn't be counted", () => {
    expect(describeRejection("pages", { name: "annual-report.pdf", size: 1, pages: 142 })).toBe(
      `annual-report.pdf has 142 pages. Documents can have at most ${EXTRACTION_LIMITS.maxPagesPerDocument} pages. ` +
        `Split this one into parts of ${EXTRACTION_LIMITS.maxPagesPerDocument} pages or fewer and upload them separately.`,
    );
    expect(describeRejection("unreadable", { name: "scan.pdf", size: 1, pages: null })).toMatch(
      /^scan\.pdf can't be uploaded\. We couldn't count this PDF's pages/,
    );
  });
});
