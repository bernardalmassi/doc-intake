// A Low field's quote underlines only the characters that decide its
// value, and sets the rest plain. No database, no network.

import { describe, expect, it } from "vitest";
import { quoteParts } from "@/app/app/[slug]/quote-marks";

const marked = (quote: string, value: string | null) =>
  quoteParts(quote, value)
    .filter((part) => part.mark)
    .map((part) => part.text);

describe("quoteParts", () => {
  it("marks the numeric dates that can be the value, in either day-month order", () => {
    const quote =
      "Due 04/06/2026; handwritten note 'ext. to 04/06 per DK'; terms 30 days net from 05/03/2026 would give 04/04/2026, not 04/06/2026, suggesting the due date was manually extended";
    expect(marked(quote, "2026-06-04")).toEqual(["04/06/2026", "04/06", "04/06/2026"]);
  });

  it("marks the written date and leaves the reasoning plain", () => {
    const quote =
      "Date 05/03/2026; UK company (Sheffield/Barnsley addresses, VAT GB 419 7732 05), day-first convention supports 5 March 2026";
    expect(marked(quote, "2026-03-05")).toEqual(["05/03/2026"]);
  });

  it("falls back to a date with the month's name", () => {
    expect(marked("11 SEP 2026 10:42", "2026-09-11")).toEqual(["11 SEP 2026"]);
  });

  it("marks a number written with separators, and a plain value ignoring case", () => {
    expect(marked("TOTAL DUE 2,046.26", "2046.26")).toEqual(["2,046.26"]);
    expect(marked("Receipt No. TC-118204 Till 3", "tc-118204")).toEqual(["TC-118204"]);
  });

  it("keeps every character, in order", () => {
    const quote = "Date 05/03/2026; the rest";
    expect(
      quoteParts(quote, "2026-03-05")
        .map((part) => part.text)
        .join(""),
    ).toBe(quote);
  });

  it("marks nothing when nothing matches or there is no value", () => {
    expect(marked("Terms 30 days net", "2026-01-01")).toEqual([]);
    expect(marked("Terms 30 days net", null)).toEqual([]);
  });
});
