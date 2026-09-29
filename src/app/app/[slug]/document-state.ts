// The one state a document card shows, of seven, worked out from what the
// page reads today: the document's status, its latest run and whether that
// run, or an upload, has gone stale. Pure, and presentation only: the
// database keeps its own statuses, and nothing here decides what anyone
// may do.
//
//   uploading     the row exists and its file is still on its way, for up
//                 to UPLOAD_STALE_MINUTES
//   ready         there is a file and nothing has been extracted: Extract
//   queued        waiting for a worker to pick it up. Nothing in the data
//                 says this yet, so documentState never returns it; when the
//                 worker adds a status for it, it adds one line below
//   running       an extraction is in progress
//   done          extracted, every field read with enough confidence
//   needs-review  extracted, and at least one field is Low
//   failed        no usable result: the latest extraction failed, it
//                 stalled, or the upload never finished

import type { ErrorCode } from "@/lib/errors";
import type { DocumentEntry } from "./types";

export const DOCUMENT_STATES = ["uploading", "ready", "queued", "running", "done", "needs-review", "failed"] as const;

// How long a row may stay uploading before it reads as an upload that
// never finished. Nothing in the database ends one (a row in uploading
// just stays there), so this is the page's own limit: ten minutes, the
// same as a run's, is far longer than 10 MB takes on a slow connection.
export const UPLOAD_STALE_MINUTES = 10;

export type DocumentState = (typeof DOCUMENT_STATES)[number];

// An entry that may carry its state explicitly. Only /dev/states sets it,
// to show queued before the data can say it; the page's entries never do,
// so documentState decides.
export type StatedEntry = DocumentEntry & { state?: DocumentState };

export function documentState({
  document,
  runs,
  staleRun,
  staleUpload,
}: Pick<DocumentEntry, "document" | "runs" | "staleRun" | "staleUpload">): DocumentState {
  const latest = runs[0];
  switch (document.status) {
    // The row exists and its file hasn't arrived. Another member's page, or
    // a refresh, can list it while the upload is still under way, so it
    // reads as uploading until the row is UPLOAD_STALE_MINUTES old; after
    // that its file never arrived, there is nothing to extract, and the
    // card says so.
    case "uploading":
      return staleUpload ? "failed" : "uploading";
    case "pending":
      // A failed extraction puts the document back to pending.
      return latest?.status === "failed" ? "failed" : "ready";
    case "processing":
      // Running longer than the stale limit: the next Extract click fails
      // it and starts again, so it reads as failed, with that exit.
      return staleRun ? "failed" : "running";
    case "extracted":
      return "done";
    case "needs_review":
      return "needs-review";
    case "failed":
      return "failed";
    // A status this build doesn't know yet still gets a card; ready is the
    // state that claims least.
    default:
      return "ready";
  }
}

// The state a card shows: the explicit one when a fixture gives it,
// otherwise the mapping.
export function stateOf(entry: StatedEntry): DocumentState {
  return entry.state ?? documentState(entry);
}

// What a failed line offers, from what its failure says to do:
//   extract   retrying can work (the catalog calls it retryable), or it
//             stalled, or nothing says why
//   delete    there is nothing to extract: the upload never finished, or
//             the file isn't what its type says ("Upload it again")
//   download  the service can't or won't read it ("Review it yourself")
// A failure that is the server's (not configured) is retried too, once
// it is set up.
export type FailedExit = "extract" | "delete" | "download";

const REVIEW_YOURSELF = new Set<ErrorCode>(["extraction.provider_rejected", "extraction.refused", "extraction.truncated"]);

export function failedExit({ document, runs, staleRun }: Pick<DocumentEntry, "document" | "runs" | "staleRun">): FailedExit {
  if (document.status === "uploading") return "delete";
  if (staleRun) return "extract";
  const code = runs[0]?.status === "failed" ? runs[0].error_code : null;
  if (code === "extraction.file_type_mismatch") return "delete";
  if (code !== null && REVIEW_YOURSELF.has(code)) return "download";
  return "extract";
}
