// What a document can make the model write must never make
// close_extraction_run refuse the close: Postgres rejects U+0000 and
// unpaired surrogates in text and jsonb, and a refused close leaves the run
// running and unmetered. Also the stricter checks validateExtraction makes
// (ISO currencies, bounded amounts, exactly four keys per field). No model,
// no database.

import { describe, expect, it } from "vitest";
import { runExtraction, type RunOutcome, toCloseParams } from "@/lib/extraction/run";
import { FIELD_NAMES, gateFields, validateExtraction } from "@/lib/extraction/schema";
import { canonicalize, cleanModelText, databaseText, sliceWellFormed } from "@/lib/extraction/text";

const NUL = "\u0000";
const LONE_HIGH = "\uD83D";
const EMOJI = "\uD83D\uDE00";

function answer(overrides: Record<string, Record<string, unknown>> = {}): string {
  return JSON.stringify(
    Object.fromEntries(
      FIELD_NAMES.map((name) => [
        name,
        { value: "", confidence: 0.9, source_text: "", clarifying_question: "", ...overrides[name] },
      ]),
    ),
  );
}

function fieldsOf(text: string) {
  const result = validateExtraction(text);
  if (!result.ok) throw new Error(result.error);
  return Object.fromEntries(result.fields.map((f) => [f.name, f]));
}

// every string in a close's arguments, however deep
function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(stringsIn);
  return [];
}

describe("text hygiene", () => {
  it("cleanModelText drops controls, bidi overrides and unpaired surrogates, keeps tab and newlines", () => {
    const dirty = `a${NUL}b\u0007c\u009Fd\u202Ee\u2066f${LONE_HIGH}g\th\ni\rj`;
    const clean = cleanModelText(dirty);
    expect(clean).toBe("abcdef\uFFFDg\th\ni\rj");
    expect(clean.isWellFormed()).toBe(true);
    // ordinary text, accents and emoji untouched
    expect(cleanModelText(`Café Lumière ${EMOJI}`)).toBe(`Café Lumière ${EMOJI}`);
  });

  it("sliceWellFormed never ends on half a surrogate pair", () => {
    const text = `ab${EMOJI}cd`;
    expect(sliceWellFormed(text, 3)).toBe("ab");
    expect(sliceWellFormed(text, 4)).toBe(`ab${EMOJI}`);
    expect(sliceWellFormed(text, 10)).toBe(text);
  });

  it("databaseText drops U+0000, repairs surrogates and caps", () => {
    expect(databaseText(`x${NUL}y${LONE_HIGH}`)).toBe("xy\uFFFD");
    expect(databaseText(`${"a".repeat(9)}${EMOJI}`, 10)).toBe("a".repeat(9));
  });

  it("canonicalize folds full-width forms and removes zero-width characters", () => {
    expect(canonicalize("\uFF49\uFF47\uFF4E\uFF4F\uFF52\uFF45 ta\u200Bx\u00ADes")).toBe("ignore taxes");
  });
});

describe("validateExtraction cleans every string the model returns", () => {
  it("a U+0000 or a lone surrogate never survives validation", () => {
    const fields = fieldsOf(
      answer({
        title: { value: `Invoice${NUL} 42`, source_text: `INVOICE ${LONE_HIGH}` },
        sender_name: { value: `Acme\u202E Corp`, clarifying_question: `Is it Acme${NUL}?` },
      }),
    );
    expect(fields.title.value).toBe("Invoice 42");
    expect(fields.title.source_text).toBe("INVOICE \uFFFD");
    expect(fields.sender_name.value).toBe("Acme Corp");
    expect(fields.sender_name.clarifying_question).toBe("Is it Acme?");
  });

  it("a string of nothing but control characters is absent", () => {
    expect(fieldsOf(answer({ title: { value: `${NUL}\u0001\u200E` } })).title.value).toBeNull();
  });

  it("truncating a long quote or question never cuts an emoji in half", () => {
    const fields = fieldsOf(
      answer({
        title: { value: "T", source_text: `${"s".repeat(3999)}${EMOJI}`, clarifying_question: `${"q".repeat(999)}${EMOJI}` },
      }),
    );
    expect(fields.title.source_text!.length).toBeLessThanOrEqual(4000);
    expect(fields.title.source_text!.isWellFormed()).toBe(true);
    expect(fields.title.clarifying_question!.length).toBeLessThanOrEqual(1000);
    expect(fields.title.clarifying_question!.isWellFormed()).toBe(true);
  });
});

