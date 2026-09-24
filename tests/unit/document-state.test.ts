// The document card shows one of six states, worked out from what the page
// reads today. These pin the mapping, so the worker that adds a queued
// status adds one line to it and one case here, and every card follows.

import { describe, expect, it } from "vitest";
import { DOCUMENT_STATES, documentState, stateOf } from "@/app/app/[slug]/document-state";
import type { DocumentEntry, RunRow } from "@/app/app/[slug]/types";

function run(status: string): RunRow {
  return {
    id: `run-${status}`,
    document_id: "doc",
    status,
    provider: null,
    model: null,
    attempts: 0,
    input_tokens: null,
    output_tokens: null,
    cost_usd: null,
    latency_ms: null,
    error_code: status === "failed" ? "extraction.invalid_answer" : null,
    cost_estimated: false,
    started_at: "2026-09-24T09:00:00.000Z",
  };
}

function entry(status: string, runs: string[] = [], staleRun = false): DocumentEntry {
  return {
    document: {
      id: "doc",
      filename: "test-invoice-messy-scan.pdf",
      status,
      storage_path: "tenant/doc",
      size_bytes: 478_223,
      mime_type: "application/pdf",
      created_at: "2026-09-19T14:02:10.000Z",
    },
    // newest first, as buildEntries sorts them
    runs: runs.map(run),
    fields: [],
    staleRun,
  };
}

describe("documentState", () => {
  it("reads a file with nothing extracted as ready", () => {
    expect(documentState(entry("pending"))).toBe("ready");
  });

  it("reads a document whose latest extraction failed as failed", () => {
    expect(documentState(entry("pending", ["failed", "succeeded"]))).toBe("failed");
  });

  it("reads an earlier failure followed by a success as the success's state", () => {
    expect(documentState(entry("extracted", ["succeeded", "failed"]))).toBe("done");
  });

  it("reads an extraction in progress as running", () => {
    expect(documentState(entry("processing", ["running"]))).toBe("running");
  });

  it("reads a stalled extraction as failed", () => {
    expect(documentState(entry("processing", ["running"], true))).toBe("failed");
  });

  it("reads extracted as done and needs_review as needs review", () => {
    expect(documentState(entry("extracted", ["succeeded"]))).toBe("done");
    expect(documentState(entry("needs_review", ["succeeded"]))).toBe("needs-review");
  });

  it("keeps needs review when a later extraction failed, since the fields are still there", () => {
    expect(documentState(entry("needs_review", ["failed", "succeeded"]))).toBe("needs-review");
  });

  it("reads an upload that never finished as failed", () => {
    expect(documentState(entry("uploading"))).toBe("failed");
  });

  it("reads the failed status as failed", () => {
    expect(documentState(entry("failed", ["failed"]))).toBe("failed");
  });

  it("reads a status it doesn't know as ready", () => {
    expect(documentState(entry("archived"))).toBe("ready");
  });

  it("never returns queued: nothing in the data says it yet", () => {
    const statuses = ["uploading", "pending", "processing", "extracted", "needs_review", "failed", "queued"];
    const runSets = [[], ["running"], ["failed"], ["succeeded"]];
    for (const status of statuses) {
      for (const runs of runSets) {
        for (const stale of [false, true]) {
          expect(documentState(entry(status, runs, stale))).not.toBe("queued");
        }
      }
    }
  });

  it("returns only the six states", () => {
    expect(DOCUMENT_STATES).toEqual(["ready", "queued", "running", "done", "needs-review", "failed"]);
  });
});

describe("stateOf", () => {
  it("prefers an explicit state, which only /dev/states sets", () => {
    expect(stateOf({ ...entry("pending"), state: "queued" })).toBe("queued");
  });

  it("falls back to the mapping", () => {
    expect(stateOf(entry("needs_review", ["succeeded"]))).toBe("needs-review");
  });
});
