import { EXTRACTION_LIMITS } from "@/lib/extraction/config";
import { FIELDS } from "@/lib/extraction/schema";
import { UPLOAD_STALE_MINUTES } from "./document-state";
import type { DocumentEntry, DocumentRow, FieldRow, RunRow } from "./types";

const FIELD_ORDER = new Map(FIELDS.map((field, index) => [field.name, index]));

// Groups runs and fields under their documents and puts the list in the
// order it is shown: documents that need review first, then newest first.
// Pure, so the design preview runs the same grouping and sorting on
// fixture rows. `now` is passed in (milliseconds) to decide whether a
// running extraction, or an upload, has gone stale.
export function buildEntries(
  documents: DocumentRow[],
  runs: RunRow[],
  fields: FieldRow[],
  now: number,
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

  const staleBefore = now - EXTRACTION_LIMITS.staleRunMinutes * 60_000;
  const uploadStaleBefore = now - UPLOAD_STALE_MINUTES * 60_000;

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
    return { document, runs: documentRuns, fields: documentFields, staleRun, staleUpload };
  });

  return entries.toSorted((a, b) => {
    const reviewA = a.document.status === "needs_review" ? 0 : 1;
    const reviewB = b.document.status === "needs_review" ? 0 : 1;
    if (reviewA !== reviewB) return reviewA - reviewB;
    return Date.parse(b.document.created_at) - Date.parse(a.document.created_at);
  });
}
