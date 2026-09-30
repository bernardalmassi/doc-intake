// What the Extract action (src/app/app/extract-action.ts) checks about a
// document's file before it enqueues a run: the checks the worker's
// preflight would fail the run on (delivery.ts), so a run that is bound to
// fail is never queued, and the user gets the reason at once. A file that
// couldn't be downloaded, bytes that aren't the declared type, a PDF with no
// pages, more than maxPagesPerDocument, or pages that can't be counted: each
// is an error code, and no run. Otherwise the page count the enqueue
// records, which the worker recounts before any model call.
//
// Pure (the download happens in the action), so tests/unit/extract-check.test.ts
// can drive every branch.

import { checkPageCount, type ErrorCode } from "../errors";
import type { LogFields } from "../log";
import { countPages } from "./pages";
import { detectMimeType, isSupportedMimeType } from "./sniff";

// The action's download, with the code Storage's failure classified to.
export type FileForExtraction = { ok: true; bytes: Uint8Array } | { ok: false; error: ErrorCode };

export type ExtractCheck = { ok: true; pageCount: number } | { ok: false; error: ErrorCode; log: LogFields };

// Storage's codes a download failure keeps; anything else reads as the
// extraction's own download failure.
const DOWNLOAD_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "download.not_found",
  "auth.session_expired",
  "network.unavailable",
  "service.unavailable",
]);

export async function checkFileForExtraction(file: FileForExtraction, declaredMimeType: string | null): Promise<ExtractCheck> {
  if (!file.ok) {
    const error = DOWNLOAD_CODES.has(file.error) ? file.error : "extraction.download_failed";
    return { ok: false, error, log: { error_code: error } };
  }
  const size_bytes = file.bytes.length;
  const detected = detectMimeType(file.bytes);
  if (detected === null || !isSupportedMimeType(declaredMimeType) || detected !== declaredMimeType) {
    return {
      ok: false,
      error: "extraction.file_type_mismatch",
      log: {
        error_code: "extraction.file_type_mismatch",
        mime_type: isSupportedMimeType(declaredMimeType) ? declaredMimeType : null,
        detected_mime_type: detected,
        size_bytes,
      },
    };
  }
  const pages = await countPages(file.bytes, detected);
  const refused = checkPageCount(pages);
  if (refused || pages === null) {
    const error = refused ?? "document.pages_unreadable";
    return { ok: false, error, log: { error_code: error, mime_type: detected, size_bytes, page_count: pages } };
  }
  return { ok: true, pageCount: pages };
}
