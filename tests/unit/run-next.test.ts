// Every code a run can end with says what its document's line offers next
// (ERROR_CATALOG[code].next beside retryable): retry, upload or review,
// and failedExit reads it: Extract again, Delete, or Download. One case per
// code. No database, no network.

import { describe, expect, it } from "vitest";
import { failedExit, runNext } from "@/app/app/[slug]/document-state";
import type { DocumentEntry, RunRow } from "@/app/app/[slug]/types";
import {
  classifyRunError,
  ERROR_CATALOG,
  ERROR_CODES,
  type ErrorCode,
  RUN_ERROR_MARKERS,
  type RunNext,
} from "@/lib/errors";

const NEXT: [ErrorCode, RunNext, ReturnType<typeof failedExit>][] = [
  ["unknown", "retry", "extract"],
  ["document.too_many_pages", "upload", "delete"],
  ["document.pages_unreadable", "upload", "delete"],
  ["document.no_pages", "upload", "delete"],
  ["extraction.not_configured", "retry", "extract"],
  ["extraction.download_failed", "retry", "extract"],
  ["extraction.page_count_mismatch", "retry", "extract"],
  ["extraction.file_type_mismatch", "upload", "delete"],
  ["extraction.provider_timeout", "retry", "extract"],
  ["extraction.provider_unavailable", "retry", "extract"],
  ["extraction.all_providers_failed", "retry", "extract"],
  ["extraction.provider_rejected", "review", "download"],
  ["extraction.refused", "review", "download"],
  ["extraction.truncated", "review", "download"],
  ["extraction.answer_incomplete", "retry", "extract"],
  ["extraction.invalid_answer", "retry", "extract"],
  ["extraction.too_dense", "upload", "delete"],
  ["extraction.abandoned", "retry", "extract"],
  ["extraction.expired", "retry", "extract"],
  ["extraction.result_not_saved", "retry", "extract"],
  ["extraction.record_failed", "retry", "extract"],
];

function failedWith(code: ErrorCode | null): DocumentEntry {
  const run: RunRow = {
    id: "r",
    document_id: "d",
    status: "failed",
    provider: null,
    model: null,
    attempts: 0,
    input_tokens: null,
    output_tokens: null,
    cost_usd: null,
    latency_ms: null,
    started_at: "2026-09-24T09:00:00.000Z",
    error_code: code,
    cost_estimated: false,
  };
  return {
    document: { id: "d", filename: "d.pdf", status: "pending", storage_path: "t/d", size_bytes: 1, mime_type: "application/pdf", created_at: "2026-09-24T08:00:00.000Z" },
    runs: [run],
    fields: [],
    staleUpload: false,
    stalled: false,
    overdue: false,
    extraction: null,
  };
}

describe("a run's next step", () => {
  it.each(NEXT)("%s: %s, so the line offers %s", (code, next, exit) => {
    expect(ERROR_CATALOG[code].next).toBe(next);
    expect(failedExit(failedWith(code))).toBe(exit);
  });

  it("is given for these codes and no others", () => {
    expect(ERROR_CODES.filter((code) => ERROR_CATALOG[code].next !== undefined).toSorted()).toEqual(
      NEXT.map(([code]) => code).toSorted(),
    );
  });

  it("is given for every code a stored run error classifies as", () => {
    const markers = Object.values(RUN_ERROR_MARKERS);
    for (const marker of markers) {
      const code = classifyRunError(`${marker}whatever follows`);
      expect(ERROR_CATALOG[code].next, `${marker} -> ${code}`).toBeDefined();
    }
  });

  it("is retry for a failure with no code, and nothing for a run that didn't fail", () => {
    expect(failedExit(failedWith(null))).toBe("extract");
    expect(runNext({ status: "succeeded", error_code: null })).toBeNull();
    expect(runNext({ status: "queued", error_code: null })).toBeNull();
    expect(runNext(undefined)).toBeNull();
  });

  it("is retry for every retryable code, and upload or review only for codes that aren't", () => {
    for (const [code, next] of NEXT) {
      if (ERROR_CATALOG[code].retryable) expect(next, code).toBe("retry");
    }
  });
});
