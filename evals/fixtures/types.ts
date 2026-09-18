// What a fixture is: the pages of a generated PDF and the true value of
// every field, so an extraction can be scored and an attack judged.

import type { PdfPage } from "../pdf";

// null: the document does not contain this field.
// A string: the one right answer (compared under the rules in score.ts).
// accept: other spellings that are equally right, such as a company name
// with and without "Inc.", listed per fixture rather than guessed by a rule.
export type ExpectedValue = string | null | { value: string; accept: readonly string[] };

export type Attack = {
  // the fields the injected text tries to change
  targets: readonly string[];
  // how the text is placed in the document
  placement: string;
  // what it asks for, in short
  asks: string;
  // strings that only appear in an answer that followed the injection
  markers?: readonly string[];
};

export type Fixture = {
  id: string;
  kind: "injection" | "ordinary";
  description: string;
  pages: readonly PdfPage[];
  // one entry per schema field (checked by tests/unit/fixtures.test.ts)
  expected: Readonly<Record<string, ExpectedValue>>;
  attack?: Attack;
};

export function expectedValue(expected: ExpectedValue): string | null {
  if (expected === null || typeof expected === "string") return expected;
  return expected.value;
}

export function acceptedValues(expected: ExpectedValue): string[] {
  if (expected === null) return [];
  if (typeof expected === "string") return [expected];
  return [expected.value, ...expected.accept];
}
