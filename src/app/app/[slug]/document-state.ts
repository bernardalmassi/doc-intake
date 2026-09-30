// The one state a document card shows, of seven, worked out from what the
// page reads today: the document's status, its latest run, whether that
// run is overdue (still in flight past the hard bound its own timestamps
// give it, src/lib/extraction/deadlines.ts) and whether an upload has gone
// stale. Pure, and presentation only: the database keeps its own
// statuses, and nothing here decides what anyone may do.
//
//   uploading     the row exists and its file is still on its way, for up
//                 to UPLOAD_STALE_MINUTES
//   ready         there is a file and nothing has been extracted: Extract
//   queued        Extract queued a run and no worker has claimed it yet
//   running       a worker claimed the run and is extracting
//   done          extracted, every field read with enough confidence
//   needs-review  extracted, and at least one field is Low
//   failed        no usable result: the latest extraction failed, the
//                 database ended it as abandoned or expired, it is
//                 overdue, or the upload never finished

import { ERROR_CATALOG, type ErrorCode, type RunNext } from "@/lib/errors";
import type { DocumentEntry, RunRow } from "./types";

export const DOCUMENT_STATES = ["uploading", "ready", "queued", "running", "done", "needs-review", "failed"] as const;

// How long a row may stay uploading before it reads as an upload that
// never finished. Nothing in the database ends one (a row in uploading
// just stays there), so this is the page's own limit: ten minutes, the
// same as a run's, is far longer than 10 MB takes on a slow connection.
export const UPLOAD_STALE_MINUTES = 10;

export type DocumentState = (typeof DOCUMENT_STATES)[number];

export function documentState({
  document,
  runs,
  overdue,
  extraction,
  staleUpload,
}: Pick<DocumentEntry, "document" | "runs" | "overdue" | "extraction" | "staleUpload">): DocumentState {
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
      // In flight past its hard bound: the database should have ended it
      // by now, and the next Extract click ends it and starts again
      // (extractMode in entries.ts), so it reads as failed, with that exit.
      // Before that, queued until a worker claims the run, then running.
      if (overdue) return "failed";
      return extraction === "queued" ? "queued" : "running";
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

// What a failed line offers, from what its failure says to do: the
// catalog's `next` for the latest run's code (src/lib/errors.ts).
//   extract   retry: retrying can work, or the failure is the server's to
//             fix (not configured); also a run that is overdue, and a
//             failure nothing says anything about
//   delete    upload: the file itself has to change ("Upload it again",
//             "Split it"), so there is nothing to extract; also an upload
//             that never finished
//   download  review: the service can't or won't read it ("Review it
//             yourself")
export type FailedExit = "extract" | "delete" | "download";

const EXITS: Record<RunNext, FailedExit> = { retry: "extract", upload: "delete", review: "download" };

// The catalog's next step for a run's failure; null for a run that didn't
// fail, and retry for a failure with no code.
export function runNext(run: Pick<RunRow, "status" | "error_code"> | undefined): RunNext | null {
  if (run?.status !== "failed") return null;
  const code: ErrorCode = run.error_code ?? "unknown";
  return ERROR_CATALOG[code].next ?? "retry";
}

export function failedExit({ document, runs, overdue }: Pick<DocumentEntry, "document" | "runs" | "overdue">): FailedExit {
  if (document.status === "uploading") return "delete";
  if (overdue) return "extract";
  return EXITS[runNext(runs[0]) ?? "retry"];
}
