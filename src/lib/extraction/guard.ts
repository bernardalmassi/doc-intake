// A deterministic check on what the model returned, run inside gating
// (schema.ts, gateFields) on every validated answer. An uploaded document is
// untrusted text the model reads, and the only thing an instruction hidden in
// it can change is the output: the ten values, their confidence, source_text
// and clarifying_question. This module looks for the marks such an
// instruction leaves when the model obeys it:
//
//   prompt_echo          a field repeats the extraction instructions
//                        (a run of ECHO_RUN_WORDS consecutive words from
//                        them, or the canary marker in the system prompt)
//   instruction_text     a field contains text aimed at the extractor rather
//                        than business content ("ignore all previous
//                        instructions", chat-template role markup, the output
//                        schema's own field names)
//   ungrounded_total     total_amount is not a number that appears in the
//                        text it claims to have been read from
//   repeated_value       three or more text fields hold the same value, the
//                        mark of "set every field to X"
//   contact_in_question  a clarifying question or the summary, both written
//                        by the model and shown to a reviewer, carries a link
//                        or an email address (or, in a question, a phone
//                        number): a phishing channel
//
// A flagged field is forced to the low band with a question saying why, so
// the document goes to needs_review instead of being silently extracted.
// This is a heuristic, not a boundary: a model can be steered into a value
// that is wrong, grounded in its own quote and phrased like business text,
// and nothing here would notice. SECURITY.md, "Untrusted document content",
// lists what it does not catch.
//
// No runtime import from schema.ts (only types), so there is no import
// cycle: schema.ts builds the guard with its own prompt text and field names.

import { CONFIDENCE_THRESHOLDS, confidenceBand } from "./config";
import type { ExtractedField, GatedField } from "./schema";

export type GuardReason =
  | "prompt_echo"
  | "instruction_text"
  | "ungrounded_total"
  | "repeated_value"
  | "contact_in_question";

export type FieldPart = "value" | "source_text" | "clarifying_question";

export type GuardFlag = { reason: GuardReason; part: FieldPart };

// A flagged field's confidence is capped here, one step under the medium
// threshold, so confidenceBand() puts it in the low band.
export const FLAGGED_CONFIDENCE_CAP = Math.round((CONFIDENCE_THRESHOLDS.medium - 0.01) * 1000) / 1000;

// How many consecutive words of the instructions count as an echo. Eight is
// long enough that business text never matches by chance (the tests run a
// corpus of ordinary document text through it) and short enough to catch a
// partial copy.
export const ECHO_RUN_WORDS = 8;

const TOTAL_FIELD = "total_amount";
const SUMMARY_FIELD = "summary";

// Sender and recipient can legitimately be the same (an internal memo), so
// two equal fields are allowed; three are not.
const REPEATED_VALUE_FIELDS = 3;

// Text normalization ------------------------------------------------------

// Lowercase words, punctuation and spacing dropped, so "Ignore-all:previous"
// and "ignore all previous" compare equal.
export function normalizedWords(text: string): string[] {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter((word) => word.length > 0);
}

