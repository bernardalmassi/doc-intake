// Number, size and time formatting for the organization page. Every
// function gives the same string on the server and in the browser (fixed
// locale, UTC), so nothing here can cause a hydration mismatch.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "18 Sep 2026, 04:12 UTC". Built by hand: Intl's en-GB month names differ
// between ICU versions ("Sep" or "Sept"). A table whose header already says
// UTC passes zone: false.
export function formatUtc(iso: string, { zone = true }: { zone?: boolean } = {}): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  const time = `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}, ${hours}:${minutes}`;
  return zone ? `${time} UTC` : time;
}

const integerFormat = new Intl.NumberFormat("en-US");

// 12408 -> "12,408"
export function formatCount(value: number): string {
  return integerFormat.format(value);
}

// Between a number and its unit, so "10 MB" never breaks across lines.
export const NBSP = "\u00a0";

// Binary units, as the 10 MB bucket limit is 10 × 1024 × 1024 bytes.
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}${NBSP}${bytes === 1 ? "byte" : "bytes"}`;
  const kb = bytes / 1024;
  // 1000 KB and up reads as MB, so a size never shows four digits of KB
  if (kb < 999.5) return `${kb < 100 ? kb.toFixed(1) : Math.round(kb)}${NBSP}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}${NBSP}MB`;
}

const KIND_LABELS: Record<string, string> = {
  "application/pdf": "PDF",
  "image/png": "PNG image",
  "image/jpeg": "JPEG image",
};

// What a stranger calls the file: "PDF", "PNG image". Null when unknown.
export function fileKind(mimeType: string | null | undefined): string | null {
  if (!mimeType) return null;
  return KIND_LABELS[mimeType] ?? null;
}

// US dollars. Runs cost fractions of a cent, so always four decimals: they
// line up in a column and the smallest real run still shows digits.
// Anything above zero that would round to $0.0000 says so.
export function formatUsd(value: number): string {
  if (value > 0 && value < 0.00005) return "<$0.0001";
  return `$${value.toFixed(4)}`;
}

// Milliseconds as seconds, always one decimal, so a column of them lines
// up: "3.2 s", "120.3 s".
export function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}${NBSP}s`;
}

// The time of day in UTC to the second: "09:29:20 UTC". For a running
// extraction's start, where minutes are too coarse.
export function formatClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const parts = [date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()].map((n) => String(n).padStart(2, "0"));
  return `${parts.join(":")} UTC`;
}
