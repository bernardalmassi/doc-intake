// The organization page's register as it renders (DocumentList, with
// stand-in operations): what each line says and offers, from entries built
// at a render time as page.tsx builds them. Every time bound comes from
// src/lib/extraction/deadlines.ts. No database, no network.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DocumentList } from "@/app/app/[slug]/document-list";
import { buildEntries, extractionsInFlight } from "@/app/app/[slug]/entries";
import { EXTRACT_REQUESTED, keepOrder, noteShown } from "@/app/app/[slug]/ledger";
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
    .replace(/\s+/g, " ")
    // a tag closed just before a full stop
    .replace(/ \./g, ".");
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

describe("a line's extraction states", () => {
  it("reads queued from the data: its enqueue time, and no Extract", () => {
    const queued = run("queued");
    const { html, text } = lines(at([doc("processing")], [queued], T0 + 12_000));
    expect(html).toContain('data-doc-state="queued"');
    expect(text).toContain("Queued 09:29:10 UTC");
    expect(html).not.toContain('data-action="extract"');
  });

  it("reads running from the claim, not the enqueue", () => {
    const claimed = run("running", { claimed_at: iso(T0 + 12_000) });
    const { html, text } = lines(at([doc("processing")], [claimed], T0 + 52_000));
    expect(html).toContain('data-doc-state="running"');
    expect(text).toContain("Started 09:29:22 UTC");
    expect(text).not.toContain("09:29:10");
  });

  it("reads a click on Extract as queued until the data that comes back takes over", () => {
    expect(EXTRACT_REQUESTED).toBe("queued");
  });

  it("stops polling once the only run in flight is past its bound", () => {
    const queued = run("queued");
    expect(extractionsInFlight(at([doc("processing")], [queued], overdueAt(queued)! - 1))).toBe(true);
    expect(extractionsInFlight(at([doc("processing")], [queued], overdueAt(queued)!))).toBe(false);
    expect(lines(at([doc("processing")], [queued], overdueAt(queued)!)).html).toContain('data-doc-state="failed"');
  });
});

describe("the register while the page polls", () => {
  it("keeps the order it arrived with, whatever the server's sort says later", () => {
    // d3 finished as needs review, which the server sorts first
    expect(keepOrder(["d1", "d2", "d3"], ["d3", "d1", "d2"])).toEqual(["d1", "d2", "d3"]);
    // a deleted line leaves
    expect(keepOrder(["d1", "d2", "d3"], ["d1", "d3"])).toEqual(["d1", "d3"]);
    // a new line goes where the server put it among the others
    expect(keepOrder(["d1", "d2"], ["d1", "new", "d2"])).toEqual(["d1", "new", "d2"]);
    expect(keepOrder(["d1", "d2"], ["new", "d2", "d1"])).toEqual(["new", "d1", "d2"]);
    expect(keepOrder(["d2", "d1"], ["d1", "a", "b", "d2"])).toEqual(["d2", "d1", "a", "b"]);
    // nothing kept yet: the server's order
    expect(keepOrder([], ["d3", "d1"])).toEqual(["d3", "d1"]);
  });

  it("says a line's state once when it changes, and nothing on arrival or when nothing changed", () => {
    const shown = new Map<string, string>();
    // the page's load, and a new line later: only noted
    expect(noteShown(shown, "d1", "queued:")).toBe(false);
    expect(noteShown(shown, "d2", "done:")).toBe(false);
    // a refresh that changed nothing
    expect(noteShown(shown, "d1", "queued:")).toBe(false);
    // queued to running: said once
    expect(noteShown(shown, "d1", "running:")).toBe(true);
    expect(noteShown(shown, "d1", "running:")).toBe(false);
    expect(noteShown(shown, "d1", "needs-review:2")).toBe(true);
    expect(noteShown(shown, "d2", "done:")).toBe(false);
  });

  it("renders its polite region empty on arrival", () => {
    const { html } = lines(at([doc("processing")], [run("queued")], T0 + 12_000));
    // on arrival the region is there and empty
    expect(html).toMatch(/<div aria-live="polite" class="sr-only"><\/div>/);
  });
});

describe("Extract again in the runs row", () => {
  // a document read once, extracted again: the fields stay while the new run is in flight
  const done = run("succeeded", { id: "r-done", started_at: iso(T0 - 600_000), claimed_at: iso(T0 - 590_000), attempts: 1, cost_usd: "0.01" });
  const fields: FieldRow[] = [
    { document_id: "d1", name: "title", value: "Invoice", confidence: "0.950", band: "high", source_text: "INVOICE", clarifying_question: null },
  ];

  it("shows when nothing is in flight", () => {
    const { html } = lines(at([doc("extracted")], [done], T0, fields));
    expect(html).toContain('data-action="extract"');
  });

  it("isn't there while a run is queued or running, and comes back past its bound", () => {
    const queued = run("queued");
    for (const inFlight of [queued, run("running", { claimed_at: iso(T0 + 5_000) })]) {
      const { html } = lines(at([doc("processing")], [inFlight, done], T0 + 30_000, fields));
      expect(html, inFlight.status).not.toContain('data-action="extract"');
    }
    const late = lines(at([doc("processing")], [queued, done], overdueAt(queued)!, fields));
    expect(late.html).toContain('data-doc-state="failed"');
    // once, as the line's exit
    expect(late.html.match(/data-action="extract"/g)).toHaveLength(1);
  });
});

describe("the fields line", () => {
  const read = run("succeeded", {
    id: "r-read",
    started_at: iso(Date.parse("2026-09-19T09:30:40Z")),
    claimed_at: iso(Date.parse("2026-09-19T09:31:02Z")),
    attempts: 1,
    cost_usd: "0.02",
  });
  const fields: FieldRow[] = [
    { document_id: "d1", run_id: "r-read", name: "title", value: "Invoice", confidence: "0.950", band: "high", source_text: "INVOICE", clarifying_question: null },
  ];
  const failedLater = run("failed", {
    id: "r-later",
    started_at: iso(T0 + 600_000),
    claimed_at: iso(T0 + 605_000),
    attempts: 1,
    cost_usd: "0.01",
    error_code: "extraction.provider_timeout",
  });

  it("names the run the fields are from, by when it started, once a later run failed", () => {
    const { text } = lines(at([doc("extracted")], [failedLater, read], T0 + 700_000, fields));
    expect(text).toContain(
      "The latest run failed. The extraction service took too long to respond. Try again in a few minutes. The fields below are from the run started 19 Sep 2026, 09:31 UTC.",
    );
  });

  it("names it while a new run is in flight", () => {
    const { text } = lines(at([doc("processing")], [run("queued", { started_at: iso(T0 + 600_000) }), read], T0 + 610_000, fields));
    expect(text).toContain("The fields below are from the run started 19 Sep 2026, 09:31 UTC.");
  });

  it("says nothing of it when the fields are from the latest run", () => {
    const { text } = lines(at([doc("extracted")], [read], T0, fields));
    expect(text).not.toContain("The fields below are from");
  });
});