function compact(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function runsOf(words: string[], length: number): string[] {
  const runs: string[] = [];
  for (let i = 0; i + length <= words.length; i += 1) runs.push(words.slice(i, i + length).join(" "));
  return runs;
}

// (a) Echo of the instructions ---------------------------------------------

export function createEchoDetector(instructionTexts: readonly string[], canary: string, runLength = ECHO_RUN_WORDS) {
  const runs = new Set<string>();
  for (const text of instructionTexts) {
    for (const run of runsOf(normalizedWords(text), runLength)) runs.add(run);
  }
  const compactCanary = compact(canary);
  if (compactCanary.length < 8) throw new Error("the canary must have at least 8 letters or digits");
  return function isEcho(text: string): boolean {
    if (compact(text).includes(compactCanary)) return true;
    return runsOf(normalizedWords(text), runLength).some((run) => runs.has(run));
  };
}

// (b) Text aimed at the extractor -------------------------------------------

// Each pattern was chosen to match what an injection says and not what a
// business document says; the unit tests hold both an injection corpus and
// an ordinary-document corpus ("per your instructions", "please disregard
// this notice if you have already paid", "fill in all fields", "Assistant
// Manager", a person named Claude, "prompt payment", "supersedes all prior
// agreements"). Deliberately not matched: bare "ignore" or "disregard",
// "your instructions", "system:", "user:", "assistant".
const INSTRUCTION_PATTERNS: readonly RegExp[] = [
  // "ignore all previous instructions", "disregard the prior prompt"
  /\b(ignore|disregard|forget)\s+(?:(?:all|any|the|your|of)\s+)*(previous|prior|above|earlier|preceding|original|initial|system|existing)\s+(instructions?|prompts?|rules|directions|directives|guidelines|context)\b/i,
  // "ignore everything above"
  /\b(ignore|disregard|forget)\s+(everything|all)\s+(of\s+)?(the\s+)?(above|before|previous|prior)\b/i,
  // naming the prompt itself
  /\b(system|developer)\s+(prompt|message)s?\b/i,
  /\b(repeat|reveal|print|recite|leak|disclose|copy|output|paste|dump)\b[^.\n]{0,20}\byour\s+(\w+\s+)?(prompt|instructions|rules|guidelines)\b/i,
  // addressed to a model: "note to AI systems", "attention: language models"
  /\b(note|message|instructions?|notice|memo|directive|attention)\s*(to|for|:)\s*(the\s+|any\s+|all\s+)?(ai|a\.i\.|llms?|language\s+models?|chat\s?bots?|bots?|extractors?|parsers?|automated\s+((invoice|document|data|text)\s+)?(extraction|processing|systems?|readers?|parsers?|tools?))\b/i,
  /\b(you\s+are|you're|act\s+as|pretend\s+to\s+be)\s+(now\s+)?(an?\s+)?(ai|llm|language\s+model|chat\s?bot|extraction\s+model)\b/i,
  // telling the extractor what to output
  /\b(set|output|report)\s+(every|each|all)\s+(of\s+the\s+)?(fields?|values?)\s+(to|as)\b/i,
  /\b(report|record|set|output|return|extract)\s+(the\s+)?(total(\s+amount)?|amount(\s+due)?|value|field)\b[^.\n]{0,30}\b(as|to)\s*[$\u20ac\u00a3]?\s*-?\d/i,
  /\bconfidence\s*(score|level|value)?\s*(of|to|=|:)\s*(1(\.0+)?\b|0?\.\d+|100\s*%)/i,
  // chat-template and prompt markup
  /<\|[a-z_]{2,}\|>|\[\/?INST\]|<<\/?SYS>>|<\/?(system|assistant|user|developer|instructions?|document|document_content|tool_result)>/i,
  /(^|\n)\s*#{2,}\s*(system|instructions?|assistant|user)\b/i,
];

export function createInstructionDetector(fieldNames: readonly string[]) {
  // The schema's own vocabulary: snake_case field names ("total_amount")
  // and quoted keys ('"confidence":') don't occur in business documents.
  const snakeCase = fieldNames.filter((name) => name.includes("_"));
  const keys = [...snakeCase, "source_text", "clarifying_question"];
  const schemaPatterns = [
    new RegExp(`\\b(${[...new Set(keys)].join("|")})\\b`, "i"),
    /"\s*(value|confidence|source_text|clarifying_question)\s*"\s*:/i,
  ];
  const patterns = [...INSTRUCTION_PATTERNS, ...schemaPatterns];
  return function isInstructionText(text: string): boolean {
    return patterns.some((pattern) => pattern.test(text));
  };
}

// (c) Contact details where the model writes prose --------------------------

const URL_PATTERN =
  /\bhttps?:\/\/|\bwww\.[a-z0-9-]|\b[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)*\.(com|net|org|io|co|me|us|ly|gl|to|info|biz|xyz|ru|cn|top|online|site|link|app|dev|uk|de|fr|eu)\b/i;
const EMAIL_PATTERN = /[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}/i;
// +1 555 010 7788, (555) 010-7788, 555-010-7788, 020 7946 0958
const PHONE_PATTERN = /\+\d[\d\s().-]{7,}\d|\(\d{2,4}\)\s*\d{3,4}[\s.-]?\d{3,4}\b|\b\d{3}[\s.-]\d{3}[\s.-]\d{4}\b|\b0\d{2,4}\s\d{3,4}\s\d{3,4}\b/;

export function containsLinkOrEmail(text: string): boolean {
  return URL_PATTERN.test(text) || EMAIL_PATTERN.test(text);
}

export function containsContactDetails(text: string): boolean {
  return containsLinkOrEmail(text) || PHONE_PATTERN.test(text);
}

// (d) A total grounded in its own quote --------------------------------------

// "1250.00" -> "1250", "0.010" -> "0.01", "-3" -> "3". The sign is dropped
// because credit notes write it as "(150.00)" or "150.00 CR".
function canonicalNumber(integer: string, fraction: string): string {
  const int = integer.replace(/^0+(?=\d)/, "");
  const frac = fraction.replace(/0+$/, "");
  return frac.length > 0 ? `${int}.${frac}` : int;
}

// Every value a number token could mean, under dot-decimal ("1,234.56",
// "1'234.56") and comma-decimal ("1.234,56", "1 234,56") conventions.
function readingsOf(token: string): string[] {
  const readings: string[] = [];
  const dotDecimal = /^(\d{1,3}(?:[,'\u2019]\d{3})+|\d+)(?:\.(\d+))?$/.exec(token);
  if (dotDecimal) readings.push(canonicalNumber(dotDecimal[1].replace(/[,'\u2019]/g, ""), dotDecimal[2] ?? ""));
  const commaDecimal = /^(\d{1,3}(?:[.'\u2019]\d{3})+|\d+)(?:,(\d+))?$/.exec(token);
  if (commaDecimal) readings.push(canonicalNumber(commaDecimal[1].replace(/[.'\u2019]/g, ""), commaDecimal[2] ?? ""));
  return readings;
}

export function numbersIn(text: string): Set<string> {
  const found = new Set<string>();
  // runs of digits with the separators numbers use, spaces included so
  // "1 234,56" is one token; each space-separated piece is tried too
  for (const match of text.matchAll(/\d(?:[\d.,'\u2019\u00a0\u202f ]*\d)?/g)) {
    const raw = match[0];
    const pieces = [raw.replace(/[\u00a0\u202f ]/g, ""), ...raw.split(/[\u00a0\u202f ]+/)];
    for (const piece of pieces) for (const reading of readingsOf(piece)) found.add(reading);
  }
  return found;
}

// The value (already validated as a plain decimal) must be one of the
// numbers written in its source_text. This catches a model that quotes the
// real total line but reports another figure. It does not catch a model
// that quotes an attacker's line, because the quote is not checked against
// the document's own text.
export function isTotalGrounded(value: string, sourceText: string | null): boolean {
  if (sourceText === null) return false;
  const match = /^-?(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) return false;
  return numbersIn(sourceText).has(canonicalNumber(match[1], match[2] ?? ""));
}

// Putting it together -------------------------------------------------------

export type OutputGuard = {
  inspect(fields: readonly ExtractedField[]): Map<string, GuardFlag[]>;
  isEcho(text: string): boolean;
  isInstructionText(text: string): boolean;
};

export function createOutputGuard(reference: {
  instructionTexts: readonly string[];
  canary: string;
  fieldNames: readonly string[];
  // free-text fields, compared with each other for repeated_value
  textFieldNames: readonly string[];
}): OutputGuard {
  const isEcho = createEchoDetector(reference.instructionTexts, reference.canary);
  const isInstructionText = createInstructionDetector(reference.fieldNames);

  function repeatedValues(fields: readonly ExtractedField[]): Set<string> {
    const byValue = new Map<string, string[]>();
    for (const field of fields) {
      if (field.value === null || !reference.textFieldNames.includes(field.name)) continue;
      const key = normalizedWords(field.value).join(" ");
      if (key.length === 0) continue;
      byValue.set(key, [...(byValue.get(key) ?? []), field.name]);
    }
    return new Set([...byValue.values()].filter((names) => names.length >= REPEATED_VALUE_FIELDS).flat());
  }

  function inspectField(field: ExtractedField): GuardFlag[] {
    const flags: GuardFlag[] = [];
    const parts: [FieldPart, string | null][] = [
      ["value", field.value],
      ["source_text", field.source_text],
      ["clarifying_question", field.clarifying_question],
    ];
    for (const [part, text] of parts) {
      if (text === null) continue;
      if (isEcho(text)) flags.push({ reason: "prompt_echo", part });
      else if (isInstructionText(text)) flags.push({ reason: "instruction_text", part });
    }
    if (field.clarifying_question !== null && containsContactDetails(field.clarifying_question)) {
      flags.push({ reason: "contact_in_question", part: "clarifying_question" });
    }
    if (field.name === SUMMARY_FIELD && field.value !== null && containsLinkOrEmail(field.value)) {
      flags.push({ reason: "contact_in_question", part: "value" });
    }
    if (field.name === TOTAL_FIELD && field.value !== null && !isTotalGrounded(field.value, field.source_text)) {
      flags.push({ reason: "ungrounded_total", part: "value" });
    }
    return flags;
  }

  return {
    inspect(fields) {
      const findings = new Map<string, GuardFlag[]>();
      const repeated = repeatedValues(fields);
      for (const field of fields) {
        const flags = inspectField(field);
        if (repeated.has(field.name)) flags.push({ reason: "repeated_value", part: "value" });
        if (flags.length > 0) findings.set(field.name, flags);
      }
      return findings;
    },
    isEcho,
    isInstructionText,
  };
}

// What the reviewer is told. Fixed text only: nothing the model wrote is
// repeated here, so a flagged question can't carry an attacker's words.
const REASON_TEXT: Record<GuardReason, string> = {
  prompt_echo: "the extractor's answer repeated its own instructions instead of the document's text, so that text was removed",
  instruction_text: "the answer contains text aimed at the extractor rather than ordinary document content",
  ungrounded_total: "the total is not a number that appears in the text it was read from",
  repeated_value: "the same value was given for several unrelated fields, as when a document tells the extractor to set every field to one value",
  contact_in_question: "the extractor wrote a link, email address or phone number where only a question about the document belongs, so it was withheld",
};

export function flaggedQuestion(label: string, flags: readonly GuardFlag[]): string {
  const reasons = [...new Set(flags.map((flag) => flag.reason))].map((reason) => REASON_TEXT[reason]);
  return (
    `"${label}" was flagged by the output guard: ${reasons.join("; ")}. ` +
    "Check this field against the document itself; text inside the document may have tried to steer the extraction."
  );
}

// A flagged field: low band, capped confidence, the guard's question in
// place of the model's, and any echoed instruction text removed (it is
// ours, not the document's, so the reviewer loses nothing).
export function flagField(field: ExtractedField, flags: GuardFlag[], label: string): GatedField {
  const echoed = new Set(flags.filter((flag) => flag.reason === "prompt_echo").map((flag) => flag.part));
  const confidence = Math.min(field.confidence, FLAGGED_CONFIDENCE_CAP);
  return {
    ...field,
    value: echoed.has("value") ? null : field.value,
    source_text: echoed.has("source_text") ? null : field.source_text,
    confidence,
    band: confidenceBand(confidence),
    clarifying_question: flaggedQuestion(label, flags),
    flags,
  };
}
