import { FIELDS } from "@/lib/extraction/schema";
import { type DocumentEntry, type DocumentRow, type FieldRow, isStalled, type RunRow } from "./types";

const FIELD_ORDER = new Map(FIELDS.map((field, index) => [field.name, index]));

// Groups runs and fields under their documents and puts the list in the
// order it is shown: documents that need review first, then newest first.
// Pure, so the design preview runs the same grouping and sorting on
// fixture rows.
export function buildEntries(documents: DocumentRow[], runs: RunRow[], fields: FieldRow[]): DocumentEntry[] {
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

  const entries = documents.map((document): DocumentEntry => {
    const documentRuns = (runsByDocument.get(document.id) ?? []).toSorted(
      (a, b) => Date.parse(b.started_at) - Date.parse(a.started_at),
    );
    const documentFields = (fieldsByDocument.get(document.id) ?? []).toSorted(
      (a, b) => (FIELD_ORDER.get(a.name) ?? FIELDS.length) - (FIELD_ORDER.get(b.name) ?? FIELDS.length),
    );
    const latest = documentRuns[0];
    const extraction =
      document.status === "processing" && latest !== undefined && (latest.status === "queued" || latest.status === "running")
        ? latest.status
        : null;
    const stalled = latest !== undefined && isStalled(latest);
    return { document, runs: documentRuns, fields: documentFields, stalled, extraction };
  });

  return entries.toSorted((a, b) => {
    const reviewA = a.document.status === "needs_review" ? 0 : 1;
    const reviewB = b.document.status === "needs_review" ? 0 : 1;
    if (reviewA !== reviewB) return reviewA - reviewB;
    return Date.parse(b.document.created_at) - Date.parse(a.document.created_at);
  });
}

// Whether this render shows any run queued or running, as the database has
// it. The page keeps refreshing while it does, and stops once two renders in
// a row say it doesn't (RefreshWhileExtracting).
export function extractionsInFlight(entries: DocumentEntry[]): boolean {
  return entries.some((entry) => entry.runs.some((run) => run.status === "queued" || run.status === "running"));
}
