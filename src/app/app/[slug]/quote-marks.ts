// Which characters of a Low field's quote decide its value, so the page
// can underline those and set the rest of the quote plain. Presentation
// only: it reads the value and the quote the page already has.
//
// For a date (YYYY-MM-DD) the marked parts are the dates written in the
// quote that can be this value: a numeric date whose day and month are the
// value's, in either order (the order is what a reviewer is checking), and
// whose year, when it has one, is the value's. "Due 04/06/2026" and
// "ext. to 04/06" are marked for 2026-06-04; "05/03/2026", in the same
// quote, is not. A date written with the month's name ("5 March 2026") is
// marked only when no numeric date is. For any other value, its
// occurrences in the quote, ignoring case (and, for a number, written with
// thousands separators too). Nothing matched: nothing is marked.

export type QuotePart = { text: string; mark: boolean };

const NUMERIC_DATE = /(?<![\d/.-])\d{1,4}[/.-]\d{1,2}(?:[/.-]\d{2,4})?(?![\d/.-]*\d)/g;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const NAMED_DATE = /\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+(\d{2,4})\b/gi;

type Range = [start: number, end: number];

function yearMatches(written: number, year: number): boolean {
  return written === year || written === year % 100;
}

function dateRanges(quote: string, value: string): Range[] {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return [];
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const sameDayMonth = (a: number, b: number) => (a === day && b === month) || (a === month && b === day);

  const numeric: Range[] = [];
  for (const found of quote.matchAll(NUMERIC_DATE)) {
    const parts = found[0].split(/[/.-]/).map(Number);
    let ok: boolean;
    if (parts.length === 3 && parts[0] > 31) ok = parts[0] === year && sameDayMonth(parts[2], parts[1]);
    else ok = sameDayMonth(parts[0], parts[1]) && (parts.length === 2 || yearMatches(parts[2], year));
    if (ok) numeric.push([found.index, found.index + found[0].length]);
  }
  if (numeric.length > 0) return numeric;

  const named: Range[] = [];
  for (const found of quote.matchAll(NAMED_DATE)) {
    const monthIndex = MONTHS.indexOf(found[2].toLowerCase()) + 1;
    if (Number(found[1]) === day && monthIndex === month && yearMatches(Number(found[3]), year)) {
      named.push([found.index, found.index + found[0].length]);
    }
  }
  return named;
}

function withSeparators(value: string): string | null {
  const match = /^(\d+)(\.\d+)?$/.exec(value);
  if (!match || match[1].length < 4) return null;
  return `${match[1].replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${match[2] ?? ""}`;
}

function valueRanges(quote: string, value: string): Range[] {
  const haystack = quote.toLowerCase();
  const ranges: Range[] = [];
  for (const needle of [value, withSeparators(value)]) {
    if (!needle || needle.trim() === "") continue;
    const lower = needle.toLowerCase();
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(lower, from);
      if (at === -1) break;
      ranges.push([at, at + lower.length]);
      from = at + lower.length;
    }
  }
  return ranges;
}

export function quoteParts(quote: string, value: string | null): QuotePart[] {
  if (value === null) return [{ text: quote, mark: false }];
  const found = /^\d{4}-\d{2}-\d{2}$/.test(value) ? dateRanges(quote, value) : valueRanges(quote, value);
  const ranges = found.sort((a, b) => a[0] - b[0]).filter((range, index, all) => index === 0 || range[0] >= all[index - 1][1]);

  const parts: QuotePart[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) parts.push({ text: quote.slice(at, start), mark: false });
    parts.push({ text: quote.slice(start, end), mark: true });
    at = end;
  }
  if (at < quote.length) parts.push({ text: quote.slice(at), mark: false });
  return parts;
}
