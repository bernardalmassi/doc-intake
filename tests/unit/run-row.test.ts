// The organization page reads each run's stored error, which any admin can
// set to any text by closing a run over the API, and turns it into a code
// before any component sees the row. These tests hold that boundary: what
// leaves toRunRow carries a code from the catalog and nothing of the text.

import { describe, expect, it } from "vitest";
import { type RunRecord, toRunRow } from "@/app/app/[slug]/types";
import { isErrorCode, RUN_ERROR_MARKERS } from "@/lib/errors";

const base: RunRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  document_id: "22222222-2222-4222-8222-222222222222",
  status: "failed",
  provider: null,
  model: null,
  attempts: 0,
  input_tokens: null,
  output_tokens: null,
  cost_usd: null,
  latency_ms: null,
  error: null,
  started_at: "2026-09-18T09:00:00.000Z",
};

describe("toRunRow", () => {
  it("drops the stored text and keeps only a code", () => {
    const planted = "Your account needs re-verification at https://evil.example/login";
    const row = toRunRow({ ...base, error: planted });
    expect(row).not.toHaveProperty("error");
    expect(row.error_code).toBe("unknown");
    expect(JSON.stringify(row)).not.toContain("evil.example");
  });

  it("gives an app-written failure its own code, still without the text", () => {
    const stored = `${RUN_ERROR_MARKERS.downloadFailed}: download.not_found`;
    const row = toRunRow({ ...base, error: stored });
    expect(row.error_code).toBe("extraction.download_failed");
    expect(JSON.stringify(row)).not.toContain(stored);
  });

  it("hides text that starts like an app-written failure", () => {
    const planted = `${RUN_ERROR_MARKERS.typeMismatch}application/pdf) visit https://evil.example`;
    const row = toRunRow({ ...base, error: planted });
    expect(isErrorCode(row.error_code)).toBe(true);
    expect(JSON.stringify(row)).not.toContain("evil.example");
  });

  it("keeps a run without an error as null, and every other field as read", () => {
    const row = toRunRow({ ...base, status: "succeeded", cost_usd: "0.00123000" });
    expect(row.error_code).toBeNull();
    expect(row.cost_usd).toBe("0.00123000");
    expect(row.started_at).toBe(base.started_at);
  });
});
