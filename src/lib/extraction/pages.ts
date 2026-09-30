// How many pages a document has, on the server: the Extract action counts
// the file before enqueuing a run, refuses one over max_pages_per_document
// or one whose pages can't be counted, and sends the count to
// enqueue_extraction_run, which stores it for the run's estimate
// (20260925000002); the worker counts again before any model call
// (delivery.ts). The counting itself is page-count.ts, shared with the
// upload form.

import { inflateSync } from "node:zlib";
import { countPdfPagesWith } from "./page-count";
import type { SupportedMimeType } from "./sniff";

export async function countPages(bytes: Uint8Array, mimeType: SupportedMimeType): Promise<number | null> {
  if (mimeType !== "application/pdf") return 1;
  return countPdfPages(bytes);
}

export function countPdfPages(bytes: Uint8Array): Promise<number | null> {
  return countPdfPagesWith(bytes, async (data, maxOutput) => {
    try {
      return inflateSync(data, { maxOutputLength: maxOutput });
    } catch {
      return null;
    }
  });
}
