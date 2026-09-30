// The organization page's register as it renders (DocumentList, with
// stand-in operations): what each line says and offers, from entries built
// at a render time as page.tsx builds them. Every time bound comes from
// src/lib/extraction/deadlines.ts. No database, no network.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DocumentList } from "@/app/app/[slug]/document-list";
import { buildEntries } from "@/app/app/[slug]/entries";
import { type DocumentOperations, OperationsProvider } from "@/app/app/[slug]/operations";
import type { DocumentEntry, DocumentRow, FieldRow, RunRow } from "@/app/app/[slug]/types";
import type { ErrorCode } from "@/lib/errors";
import { overdueAt } from "@/lib/extraction/deadlines";

const T0 = Date.parse("2026-09-19T09:29:10Z");
const iso = (ms: number) => new Date(ms).toISOString();

const operations: DocumentOperations = {
  upload: async () => ({ ok: true }),
  extractAction: async () => ({}),
  deleteAction: async () => ({}),
  download: async () => ({}),
};

function doc(status: string, id = "d1"): DocumentRow {
  return {
    id,
    filename: `${id}.pdf`,
    status,
    storage_path: `t/${id}`,
    size_bytes: 1024,
    mime_type: "application/pdf",
    created_at: iso(T0 - 3_600_000),
  };
}

function run(status: string, input: Partial<RunRow> = {}): RunRow {
  return {
    id: `r-${status}-${input.started_at ?? T0}`,
    document_id: "d1",
    status,
    provider: null,
    model: null,
    attempts: 0,
    input_tokens: null,
    output_tokens: null,
    cost_usd: null,
    latency_ms: null,
    started_at: iso(T0),
    claimed_at: null,
    error_code: null as ErrorCode | null,
    cost_estimated: false,
    ...input,
  };
}

function lines(entries: DocumentEntry[], canManage = true): { html: string; text: string } {
  const html = renderToStaticMarkup(
    // children as createElement's third argument; the cast only says the
    // provider gets them
    createElement(
      OperationsProvider,
      { operations } as { operations: DocumentOperations; children: React.ReactNode },
      createElement(DocumentList, { entries, slug: "s", canManage }),
    ),
  );
  const text = html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
  return { html, text };
}

const at = (documents: DocumentRow[], runs: RunRow[], now: number, fields: FieldRow[] = []) =>
  buildEntries(documents, runs, fields, now);

describe("a line whose extraction is past its hard bound", () => {
  const claimed = run("running", { claimed_at: iso(T0 + 5_000) });
  const due = overdueAt(claimed)!;

  it("reads running until the bound, with no Extract", () => {
    const { html } = lines(at([doc("processing")], [claimed], due - 1));
    expect(html).toContain('data-doc-state="running"');
    expect(html).not.toContain('data-action="extract"');
  });

  it("reads failed from the bound on, says so without a duration, and gives Extract again back", () => {
    const { html, text } = lines(at([doc("processing")], [claimed], due));
    expect(html).toContain('data-doc-state="failed"');
    expect(text).toContain("This extraction should have finished by now and hasn't. Extract again ends it and starts a new one.");
    expect(text).toContain("Extract again");
    expect(html).toContain('data-action="extract"');
    expect(text).toContain("Stalled Stopped responding");
    expect(text).not.toMatch(/\d+ minutes/);
  });

  it("tells a member who can end it", () => {
    const { text } = lines(at([doc("processing")], [claimed], due), false);
    expect(text).toContain("This extraction should have finished by now and hasn't. Only an admin can extract it again.");
  });
});
