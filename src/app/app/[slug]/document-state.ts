// The one state a document card shows, of six, worked out from what the
// page reads today: the document's status, its latest run and whether that
// run has gone stale. Pure, and presentation only: the database keeps its
// own statuses, and nothing here decides what anyone may do.
//
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

export const DOCUMENT_STATES = ["ready", "queued", "running", "done", "needs-review", "failed"] as const;

export type DocumentState = (typeof DOCUMENT_STATES)[number];

// An entry that may carry its state explicitly. Only /dev/states sets it,
// to show queued before the data can say it; the page's entries never do,
// so documentState decides.
export type StatedEntry = DocumentEntry & { state?: DocumentState };

export function documentState({ document, runs, staleRun }: Pick<DocumentEntry, "document" | "runs" | "staleRun">): DocumentState {
  const latest = runs[0];
  switch (document.status) {
    // The row exists but its file never arrived: nothing to extract, and
    // the card says so. (A row mid-upload is in this status for the few
    // seconds its upload takes; the uploader's own page doesn't list it
    // until the upload ends.)
    case "uploading":
      return "failed";
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
