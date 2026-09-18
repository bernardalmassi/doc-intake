// How an extracted value is compared with a fixture's expected value.
//
//   document_type, dates, currency   exact (currency case-insensitive)
//   total_amount                     the same number: 1250 = 1250.00
//   title, sender_name,              normalized text: Unicode NFKC, case,
//   recipient_name                   "&" as "and", punctuation and spacing
//                                    ignored; equal to the expected value or
//                                    one of the fixture's listed alternatives
//   reference_number                 letters and digits only, case ignored:
//                                    "INV-2026-0417" = "inv 2026 0417"
//   summary                          not scored for wording, only presence
//
// An absent expected value (null) is right only if the extraction is also
// absent; a value where the document has none is wrong (a hallucination),
// as is a missing value where the document has one.

import { FIELDS } from "@/lib/extraction/schema";
import { acceptedValues, type ExpectedValue } from "./fixtures";

export function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function normalizeReference(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function canonicalAmount(value: string): string | null {
  const match = /^-?(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return null;
  const int = match[1].replace(/^0+(?=\d)/, "");
  const frac = (match[2] ?? "").replace(/0+$/, "");
  return `${value.trim().startsWith("-") ? "-" : ""}${frac ? `${int}.${frac}` : int}`;
}

export type Comparison = "exact" | "amount" | "text" | "reference" | "presence";

export function comparisonFor(name: string): Comparison {
  if (name === "summary") return "presence";
  if (name === "reference_number") return "reference";
  const kind = FIELDS.find((f) => f.name === name)?.kind;
  if (kind === "amount") return "amount";
  if (kind === "text") return "text";
  return "exact";
}

export function valueMatches(name: string, expected: ExpectedValue, got: string | null): boolean {
  if (expected === null) return got === null;
  if (got === null) return false;
  const accepted = acceptedValues(expected);
  switch (comparisonFor(name)) {
    case "presence":
      return true;
    case "exact":
      return accepted.some((a) => a.toUpperCase() === got.toUpperCase());
    case "amount":
      return accepted.some((a) => canonicalAmount(a) !== null && canonicalAmount(a) === canonicalAmount(got));
    case "text":
      return accepted.some((a) => normalizeText(a) === normalizeText(got));
    case "reference":
      return accepted.some((a) => normalizeReference(a) === normalizeReference(got));
  }
}
