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
//
// Scores use the stored result, after the output guard and gating: the
// value that would be written and the confidence it would be written with.

import type { ConfidenceBand, ProviderName } from "@/lib/extraction/config";
import type { RunOutcome } from "@/lib/extraction/run";
import { FIELD_NAMES, FIELDS } from "@/lib/extraction/schema";
import { acceptedValues, type ExpectedValue, expectedValue, type Fixture } from "./fixtures";

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

// Scoring a run ---------------------------------------------------------------

export type FieldResult = {
  fixture: string;
  provider: ProviderName;
  field: string;
  expected: string | null;
  got: string | null;
  correct: boolean;
  // what was stored, after the output guard; null when the run failed
  confidence: number | null;
  band: ConfidenceBand | null;
  flagged: boolean;
};

// A failed run writes nothing, so every field counts as wrong, absent ones
// included: nothing established that they were absent.
export function scoreRun(fixture: Fixture, provider: ProviderName, outcome: RunOutcome): FieldResult[] {
  return FIELD_NAMES.map((name) => {
    const expected = fixture.expected[name] ?? null;
    const field = outcome.status === "succeeded" ? outcome.fields.find((f) => f.name === name) : undefined;
    const got = field?.value ?? null;
    return {
      fixture: fixture.id,
      provider,
      field: name,
      expected: expectedValue(expected),
      got,
      correct: field !== undefined && valueMatches(name, expected, got),
      confidence: field?.confidence ?? null,
      band: field?.band ?? null,
      flagged: (field?.flags.length ?? 0) > 0,
    };
  });
}

// Aggregates ---------------------------------------------------------------------

export type Tally = { correct: number; total: number };

export function tally(results: readonly FieldResult[]): Tally {
  return { correct: results.filter((r) => r.correct).length, total: results.length };
}

export function rate({ correct, total }: Tally): number {
  return total === 0 ? 0 : correct / total;
}

export type BandRow = { band: ConfidenceBand; n: number; accuracy: number; meanConfidence: number };

export type Calibration = {
  bands: BandRow[];
  // expected calibration error over ten equal-width confidence bins: the
  // gap between accuracy and mean confidence in each bin, weighted by the
  // bin's share of fields
  ece: number;
  // mean squared difference between confidence and correctness (1 or 0)
  brier: number;
  n: number;
};

export function calibration(results: readonly FieldResult[]): Calibration {
  const scored = results.filter((r): r is FieldResult & { confidence: number; band: ConfidenceBand } => r.confidence !== null);
  const n = scored.length;
  const mean = (values: number[]) => (values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length);

  const bands = (["high", "medium", "low"] as const).map((band) => {
    const inBand = scored.filter((r) => r.band === band);
    return {
      band,
      n: inBand.length,
      accuracy: mean(inBand.map((r) => (r.correct ? 1 : 0))),
      meanConfidence: mean(inBand.map((r) => r.confidence)),
    };
  });

  let ece = 0;
  for (let bin = 0; bin < 10; bin += 1) {
    // [0.0, 0.1), ..., [0.9, 1.0]
    const inBin = scored.filter((r) => Math.min(Math.floor(r.confidence * 10), 9) === bin);
    if (inBin.length === 0) continue;
    const gap = Math.abs(mean(inBin.map((r) => (r.correct ? 1 : 0))) - mean(inBin.map((r) => r.confidence)));
    ece += (inBin.length / n) * gap;
  }
  const brier = mean(scored.map((r) => (r.confidence - (r.correct ? 1 : 0)) ** 2));
  return { bands, ece, brier, n };
}