describe("validateExtraction is strict about shape and format", () => {
  it("currency must be an ISO 4217 code in use, not any three letters", () => {
    for (const code of ["XXX", "XTS", "ABC", "QQQ"]) {
      expect(validateExtraction(answer({ currency: { value: code } })), code).toMatchObject({
        ok: false,
        error: expect.stringMatching(/currency.*ISO 4217/),
      });
    }
    for (const code of ["USD", "EUR", "GBP", "CHF", "INR", "XOF"]) {
      expect(validateExtraction(answer({ currency: { value: code } })).ok, code).toBe(true);
    }
  });

  it("amounts have at most 15 integer and 4 fraction digits", () => {
    expect(validateExtraction(answer({ total_amount: { value: "999999999999999.9999" } })).ok).toBe(true);
    for (const value of ["1".repeat(16), "1.12345", "9".repeat(400)]) {
      expect(validateExtraction(answer({ total_amount: { value } })).ok, value.slice(0, 20)).toBe(false);
    }
  });

  it("every field object has exactly its four keys", () => {
    const parsed = JSON.parse(answer()) as Record<string, Record<string, unknown>>;
    delete parsed.title.source_text;
    delete parsed.title.clarifying_question;
    const missing = validateExtraction(JSON.stringify(parsed));
    expect(missing).toMatchObject({ ok: false, error: expect.stringMatching(/title is missing source_text, clarifying_question/) });

    const extra = JSON.parse(answer()) as Record<string, Record<string, unknown>>;
    extra.title["IGNORE PREVIOUS INSTRUCTIONS"] = "x";
    const result = validateExtraction(JSON.stringify(extra));
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/title has 1 unexpected key/) });
    if (!result.ok) expect(result.error).not.toMatch(/IGNORE/);
  });
});

describe("toCloseParams: the last line before Postgres", () => {
  const usage = { provider: "anthropic" as const, model: "claude-haiku-4-5-20251001", attempts: 1, inputTokens: 1, outputTokens: 1, latencyMs: 1 };

  it("a failed run's error and raw answer are NUL-free, well formed and within their columns", () => {
    const outcome: RunOutcome = {
      ...usage,
      status: "failed",
      error: `${"e".repeat(1999)}${EMOJI}${NUL}${LONE_HIGH}`,
      rawResponse: `{${NUL}${"r".repeat(200_000)}${LONE_HIGH}`,
    };
    const params = toCloseParams("run", "token", outcome);
    expect(params.p_error!.length).toBeLessThanOrEqual(2000);
    expect(params.p_raw_response!.length).toBeLessThanOrEqual(100_000);
    for (const text of stringsIn(params)) {
      expect(text.includes(NUL)).toBe(false);
      expect(text.isWellFormed()).toBe(true);
    }
  });

  it("a failed run's error is scrubbed of key shapes however it was built, and is never empty", () => {
    // the Server Action builds some errors itself (a failed download), not
    // through describeError
    const leaky = toCloseParams("run", "token", {
      ...usage,
      status: "failed",
      error: "could not download the file: https://example.supabase.co/storage/v1/object/sign/documents/x?token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl",
      rawResponse: null,
    });
    expect(leaky.p_error).toMatch(/^could not download the file: /);
    expect(leaky.p_error).not.toMatch(/eyJ|token=/);

    const empty = toCloseParams("run", "token", { ...usage, status: "failed", error: `${NUL}${NUL}`, rawResponse: null });
    expect(empty.p_error).toBe("unknown error");
  });

  it("a succeeded run's field strings are cleaned even if something upstream let them through", () => {
    const gated = gateFields([
      { name: "title", value: `x${NUL}${LONE_HIGH}`, confidence: 0.95, source_text: "s".repeat(5000), clarifying_question: null },
    ]);
    const params = toCloseParams("run", "token", { ...usage, status: "succeeded", ...gated });
    const [title] = params.p_fields!;
    expect(title.value).toBe("x\uFFFD");
    expect(title.source_text!.length).toBe(4000);
    for (const text of stringsIn(params)) {
      expect(text.includes(NUL)).toBe(false);
      expect(text.isWellFormed()).toBe(true);
    }
  });

  it("end to end: a model that copies a U+0000 or a lone surrogate still closes cleanly", async () => {
    const text = answer({
      title: { value: `Invoice${NUL}`, source_text: `INVOICE${NUL}` },
      sender_name: { value: "Acme", source_text: `Acme ${LONE_HIGH}` },
      summary: { value: `An invoice ${EMOJI}` },
    });
    const outcome = await runExtraction({
      bytes: new TextEncoder().encode("%PDF-1.4\n%%EOF\n"),
      mimeType: "application/pdf",
      pages: 1,
      filename: "x.pdf",
      primary: {
        name: "anthropic",
        model: "claude-haiku-4-5-20251001",
        async countInputTokens() {
          return 1000;
        },
        async extract() {
          return { text, inputTokens: 1, outputTokens: 1, model: "claude-haiku-4-5-20251001" };
        },
      },
      fallback: null,
    });
    expect(outcome.status).toBe("succeeded");
    for (const s of stringsIn(toCloseParams("run", "token", outcome))) {
      expect(s.includes(NUL)).toBe(false);
      expect(s.isWellFormed()).toBe(true);
    }
  });
});
