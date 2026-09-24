import { EXTRACTION_LIMITS } from "@/lib/extraction/config";
import { FIELDS } from "@/lib/extraction/schema";
import type { DocumentEntry, DocumentRow, FieldRow, RunRow } from "./types";

const FIELD_ORDER = new Map(FIELDS.map((field, index) => [field.name, index]));

// Groups runs and fields under their documents and puts the list in the
// order it is shown: documents that need review first, then newest first.
// Pure, so the design preview runs the same grouping and sorting on
// fixture rows. `now` is passed in (milliseconds) to decide whether an
// extraction in flight has gone stale.
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

  const entries = documents.map((document): DocumentEntry => {
    const documentRuns = (runsByDocument.get(document.id) ?? []).toSorted(
      (a, b) => Date.parse(b.started_at) - Date.parse(a.started_at),
    );
    const documentFields = (fieldsByDocument.get(document.id) ?? []).toSorted(
      (a, b) => (FIELD_ORDER.get(a.name) ?? FIELDS.length) - (FIELD_ORDER.get(b.name) ?? FIELDS.length),
    );
    const latest = documentRuns[0];
    const inFlight =
      document.status === "processing" &&
      latest !== undefined &&
      (latest.status === "queued" || latest.status === "running");
    // measured as the database measures it: from the claim once there is
    // one, otherwise from the enqueue
    const staleRun = inFlight && Date.parse(latest.claimed_at ?? latest.started_at) < staleBefore;
    const extraction = inFlight && !staleRun ? (latest.status as "queued" | "running") : null;
    return { document, runs: documentRuns, fields: documentFields, staleRun, extraction };
  });

  return entries.toSorted((a, b) => {
    const reviewA = a.document.status === "needs_review" ? 0 : 1;
    const reviewB = b.document.status === "needs_review" ? 0 : 1;
    if (reviewA !== reviewB) return reviewA - reviewB;
    return Date.parse(b.document.created_at) - Date.parse(a.document.created_at);
  });
}

// Whether the page should keep refreshing: some document is processing and
// its run isn't stale. Polling stops when every run has ended, or when one
// has gone stale (the sweep ends it within a minute; the next render after
// that shows it).
export function shouldPoll(entries: DocumentEntry[]): boolean {
  return entries.some((entry) => entry.document.status === "processing" && !entry.staleRun);
}
