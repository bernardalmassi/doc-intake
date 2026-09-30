// What the Extract action checks before it enqueues a run
// (src/lib/extraction/extract-check.ts): the file must have downloaded,
// its bytes must be its declared type, and a PDF must have between 1 and
// maxPagesPerDocument countable pages. Anything else is the error the user
// gets at once, and the action queues nothing: the worker would only fail
// the run. And the action itself returns that error before it calls
// enqueue_extraction_run, and enqueues only a counted page count.
//
// Needs no database.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildPdf } from "../../evals/pdf";
import { EXTRACTION_LIMITS } from "@/lib/extraction/config";
import { checkFileForExtraction } from "@/lib/extraction/extract-check";
import { countPages } from "@/lib/extraction/pages";
import { pdfBytes } from "../helpers/fake-provider";

const root = fileURLToPath(new URL("../..", import.meta.url));
const pdf = (pages: number) => buildPdf(Array.from({ length: pages }, (_, i) => [{ kind: "text" as const, x: 72, y: 720, text: `Page ${i + 1}` }]));
// a well-formed page tree with no pages in it
const noPages = new TextEncoder().encode(
  "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\ntrailer << /Root 1 0 R >>\n%%EOF\n",
);
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

describe("checkFileForExtraction", () => {
  it.each([
    ["the download failed, the file gone", { ok: false as const, error: "download.not_found" as const }, "application/pdf", "download.not_found"],
    ["the download failed, no connection", { ok: false as const, error: "network.unavailable" as const }, "application/pdf", "network.unavailable"],
    ["the download failed some other way", { ok: false as const, error: "unknown" as const }, "application/pdf", "extraction.download_failed"],
    ["the bytes aren't a PDF", { ok: true as const, bytes: new TextEncoder().encode("hello, not a PDF") }, "application/pdf", "extraction.file_type_mismatch"],
    ["a PDF declared as a PNG", { ok: true as const, bytes: pdf(1) }, "image/png", "extraction.file_type_mismatch"],
    ["no declared type", { ok: true as const, bytes: pdf(1) }, null, "extraction.file_type_mismatch"],
    ["a PDF with no pages", { ok: true as const, bytes: noPages }, "application/pdf", "document.no_pages"],
    ["a PDF whose pages can't be counted", { ok: true as const, bytes: pdfBytes("no page tree") }, "application/pdf", "document.pages_unreadable"],
    ["a PDF over the page limit", { ok: true as const, bytes: pdf(EXTRACTION_LIMITS.maxPagesPerDocument + 1) }, "application/pdf", "document.too_many_pages"],
  ])("refuses, with no run, when %s", async (_label, file, declared, code) => {
    const checked = await checkFileForExtraction(file, declared);
    expect(checked).toMatchObject({ ok: false, error: code, log: { error_code: code } });
  });

  it("passes a file that is its type, with its page count", async () => {
    expect(await countPages(noPages, "application/pdf")).toBe(0);
    expect(await checkFileForExtraction({ ok: true, bytes: pdf(1) }, "application/pdf")).toEqual({ ok: true, pageCount: 1 });
    const max = EXTRACTION_LIMITS.maxPagesPerDocument;
    expect(await checkFileForExtraction({ ok: true, bytes: pdf(max) }, "application/pdf")).toEqual({ ok: true, pageCount: max });
    expect(await checkFileForExtraction({ ok: true, bytes: png }, "image/png")).toEqual({ ok: true, pageCount: 1 });
  });
});

describe("the Extract action", () => {
  const action = readFileSync(join(root, "src/app/app/extract-action.ts"), "utf8");

  it("returns the check's error before it calls enqueue_extraction_run, and enqueues only a counted page count", () => {
    const check = action.indexOf("await checkFileForExtraction(");
    const refused = action.indexOf("if (!checked.ok) {", check);
    const returned = action.indexOf("return { error: checked.error };", refused);
    const enqueue = action.indexOf('rpc("enqueue_extraction_run"');
    expect(check).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(check);
    expect(returned).toBeGreaterThan(refused);
    expect(enqueue).toBeGreaterThan(returned);
    expect(action).toContain("p_page_count: checked.pageCount");
    // no other way to the enqueue: it is called once, with no null count
    expect(action.match(/rpc\("enqueue_extraction_run"/g)).toHaveLength(1);
    expect(action).not.toMatch(/p_page_count: (null|pageCount)\b/);
  });
});
