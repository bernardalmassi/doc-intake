import { EXTRACTION_LIMITS } from "@/lib/extraction/config";
import { inFlight, isOverdue } from "@/lib/extraction/deadlines";
import { FIELDS } from "@/lib/extraction/schema";
import { UPLOAD_STALE_MINUTES } from "./document-state";
import { type DocumentEntry, type DocumentRow, type FieldRow, isStalled, type RunRow } from "./types";

const FIELD_ORDER = new Map(FIELDS.map((field, index) => [field.name, index]));

// Groups runs and fields under their documents and puts the list in the
// order it is shown: documents that need review first, then newest first.
// Pure, so the design preview runs the same grouping and sorting on
// fixture rows. `now` is the time of the render (page.tsx's request time,
// in milliseconds), against which a run still in flight is judged overdue
// and a running extraction, or an upload, stale; with none, nothing is.
export function buildEntries(
  documents: DocumentRow[],
  runs: RunRow[],
  fields: FieldRow[],
  now: number | null = null,
): DocumentEntry[] {
  const runsByDocument = new Map<string, RunRow[]>();
  for (const run of runs) {
    if (!run.document_id) continue;
    const list = runsByDocument.get(run.document_id) ?? [];
    list.push(run);
    runsByDocument.set(run.document_id, list);
  }

  const fieldsByDocument = new Map<string, FieldRow[]>();
  for (const field of fields) {
    const list = fieldsByDocument.get(field.document_id) ?? [];
    list.push(field);
    fieldsByDocument.set(field.document_id, list);
  }

  const staleBefore = now === null ? -Infinity : now - EXTRACTION_LIMITS.staleRunMinutes * 60_000;
  const uploadStaleBefore = now === null ? -Infinity : now - UPLOAD_STALE_MINUTES * 60_000;

  const entries = documents.map((document): DocumentEntry => {
    const documentRuns = (runsByDocument.get(document.id) ?? []).toSorted(
      (a, b) => Date.parse(b.started_at) - Date.parse(a.started_at),
    );
    const documentFields = (fieldsByDocument.get(document.id) ?? []).toSorted(
      (a, b) => (FIELD_ORDER.get(a.name) ?? FIELDS.length) - (FIELD_ORDER.get(b.name) ?? FIELDS.length),
    );
    const latest = documentRuns[0];
    const staleRun =
      document.status === "processing" &&
      latest !== undefined &&
      latest.status === "running" &&
      Date.parse(latest.started_at) < staleBefore;
    const staleUpload = document.status === "uploading" && Date.parse(document.created_at) < uploadStaleBefore;
    const extraction =
      document.status === "processing" && latest !== undefined && (latest.status === "queued" || latest.status === "running")
        ? latest.status
        : null;
    const stalled = latest !== undefined && isStalled(latest);
    const overdue = extraction !== null && now !== null && isOverdue(latest, now);
    return { document, runs: documentRuns, fields: documentFields, staleRun, staleUpload, stalled, overdue, extraction };
  });

  return entries.toSorted((a, b) => {
    const reviewA = a.document.status === "needs_review" ? 0 : 1;
    const reviewB = b.document.status === "needs_review" ? 0 : 1;
    if (reviewA !== reviewB) return reviewA - reviewB;
    return Date.parse(b.document.created_at) - Date.parse(a.document.created_at);
  });
}

// Whether this render shows any run queued or running, as the database has
// it, and not yet overdue. The page keeps refreshing while it does, and
// stops once two renders in a row say it doesn't (RefreshWhileExtracting):
// past its hard bound a run is shown stalled and no longer polled for.
export function extractionsInFlight(entries: DocumentEntry[]): boolean {
  return entries.some((entry) => !entry.overdue && entry.runs.some(inFlight));
}

// What the document's Extract button does: first, never extracted; again,
// there are earlier runs; running, disabled, while an extraction is in
// flight and not yet overdue. Once it is overdue the button comes back
// (again), and its enqueue ends the overdue run and starts a new one.
export function extractMode(entry: Pick<DocumentEntry, "document" | "runs" | "overdue">): "first" | "again" | "running" {
  if (entry.document.status === "processing" && !entry.overdue) return "running";
  return entry.runs.length > 0 ? "again" : "first";
}
