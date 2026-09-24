// What the organization page derives from a document's runs
// (src/app/app/[slug]/entries.ts): whether its extraction is queued or
// running, whether it has gone stale, measured as the database measures it
// (from the claim once there is one), and whether the page keeps polling.
// Pure. Needs no database.

import { describe, expect, it } from "vitest";
import { buildEntries, shouldPoll } from "@/app/app/[slug]/entries";
import type { DocumentRow, RunRow } from "@/app/app/[slug]/types";
import { EXTRACTION_LIMITS } from "@/lib/extraction/config";

const NOW = Date.parse("2026-09-25T12:00:00Z");
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const STALE = EXTRACTION_LIMITS.staleRunMinutes;

function doc(status: string, id = "d1"): DocumentRow {
  return { id, filename: `${id}.pdf`, status, storage_path: `t/${id}`, size_bytes: 1, mime_type: "application/pdf", created_at: minutesAgo(60) };
}

function run(status: string, startedMinutesAgo: number, claimedMinutesAgo: number | null = null, documentId = "d1"): RunRow {
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
    error_code: null,
    cost_estimated: false,
  };
}

const entry = (document: DocumentRow, runs: RunRow[]) => buildEntries([document], runs, [], NOW)[0];

describe("an extraction's state on the page", () => {
  it("is queued until a worker claims the run, then running", () => {
    expect(entry(doc("processing"), [run("queued", 1)])).toMatchObject({ extraction: "queued", staleRun: false });
    expect(entry(doc("processing"), [run("running", 2, 1)])).toMatchObject({ extraction: "running", staleRun: false });
  });

  it("goes stale after the stale limit, from the claim once there is one", () => {
    expect(entry(doc("processing"), [run("queued", STALE + 1)])).toMatchObject({ extraction: null, staleRun: true });
    // enqueued long ago, claimed recently: still running
    expect(entry(doc("processing"), [run("running", STALE + 5, 1)])).toMatchObject({ extraction: "running", staleRun: false });
    expect(entry(doc("processing"), [run("running", STALE + 5, STALE + 1)])).toMatchObject({ extraction: null, staleRun: true });
    // a run from before the queue has no claim: from its start
    expect(entry(doc("processing"), [run("running", STALE + 1)])).toMatchObject({ staleRun: true });
  });

  it("is nothing once the document isn't processing or the latest run has ended", () => {
    expect(entry(doc("extracted"), [run("succeeded", 1)])).toMatchObject({ extraction: null, staleRun: false });
    expect(entry(doc("pending"), [])).toMatchObject({ extraction: null, staleRun: false });
    expect(entry(doc("processing"), [run("failed", 1)])).toMatchObject({ extraction: null, staleRun: false });
  });
});

describe("shouldPoll", () => {
  it("polls while a document is processing and its run isn't stale, and stops otherwise", () => {
    expect(shouldPoll(buildEntries([doc("processing")], [run("queued", 1)], [], NOW))).toBe(true);
    expect(shouldPoll(buildEntries([doc("processing")], [run("running", 3, 1)], [], NOW))).toBe(true);
    expect(shouldPoll(buildEntries([doc("processing")], [run("queued", STALE + 1)], [], NOW))).toBe(false);
    expect(shouldPoll(buildEntries([doc("extracted")], [run("succeeded", 1)], [], NOW))).toBe(false);
    expect(shouldPoll([])).toBe(false);
  });

  it("polls if any one document is extracting", () => {
    const entries = buildEntries(
      [doc("extracted", "d1"), doc("processing", "d2")],
      [run("succeeded", 5, 4, "d1"), run("queued", 1, null, "d2")],
      [],
      NOW,
    );
    expect(shouldPoll(entries)).toBe(true);
  });
});
