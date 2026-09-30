// The document card shows one of seven states, worked out from what the
// page reads: the document's status, its latest run (queued until a worker
// claims it, running after), whether that run is past its hard bound, and
// the upload's age. These pin the mapping, and every card follows.

import { describe, expect, it } from "vitest";
import { DOCUMENT_STATES, documentState, failedExit, UPLOAD_STALE_MINUTES } from "@/app/app/[slug]/document-state";
import { buildEntries } from "@/app/app/[slug]/entries";
import type { ErrorCode } from "@/lib/errors";
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

function entry(status: string, runs: string[] = [], overdue = false, staleUpload = false): DocumentEntry {
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
    staleUpload,
    stalled: false,
    overdue,
    // as buildEntries has it: the latest run, while the document is processing
    extraction: status === "processing" && (runs[0] === "queued" || runs[0] === "running") ? runs[0] : null,
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

  it("reads an extraction still in flight past its hard bound as failed", () => {
    expect(documentState(entry("processing", ["running"], true))).toBe("failed");
  });

  it("reads extracted as done and needs_review as needs review", () => {
    expect(documentState(entry("extracted", ["succeeded"]))).toBe("done");
    expect(documentState(entry("needs_review", ["succeeded"]))).toBe("needs-review");
  });

  it("keeps needs review when a later extraction failed, since the fields are still there", () => {
    expect(documentState(entry("needs_review", ["failed", "succeeded"]))).toBe("needs-review");
  });

  it("reads an upload still under way as uploading", () => {
    expect(documentState(entry("uploading"))).toBe("uploading");
  });

  it("reads an upload that never finished as failed", () => {
    expect(documentState(entry("uploading", [], false, true))).toBe("failed");
  });

  it("reads the failed status as failed", () => {
    expect(documentState(entry("failed", ["failed"]))).toBe("failed");
  });

  it("reads a status it doesn't know as ready", () => {
    expect(documentState(entry("archived"))).toBe("ready");
  });

  it("reads a run no worker has claimed yet as queued, and past its hard bound as failed", () => {
    expect(documentState(entry("processing", ["queued"]))).toBe("queued");
    expect(documentState(entry("processing", ["queued", "succeeded"]))).toBe("queued");
    expect(documentState(entry("processing", ["queued"], true))).toBe("failed");
    expect(failedExit(entry("processing", ["queued"], true))).toBe("extract");
  });

  it("reads queued only while the document is processing and its latest run is queued", () => {
    const statuses = ["uploading", "pending", "extracted", "needs_review", "failed"];
    for (const status of statuses) {
      expect(documentState(entry(status, ["queued"]))).not.toBe("queued");
    }
    expect(documentState(entry("processing", ["running", "queued"]))).toBe("running");
  });

  it("returns only the seven states", () => {
    expect(DOCUMENT_STATES).toEqual(["uploading", "ready", "queued", "running", "done", "needs-review", "failed"]);
  });
});

describe("an upload's age", () => {
  const created = Date.parse("2026-09-24T09:00:00.000Z");
  const row = (status: string) => ({
    id: "doc",
    filename: "meter-reading-unit-4.jpg",
    status,
    storage_path: "tenant/doc",
    size_bytes: null,
    mime_type: null,
    created_at: new Date(created).toISOString(),
  });
  const at = (minutes: number, status = "uploading") =>
    buildEntries([row(status)], [], [], created + minutes * 60_000)[0]!;

  it("is uploading until the row is UPLOAD_STALE_MINUTES old, and never finished after", () => {
    const past = UPLOAD_STALE_MINUTES + 0.01;
    expect(documentState(at(UPLOAD_STALE_MINUTES / 5))).toBe("uploading");
    expect(documentState(at(UPLOAD_STALE_MINUTES))).toBe("uploading");
    expect(at(past).staleUpload).toBe(true);
    expect(documentState(at(past))).toBe("failed");
    expect(failedExit(at(past))).toBe("delete");
  });

  it("only ever applies to a row that is uploading", () => {
    expect(at(UPLOAD_STALE_MINUTES * 6, "pending").staleUpload).toBe(false);
    expect(documentState(at(UPLOAD_STALE_MINUTES * 6, "pending"))).toBe("ready");
  });
});

describe("failedExit", () => {
  function failedWith(code: ErrorCode): DocumentEntry {
    const failed = entry("pending", ["failed"]);
    return { ...failed, runs: [{ ...failed.runs[0], error_code: code }] };
  }

  it("retries what the catalog says can be retried, and an overdue run", () => {
    expect(failedExit(failedWith("extraction.invalid_answer"))).toBe("extract");
    expect(failedExit(failedWith("extraction.provider_timeout"))).toBe("extract");
    expect(failedExit(failedWith("extraction.not_configured"))).toBe("extract");
    expect(failedExit(entry("processing", ["running"], true))).toBe("extract");
    expect(failedExit(entry("failed"))).toBe("extract");
  });

  it("offers Delete when there is nothing to extract", () => {
    expect(failedExit(entry("uploading"))).toBe("delete");
    expect(failedExit(failedWith("extraction.file_type_mismatch"))).toBe("delete");
  });

  it("offers the file when the catalog says to review it yourself", () => {
    expect(failedExit(failedWith("extraction.refused"))).toBe("download");
    expect(failedExit(failedWith("extraction.truncated"))).toBe("download");
    expect(failedExit(failedWith("extraction.provider_rejected"))).toBe("download");
  });
});
