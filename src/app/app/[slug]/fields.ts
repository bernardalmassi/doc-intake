// Field labels and the status line for a document's extracted fields.
// Imported only by Server Components: FIELDS comes from the extraction
// schema module, which also holds the prompts, and none of it needs to
// reach the browser.

import { FIELDS } from "@/lib/extraction/schema";
import type { FieldRow } from "./types";

export function fieldLabel(name: string): string {
  return FIELDS.find((field) => field.name === name)?.label ?? name.replace(/_/g, " ");
}

// What Extract reads, from the schema's fixed list, as one sentence:
// "Extract reads 11 fields: document type, title, …, currency and
// summary." Said beside the first Extract a reader meets, and in the empty
// register's steps.
export function extractReads(): string {
  const names = FIELDS.map((field) => field.label.replace(/\s*\(.*\)$/, "").toLowerCase());
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names.join("");
  return `Extract reads ${names.length} fields: ${list}.`;
}

export const BAND_LABELS: Record<string, string> = { high: "High", medium: "Medium", low: "Low" };

// The register's detail line for an extracted document, computed from the
// fields themselves: "9 of 11 fields read, 2 not on the document. 1
// question to confirm." or, for one that needs review, "2 fields to check:
// Document date, Due date." A field is read when it has a value that isn't
// Low; one the document doesn't have is counted and said separately.
export type FieldSummary = {
  // "9 of 11 fields read, 2 not on the document."
  read: string;
  // the Low fields, the ones a person must check, or null
  check: string | null;
  // the Medium ones' questions, or null
  questions: string | null;
};

export function fieldSummary(fields: FieldRow[]): FieldSummary {
  const low = fields.filter((field) => field.band === "low");
  const medium = fields.filter((field) => field.band === "medium").length;
  const absent = fields.filter((field) => field.value === null).length;
  const read = fields.filter((field) => field.value !== null && field.band !== "low").length;

  let check: string | null = null;
  if (low.length > 0) {
    const names = low.map((field) => fieldLabel(field.name));
    const list = names.length <= 3 ? `: ${names.join(", ")}` : "";
    check = `${low.length} ${low.length === 1 ? "field" : "fields"} to check${list}.`;
  }

  return {
    read: `${read} of ${fields.length} ${fields.length === 1 ? "field" : "fields"} read${
      absent > 0 ? `, ${absent} not on the document` : ""
    }.`,
    check,
    questions: medium > 0 ? `${medium} ${medium === 1 ? "question" : "questions"} to confirm.` : null,
  };
}
