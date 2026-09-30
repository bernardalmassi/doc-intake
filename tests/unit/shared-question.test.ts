// A question several fields to check share word for word is printed once,
// after them, and each of them says where it is (DESIGN.md, "Fields to
// check"). Before, the panel printed it once only when every Low field
// shared it: the dates' question beside another Low field was printed
// under both dates. No database, no network.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ExtractionPanel, sharedQuestions } from "@/app/app/[slug]/extraction-panel";
import type { FieldRow } from "@/app/app/[slug]/types";

// gateFields' question for two dates that disagree with the terms, as on
// the landing's Fig. 1
const DATES =
  "The payment terms are 30 days, but the due date is 91 days after the document date. Check both dates against the document: a date written in numbers may have been read with the day and month swapped.";
const TOTAL = "Two totals are printed. Is 2,046.26 the amount due?";

function low(name: string, question: string | null): FieldRow {
  return { document_id: "d", name, value: "x", confidence: "0.590", band: "low", source_text: "x", clarifying_question: question };
}

function render(fields: FieldRow[]) {
  const html = renderToStaticMarkup(createElement(ExtractionPanel, { fields }));
  const text = html.replace(/<[^>]+>/g, " ").replace(/ /g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
  return { html, text };
}

const count = (text: string, part: string) => text.split(part).length - 1;

describe("a question the fields to check share", () => {
  it("is printed once beside another Low field with a question of its own", () => {
    const { html, text } = render([low("document_date", DATES), low("due_date", DATES), low("total_amount", TOTAL)]);
    expect(count(text, DATES)).toBe(1);
    expect(count(text, TOTAL)).toBe(1);
    // each date says where it is; the shared block follows 3 of 3
    expect(count(text, "One question for 1 and 2, after 3 of 3.")).toBe(2);
    expect(text).toContain("To confirm 1 and 2");
    // the field with its own question keeps it under its value
    expect(text).toMatch(/3 of 3 x Read from .* To confirm Two totals are printed/);
    // both dates are described by the block, the total by nothing
    expect(count(html, 'aria-describedby="shared-question-d-1"')).toBe(2);
    expect(html).toContain('id="shared-question-d-1"');
  });

  it("is printed once when it is shared by the last fields, directly below the last", () => {
    const { text } = render([low("sender_name", TOTAL.replace("totals", "senders")), low("document_date", DATES), low("due_date", DATES)]);
    expect(count(text, DATES)).toBe(1);
    expect(text).toContain("One question for 2 and 3, after 3 of 3.");
    expect(text).toContain("One question for 2 and 3, directly below.");
    expect(text).toContain("To confirm 2 and 3");
  });

  it("is printed once for Fig. 1's two dates, as before", () => {
    const { text } = render([low("document_date", DATES), low("due_date", DATES)]);
    expect(count(text, DATES)).toBe(1);
    expect(text).toContain("One question for 1 and 2, after 2 of 2.");
    expect(text).toContain("One question for 1 and 2, directly below.");
  });

  it("groups by identical wording only, and leaves a question asked once where it is", () => {
    expect(sharedQuestions([low("a", "Q"), low("b", "Q "), low("c", null), low("d", "Q")])).toEqual([
      { question: "Q", numbers: [1, 4] },
    ]);
    const { text } = render([low("title", "Q1"), low("due_date", "Q2")]);
    expect(count(text, "Q1")).toBe(1);
    expect(count(text, "Q2")).toBe(1);
    expect(text).not.toContain("One question for");
  });
});
