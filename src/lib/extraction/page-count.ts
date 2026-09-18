// How many pages a PDF has, shared by the server (pages.ts, with node:zlib)
// and the browser (the upload form, with DecompressionStream). No imports
// that tie it to either: the caller supplies the decompression.
//
// Not a PDF parser. It reads the page tree's /Count and counts /Type /Page
// objects, in the file as written and inside compressed object streams
// (PDF 1.5+ often keeps every page object there), and takes the largest
// figure found. null when nothing could be read. A PDF built to hide its
// page tree could report fewer pages than it has (SECURITY.md, "Stale runs").
//
// The document is untrusted: decompression is capped per stream and in
// total, so a compression bomb costs at most a few megabytes of work.

// Inflates zlib (FlateDecode) data, returning null if it is damaged or would
// inflate past maxOutput bytes.
export type Inflate = (data: Uint8Array, maxOutput: number) => Promise<Uint8Array | null>;

const MAX_INFLATED_BYTES_PER_STREAM = 4 * 1024 * 1024;
const MAX_INFLATED_BYTES_TOTAL = 16 * 1024 * 1024;
const MAX_OBJECT_STREAMS = 500;

export async function countPdfPagesWith(bytes: Uint8Array, inflate: Inflate): Promise<number | null> {
  const text = latin1(bytes);
  let best = pagesIn(text);
  let budget = MAX_INFLATED_BYTES_TOTAL;
  let streams = 0;
  for (const stream of objectStreams(text, bytes)) {
    if (++streams > MAX_OBJECT_STREAMS || budget <= 0) break;
    const inflated = await inflate(stream, Math.min(MAX_INFLATED_BYTES_PER_STREAM, budget));
    if (inflated === null) continue; // damaged, not Flate, or over the cap
    budget -= inflated.length;
    best = maxOf(best, pagesIn(latin1(inflated)));
  }
  return best;
}

// The page tree's /Count, or else the number of page objects.
function pagesIn(text: string): number | null {
  let count: number | null = null;
  // a /Pages dictionary's /Count, either side of its /Type
  for (const match of text.matchAll(/<<(?:(?!<<|>>)[\s\S]){0,2000}?>>/g)) {
    const dict = match[0];
    if (!/\/Type\s*\/Pages\b/.test(dict)) continue;
    const n = /\/Count\s+(\d{1,7})\b/.exec(dict);
    if (n) count = maxOf(count, Number(n[1]));
  }
  const objects = text.match(/\/Type\s*\/Page(?![A-Za-z])/g)?.length ?? 0;
  return maxOf(count, objects > 0 ? objects : null);
}

// The raw bytes of every /Type /ObjStm stream with a Flate filter.
function* objectStreams(text: string, bytes: Uint8Array): Generator<Uint8Array> {
  const header = /<<((?:(?!<<|>>)[\s\S]){0,2000}?)>>\s*stream\r?\n/g;
  for (const match of text.matchAll(header)) {
    const dict = match[1];
    if (!/\/Type\s*\/ObjStm\b/.test(dict) || !/\/FlateDecode\b/.test(dict)) continue;
    const start = (match.index ?? 0) + match[0].length;
    const length = /\/Length\s+(\d{1,9})(?!\s+\d+\s+R)/.exec(dict);
    const end = length ? start + Number(length[1]) : text.indexOf("endstream", start);
    if (end <= start || end > bytes.length) continue;
    yield bytes.subarray(start, end);
  }
}

function latin1(bytes: Uint8Array): string {
  return new TextDecoder("latin1").decode(bytes);
}

function maxOf(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}
