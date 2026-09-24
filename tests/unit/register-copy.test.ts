// The organization page's register prints numbers and counts that the
// design review checks: times with one decimal so a column lines up, the
// running clock's start to the second, and the detail line's counts. No
// database, no network.

import { describe, expect, it } from "vitest";
import { fieldSummary } from "@/app/app/[slug]/fields";
import { formatClock, formatSeconds } from "@/app/app/[slug]/format";
import { roleAbilities } from "@/app/app/[slug]/messages";
import type { FieldRow } from "@/app/app/[slug]/types";

function field(name: string, value: string | null, band: string, question: string | null = null): FieldRow {
  return {
    document_id: "d",
    name,
    value,
    confidence: "0.900",
    band,
    source_text: null,
    clarifying_question: question,
  };
}

describe("formatSeconds", () => {
  it("always prints one decimal, so a column of times lines up", () => {
    expect(formatSeconds(7_412)).toBe("7.4 s");
    expect(formatSeconds(120_318)).toBe("120.3 s");
    expect(formatSeconds(8_000)).toBe("8.0 s");
  });
});

describe("formatClock", () => {
  it("gives the UTC time of day to the second", () => {
    expect(formatClock("2026-09-24T09:29:20.000Z")).toBe("09:29:20 UTC");
  });
});

describe("fieldSummary", () => {
  it("names the Low fields to check", () => {
    const summary = fieldSummary([
      field("title", "INVOICE", "high"),
      field("document_date", "2026-03-05", "low", "q"),
      field("due_date", "2026-06-04", "low", "q"),
    ]);
    expect(summary.check).toBe("2 fields to check: Document date, Due date.");
    expect(summary.read).toBe("1 of 3 fields read.");
  });

  it("counts absent values apart from read ones, and Medium questions", () => {
    const summary = fieldSummary([
      field("title", "Receipt", "high"),
      field("due_date", null, "high"),
      field("reference_number", "TC-1", "medium", "Is it?"),
    ]);
    expect(summary.read).toBe("2 of 3 fields read, 1 not on the document.");
    expect(summary.check).toBeNull();
    expect(summary.questions).toBe("1 question to confirm.");
  });
});

describe("roleAbilities", () => {
  it("says what each role can do, never the role's bare name", () => {
    for (const role of ["owner", "admin", "member"] as const) {
      expect(roleAbilities(role)).not.toMatch(/your role|owner|member/i);
    }
    expect(roleAbilities("owner")).toBe(roleAbilities("admin"));
    expect(roleAbilities("owner")).toMatch(/^Upload, extract, download and delete documents/);
    expect(roleAbilities("member")).toMatch(/An admin extracts and deletes them\.$/);
  });
});
