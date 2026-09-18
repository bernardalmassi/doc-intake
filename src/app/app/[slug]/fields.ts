// Field labels and the status line for a document's extracted fields.
// Imported only by Server Components: FIELDS comes from the extraction
// schema module, which also holds the prompts, and none of it needs to
// reach the browser.

import { FIELDS } from "@/lib/extraction/schema";
import type { FieldRow } from "./types";

export function fieldLabel(name: string): string {
  return FIELDS.find((field) => field.name === name)?.label ?? name.replace(/_/g, " ");
}

export const BAND_LABELS: Record<string, string> = { high: "High", medium: "Medium", low: "Low" };

// The plain status line for a set of extracted fields, computed from the
// fields themselves: "9 of 10 fields found. 2 need checking: Due date and
// Total amount. 1 has a question."
export type FieldSummary = {
  // "9 of 10 fields found."
  found: string;
  // the low-confidence fields, the ones a person must check
  check: string | null;
  // the medium ones' questions, or that everything is high
  note: string | null;
};

export function fieldSummary(fields: FieldRow[]): FieldSummary {
  const found = fields.filter((field) => field.value !== null).length;
  const low = fields.filter((field) => field.band === "low");
  const medium = fields.filter((field) => field.band === "medium").length;

  let check: string | null = null;
  if (low.length > 0) {
    const names = low.map((field) => fieldLabel(field.name));
    const list = names.length <= 3 ? `: ${joinWords(names)}` : "";
    check = `${low.length} ${low.length === 1 ? "needs" : "need"} checking${list}.`;
  }
  const questions =
    medium > 0 ? `${medium} ${medium === 1 ? "has a question" : "have questions"} to confirm.` : null;

  return {
    found: `${found} of ${fields.length} ${fields.length === 1 ? "field" : "fields"} found.`,
    check,
    note: questions ?? (check ? null : "All read with high confidence."),
  };
}

function joinWords(words: string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}
