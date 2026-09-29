// What the organization page derives from a document's runs
// (src/app/app/[slug]/entries.ts): whether its extraction is queued or
// running, whether its latest run stalled (the database ended it as
// abandoned or expired), whether a run still in flight is overdue (past the
// hard bound its own timestamps give it, judged against the render's time,
// src/lib/extraction/deadlines.ts), what Extract does, and whether the
// render shows anything in flight that isn't overdue, which is what keeps
// the page polling. No component reads a clock. Pure. Needs no database.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildEntries, extractionsInFlight, extractMode } from "@/app/app/[slug]/entries";
import type { DocumentRow, RunRow } from "@/app/app/[slug]/types";
import type { ErrorCode } from "@/lib/errors";

const root = fileURLToPath(new URL("../..", import.meta.url));
const NOW = Date.parse("2026-09-25T12:00:00Z");
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

function doc(status: string, id = "d1"): DocumentRow {
  return { id, filename: `${id}.pdf`, status, storage_path: `t/${id}`, size_bytes: 1, mime_type: "application/pdf", created_at: minutesAgo(60) };
}

function run(status: string, startedMinutesAgo: number, claimedMinutesAgo: number | null = null, documentId = "d1", errorCode: ErrorCode | null = null): RunRow {
  return {
    id: `r-${status}-${startedMinutesAgo}`,
    document_id: documentId,
    status,
    provider: null,
    model: null,
    attempts: 0,
    input_tokens: null,
    output_tokens: null,
    cost_usd: null,
    latency_ms: null,
    started_at: minutesAgo(startedMinutesAgo),
    claimed_at: claimedMinutesAgo === null ? null : minutesAgo(claimedMinutesAgo),
    error_code: errorCode,
    cost_estimated: false,
  };
}

// rendered at NOW
const entry = (document: DocumentRow, runs: RunRow[]) => buildEntries([document], runs, [], NOW)[0];

describe("an extraction's state on the page", () => {
  it("is queued until a worker claims the run, then running", () => {
    expect(entry(doc("processing"), [run("queued", 1)])).toMatchObject({ extraction: "queued", stalled: false });
    expect(entry(doc("processing"), [run("running", 2, 1)])).toMatchObject({ extraction: "running", stalled: false });
  });

  it("keeps Extract disabled until the run's hard bound, and past it shows the run stalled and gives Extract back (V5)", () => {
    // queued: overdue 12 min 5 s after its enqueue (deadlines.test.ts)
    const young = entry(doc("processing"), [run("queued", 12)]);
    expect(young).toMatchObject({ extraction: "queued", overdue: false });
    expect(extractMode(young)).toBe("running");
    const old = entry(doc("processing"), [run("queued", 13)]);
    expect(old).toMatchObject({ extraction: "queued", overdue: true, stalled: false });
    expect(extractMode(old)).toBe("again");
    // claimed: overdue 11 min after its claim, however long it was queued
    expect(entry(doc("processing"), [run("running", 30, 10)])).toMatchObject({ extraction: "running", overdue: false });
    expect(entry(doc("processing"), [run("running", 30, 12)])).toMatchObject({ extraction: "running", overdue: true });
    // a day-old run the database still has in flight is overdue
    expect(entry(doc("processing"), [run("running", 24 * 60, 24 * 60)])).toMatchObject({ overdue: true });
    // with no render time (the design preview's fixtures), nothing is
    expect(buildEntries([doc("processing")], [run("queued", 24 * 60)], [])[0]).toMatchObject({ overdue: false });
  });

  it("gives Extract as first or again when nothing is in flight", () => {
    expect(extractMode(entry(doc("pending"), []))).toBe("first");
    expect(extractMode(entry(doc("extracted"), [run("succeeded", 5, 4)]))).toBe("again");
    expect(extractMode(entry(doc("pending"), [run("failed", 12, 11, "d1", "extraction.abandoned")]))).toBe("again");
  });

  it("is stalled only once the database has ended the run as abandoned or expired", () => {
    expect(entry(doc("pending"), [run("failed", 12, 11, "d1", "extraction.abandoned")])).toMatchObject({ extraction: null, stalled: true });
    expect(entry(doc("pending"), [run("failed", 12, null, "d1", "extraction.expired")])).toMatchObject({ extraction: null, stalled: true });
    // any other failure is a failure, not a stall
    expect(entry(doc("pending"), [run("failed", 1, 1, "d1", "extraction.provider_timeout")])).toMatchObject({ stalled: false });
    // a new run after a stalled one is what the page shows
    expect(entry(doc("processing"), [run("queued", 1), run("failed", 30, 29, "d1", "extraction.abandoned")])).toMatchObject({
      extraction: "queued",
      stalled: false,
    });
  });

  it("is nothing once the document isn't processing or the latest run has ended", () => {
    expect(entry(doc("extracted"), [run("succeeded", 1)])).toMatchObject({ extraction: null, stalled: false });
    expect(entry(doc("pending"), [])).toMatchObject({ extraction: null, stalled: false });
    expect(entry(doc("processing"), [run("failed", 1)])).toMatchObject({ extraction: null, stalled: false });
  });
});

describe("extractionsInFlight", () => {
  it("is true while any run is queued or running and not overdue, and false otherwise, so polling stops at the bound", () => {
    expect(extractionsInFlight(buildEntries([doc("processing")], [run("queued", 1)], [], NOW))).toBe(true);
    expect(extractionsInFlight(buildEntries([doc("processing")], [run("running", 3, 1)], [], NOW))).toBe(true);
    expect(extractionsInFlight(buildEntries([doc("processing")], [run("queued", 12)], [], NOW))).toBe(true);
    // past its hard bound: shown stalled, no longer polled for
    expect(extractionsInFlight(buildEntries([doc("processing")], [run("queued", 13)], [], NOW))).toBe(false);
    expect(extractionsInFlight(buildEntries([doc("processing")], [run("queued", 24 * 60)], [], NOW))).toBe(false);
    expect(extractionsInFlight(buildEntries([doc("extracted")], [run("succeeded", 1)], [], NOW))).toBe(false);
    expect(extractionsInFlight(buildEntries([doc("pending")], [run("failed", 12, 11, "d1", "extraction.abandoned")], [], NOW))).toBe(false);
    expect(extractionsInFlight([])).toBe(false);
  });

  it("is true if any one document has a run in flight", () => {
    const entries = buildEntries(
      [doc("extracted", "d1"), doc("processing", "d2")],
      [run("succeeded", 5, 4, "d1"), run("queued", 1, null, "d2")],
      [],
      NOW,
    );
    expect(extractionsInFlight(entries)).toBe(true);
  });
});

describe("the page's components", () => {
  it("read no clock and no stale limit of their own: the render's time comes from page.tsx, the bound from deadlines.ts", () => {
    for (const file of ["entries.ts", "document-list.tsx", "run-history.tsx", "refresh-while-extracting.tsx", "poller.ts"]) {
      // the code, not the comments that say what it doesn't do
      const source = readFileSync(join(root, "src/app/app/[slug]", file), "utf8").replace(/^\s*\/\/.*$/gm, "");
      expect(source, file).not.toMatch(/Date\.now|new Date\(|staleRunMinutes|setInterval|router\.refresh/);
    }
  });
});
