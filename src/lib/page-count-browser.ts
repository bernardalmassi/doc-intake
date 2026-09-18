// Page counts in the browser, for the upload form's check that a PDF has no
// more than EXTRACTION_LIMITS.maxPagesPerDocument pages. The same counting
// as the server (src/lib/extraction/page-count.ts), with the browser's
// DecompressionStream in place of node:zlib. A convenience only: anyone can
// skip it, so the Extract action counts again on the server and refuses
// there (SECURITY.md, "Stale runs").

import { countPdfPagesWith } from "./extraction/page-count";

export async function countPdfPagesInBrowser(file: Blob): Promise<number | null> {
  return countPdfPagesWith(new Uint8Array(await file.arrayBuffer()), inflateWithStreams);
}

// zlib-wrapped deflate ("deflate" in the Compression Streams API is RFC 1950,
// what PDF's FlateDecode uses), stopped as soon as it passes maxOutput. A
// stream that errors after producing output (bytes after its end, say)
// keeps what it produced, which is enough to count pages in.
export async function inflateWithStreams(data: Uint8Array, maxOutput: number): Promise<Uint8Array | null> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    const reader = new Blob([data.slice()]).stream().pipeThrough(new DecompressionStream("deflate")).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxOutput) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    if (total === 0) return null;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}
