import { classifyRunError, isCostEstimated, type ErrorCode } from "@/lib/errors";

// What the organization page reads, and what its components take. page.tsx
// fetches these rows and the components only render them, so the design
// preview can render the same components from fixture rows.

export type Role = "owner" | "admin" | "member";

export type Organization = { id: string; name: string; slug: string };

export type DocumentRow = {
  id: string;
  filename: string;
  // uploading, pending, processing, extracted, needs_review, failed
  status: string;
  storage_path: string;
  size_bytes: number | null;
  mime_type: string | null;
  created_at: string;
};

// A run as page.tsx reads it. `error` is the text stored on a failed run,
// written for engineers (src/lib/extraction/run.ts, extract-action.ts):
// it can quote a provider's or Storage's message, so it never goes further
// than page.tsx, which turns it into a code with toRunRow.
export type RunRecord = {
  id: string;
  document_id: string | null;
  // queued, running, succeeded, failed
  status: string;
  provider: string | null;
  model: string | null;
  attempts: number;
  input_tokens: number | null;
  output_tokens: number | null;
  // numeric(12, 8): PostgREST may send it as a string
  cost_usd: number | string | null;
  latency_ms: number | null;
  error: string | null;
  // when the run was enqueued, or opened before the queue
  started_at: string;
  // when a worker claimed it; null while queued, and for runs from before
  // the queue. Optional so rows built without it (the design preview's
  // fixtures) still type.
  claimed_at?: string | null;
};

// A run as the components get it: the stored error only as its code from
// src/lib/errors.ts, so no component can render the stored text, and a
// failure one admin's run recorded reads the same to every member.
// cost_estimated: the run was charged at the dearest price on file because
// the database couldn't price the model that answered it, so `model` names
// the price it was charged at, not the model (failedCloseAttempts in
// src/lib/extraction/run.ts).
export type RunRow = Omit<RunRecord, "error"> & { error_code: ErrorCode | null; cost_estimated: boolean };

export function toRunRow({ error, ...run }: RunRecord): RunRow {
  return {
    ...run,
    error_code: error === null ? null : classifyRunError(error),
    cost_estimated: run.cost_usd !== null && isCostEstimated(error),
  };
}

// A run the database ended because nothing finished it in time: abandoned
// (claimed, and its worker never finished) or expired (never claimed). The
// page also calls a document stalled while its run is still in flight past
// the hard bound its own timestamps give it (overdue in DocumentEntry,
// src/lib/extraction/deadlines.ts); nothing else is judged by the clock.
export function isStalled(run: Pick<RunRow, "status" | "error_code">): boolean {
  return run.status === "failed" && (run.error_code === "extraction.abandoned" || run.error_code === "extraction.expired");
}

export type FieldRow = {
  document_id: string;
  // the run that wrote the field: a document's fields are all from its
  // last successful run. Optional so rows built without it (the design
  // preview's fixtures, tests) still type.
  run_id?: string | null;
  name: string;
  value: string | null;
  // numeric(4, 3): may arrive as a string
  confidence: number | string;
  // high, medium, low
  band: string;
  source_text: string | null;
  clarifying_question: string | null;
};

// One document with everything shown about it.
export type DocumentEntry = {
  document: DocumentRow;
  // newest first
  runs: RunRow[];
  // in the order of FIELDS in src/lib/extraction/schema.ts
  fields: FieldRow[];
  // uploading, and the row is older than UPLOAD_STALE_MINUTES
  // (document-state.ts), so its upload never finished
  staleUpload: boolean;
  // its latest run was ended by the database because nothing finished it
  // in time: abandoned or expired (isStalled in entries.ts)
  stalled: boolean;
  // its latest run is still in flight, as the database has it, past the
  // hard bound its own timestamps give it (overdueAt in
  // src/lib/extraction/deadlines.ts): the database should have ended it
  // by now. The page shows it stalled, stops polling for it and gives
  // Extract back, whose enqueue ends it. Decided at render time, with the
  // time page.tsx passes to buildEntries.
  overdue: boolean;
  // while the document is processing and its latest run is in flight:
  // queued until a worker claims the run, running after that; otherwise null
  extraction: "queued" | "running" | null;
};
