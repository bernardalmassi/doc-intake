// Every fixture, in the order evals run them.

import { INJECTION_FIXTURES } from "./injection";
import { ORDINARY_FIXTURES } from "./ordinary";
import type { Fixture } from "./types";

export type { Attack, ExpectedValue, Fixture } from "./types";
export { acceptedValues, expectedValue } from "./types";

export const FIXTURES: readonly Fixture[] = [...ORDINARY_FIXTURES, ...INJECTION_FIXTURES];

export function fixtureById(id: string): Fixture {
  const fixture = FIXTURES.find((f) => f.id === id);
  if (!fixture) throw new Error(`no fixture named ${id}`);
  return fixture;
}
