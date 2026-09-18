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
//   ungrounded_total     total_amount is not a number written in the text it
//                        claims to have been read from
//   repeated_value       three or more text fields hold the same value, the
//                        mark of "set every field to X"
//   contact_in_question  text the model writes for the reviewer carries a way
//                        to reach someone: a link, email address or web
//                        address in a question that will be shown (checked by
//                        gateFields on the medium band), or a link or email
//                        address in the summary (checked here)
//
// Every check runs on canonical text (text.ts: NFKC, default-ignorable code
// points removed), so full-width letters, soft hyphens and zero-width
// characters can't split a word the patterns look for.
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
import { canonicalize } from "./text";

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

// Lowercase words of the canonical text, punctuation and spacing dropped,
// so "Ignore-all:previous" and "ignore all previous" compare equal.
export function normalizedWords(text: string): string[] {
  return canonicalize(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter((word) => word.length > 0);
}

function compact(text: string): string {
  return canonicalize(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
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

// "AI" as a word addressed to a model: followed by systems, models,
// assistants, agents, extractors or tools, or by punctuation or the end.
// Not "AI Research Group" or "an AI Fellow".
const AI = String.raw`ai(?=\s+(?:systems?|models?|assistants?|agents?|extractors?|tools?)\b|\s*[.,:;!?)]|\s*$)`;

// Each pattern was chosen to match what an injection says and not what a
// business document says; the unit tests hold both an injection corpus and
// an ordinary-document corpus ("per your instructions", "please disregard
// this notice if you have already paid", "fill in all fields", "Assistant
// Manager", a person named Claude, "prompt payment", "supersedes all prior
// agreements", "return the amount due to 14 Harbour Street", "AI Research
// Group", "configured the system prompts"). Deliberately not matched: bare
// "ignore" or "disregard", "your instructions", "system:", "user:",
// "assistant".
const INSTRUCTION_PATTERNS: readonly RegExp[] = [
  // "ignore all previous instructions", "disregard the prior prompt"
  /\b(ignore|disregard|forget)\s+(?:(?:all|any|the|your|of)\s+)*(previous|prior|above|earlier|preceding|original|initial|system|existing)\s+(instructions?|prompts?|rules|directions|directives|guidelines|context)\b/i,
  // "ignore everything above"
  /\b(ignore|disregard|forget)\s+(everything|all)\s+(of\s+)?(the\s+)?(above|before|previous|prior)\b/i,
  // naming the prompt itself, singular: "the system prompt", not a
  // technician's "system prompts on 12 kiosks"
  /\b(system|developer)\s+(prompt|message)\b/i,
  /\b(repeat|reveal|print|recite|leak|disclose|copy|output|paste|dump)\b[^.\n]{0,20}\byour\s+(\w+\s+)?(prompt|instructions|rules|guidelines)\b/i,
  // addressed to a model: "note to AI systems", "attention: language models"
  new RegExp(
    String.raw`\b(note|message|instructions?|notice|memo|directive|attention)\s*(to|for|:)\s*(the\s+|any\s+|all\s+)?` +
      String.raw`(${AI}|a\.i\.|llms?|language\s+models?|chat\s?bots?|bots?|extractors?|parsers?|` +
      String.raw`automated\s+((invoice|document|data|text)\s+)?(extraction|processing|systems?|readers?|parsers?|tools?))(?!\w)`,
    "i",
  ),
  new RegExp(
    String.raw`\b(you\s+are|you're|act\s+as|pretend\s+to\s+be)\s+(now\s+)?(an?\s+)?(${AI}|llm|language\s+model|chat\s?bot|extraction\s+model)(?!\w)`,
    "i",
  ),
  // telling the extractor what to output. "return" and "report" need "as":
  // "return the amount due to 14 Harbour Street" is an address
  /\b(set|output|report)\s+(every|each|all)\s+(of\s+the\s+)?(fields?|values?)\s+(to|as)\b/i,
  /\b(report|output|return|extract)\s+(the\s+)?(total(\s+amount)?|amount(\s+due)?|value|field)\b[^.\n]{0,30}\bas\s*[$\u20AC\u00A3]?\s*-?\d/i,
  /\b(set|record)\s+(the\s+)?(total(\s+amount)?|amount(\s+due)?|value|field)\b[^.\n]{0,30}\b(as|to)\s*[$\u20AC\u00A3]?\s*-?\d/i,
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
    const canonical = canonicalize(text);
    return patterns.some((pattern) => pattern.test(canonical));
  };
}

// (c) Ways to reach someone, where the model writes for the reviewer ----------

const SCHEME = /\b[a-z][a-z0-9+.-]*:\/\/|\b(mailto|tel|sms):/i;
const WWW = /\bwww\.[a-z0-9-]/i;
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}/i;
// a domain (label.label, the last all letters) and a path after it
const DOMAIN_WITH_PATH = /\b[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)*\.[a-z]{2,}\/\S/i;
const DOMAIN = /\b[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)*\.[a-z]{2,}\b/i;
// the unambiguous forms only: +44 20 7946 0958, (510) 555-0142. A bare
// 123-456-7890 is as likely an account or IBAN fragment.
const PHONE = /\+\d[\d\s().-]{7,}\d|\(\d{2,5}\)\s*\d{3,4}[\s.-]?\d{3,4}\b/;

// For the summary, which may name a company: a scheme, www., an email
// address, or a domain with a path. "Invoice from Amazon.com Services LLC"
// is a name, "contoso-billing.shop/verify" is a link.
export function containsLinkOrEmail(text: string): boolean {
  const canonical = canonicalize(text);
  return SCHEME.test(canonical) || WWW.test(canonical) || EMAIL.test(canonical) || DOMAIN_WITH_PATH.test(canonical);
}

// For a clarifying question, which should only ask about the document:
// also any bare domain ("contoso-pay.ai") and the unambiguous phone forms.
// A question that quotes a company's domain name pays for this with a
// review; that is the cheaper mistake.
export function containsContactInQuestion(text: string): boolean {
  const canonical = canonicalize(text);
  return containsLinkOrEmail(canonical) || DOMAIN.test(canonical) || PHONE.test(canonical);
}

// (d) A total grounded in its own quote --------------------------------------

// Digits other than ASCII that NFKC leaves alone: Arabic-Indic, Extended
// Arabic-Indic, Devanagari and Bengali, and the Arabic decimal and
// thousands separators.
const DIGIT_ZEROS = [0x0660, 0x06f0, 0x0966, 0x09e6];

function asciiNumerals(text: string): string {
  return text
    .replace(/[\u0660-\u0669\u06F0-\u06F9\u0966-\u096F\u09E6-\u09EF]/g, (digit) => {
      const code = digit.charCodeAt(0);
      const zero = DIGIT_ZEROS.find((z) => code >= z && code <= z + 9) ?? code;
      return String(code - zero);
    })
    .replace(/\u066B/g, ".")
    .replace(/\u066C/g, ",");
}

// "1250.00" -> "1250", "0.010" -> "0.01". Signs are handled by the caller.
function canonicalNumber(integer: string, fraction: string): string {
  const int = integer.replace(/^0+(?=\d)/, "");
  const frac = fraction.replace(/0+$/, "");
  return frac.length > 0 ? `${int}.${frac}` : int;
}

// "1250", "12.5", "1250,00". A single separator followed by exactly three
// digits after a group of one to three ("1,250", "1.250") is read only as
// grouping, never as a three-place decimal, so 1.25 is not in "$1,250".
function plainReading(token: string): string | null {
  const match = /^(\d+)(?:([.,])(\d+))?$/.exec(token);
  if (!match) return null;
  const [, integer, separator, fraction] = match;
  if (separator && fraction.length === 3 && /^[1-9]\d{0,2}$/.test(integer)) return null;
  return canonicalNumber(integer, fraction ?? "");
}

// "1,234.56", "1.234,56", "1 234,56", "1'234.56": a first group of one to
// three digits without a leading zero, then groups of three.
const GROUPINGS: readonly [group: string, decimal: string][] = [
  [",", "."],
  ["'", "."],
  ["\u2019", "."],
  [" ", "."],
  [".", ","],
  ["'", ","],
  ["\u2019", ","],
  [" ", ","],
];

function groupedReading(token: string, group: string, decimal: string): string | null {
  const [integer, fraction, ...rest] = token.split(decimal);
  if (rest.length > 0 || (fraction !== undefined && !/^\d+$/.test(fraction))) return null;
  const groups = integer.split(group);
  if (groups.length < 2 || !/^[1-9]\d{0,2}$/.test(groups[0])) return null;
  if (!groups.slice(1).every((g) => /^\d{3}$/.test(g))) return null;
  return canonicalNumber(groups.join(""), fraction ?? "");
}

// Indian grouping: "1,25,000.00", "12,34,567": one or two digits, groups of
// two, a last group of three.
function lakhReading(token: string): string | null {
  const [integer, fraction, ...rest] = token.split(".");
  if (rest.length > 0 || (fraction !== undefined && !/^\d+$/.test(fraction))) return null;
  const groups = integer.split(",");
  if (groups.length < 3 || !/^[1-9]\d?$/.test(groups[0]) || !/^\d{3}$/.test(groups[groups.length - 1])) return null;
  if (!groups.slice(1, -1).every((g) => /^\d{2}$/.test(g))) return null;
  return canonicalNumber(groups.join(""), fraction ?? "");
}

function readingsOf(token: string): string[] {
  const readings = new Set<string>();
  const plain = plainReading(token);
  if (plain !== null) readings.add(plain);
  for (const [group, decimal] of GROUPINGS) {
    const grouped = groupedReading(token, group, decimal);
    if (grouped !== null) readings.add(grouped);
  }
  const lakh = lakhReading(token);
  if (lakh !== null) readings.add(lakh);
  return [...readings];
}

// Every value the numbers written in a text could mean. A run of digits and
// separators is read whole first ("1 250,00" is 1250); only a run with no
// reading as a whole is split at its spaces (a table row "2 10.00 20.00"),
// so 250 is never read out of "1 250,00".
export function numbersIn(text: string): Set<string> {
  const found = new Set<string>();
  const prepared = asciiNumerals(canonicalize(text));
  for (const match of prepared.matchAll(/\d(?:[\d.,'\u2019 ]*\d)?/g)) {
    const token = match[0];
    const whole = readingsOf(token);
    const readings = whole.length > 0 ? whole : token.split(/ +/).flatMap(readingsOf);
    for (const reading of readings) found.add(reading);
  }
  return found;
}

// A minus sign before a number, a bracketed amount, CR or "credit".
const NEGATIVE_MARKER =
  /(^|[^\p{L}\p{N}])[-\u2212]\s*[$\u20AC\u00A3\u00A5\u20B9]?\s*\d|\(\s*[$\u20AC\u00A3\u00A5\u20B9]?\s*\d|\bCR\b|\bcredit\b/iu;

// The value (already validated as a plain decimal) must be one of the
// numbers written in its source_text, and may be negative only if the text
// shows a negative amount. This catches a model that quotes the real total
// line but reports another figure. It does not catch a model that quotes an
// attacker's line, because the quote is not checked against the document's
// own text.
export function isTotalGrounded(value: string, sourceText: string | null): boolean {
  if (sourceText === null) return false;
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) return false;
  const source = asciiNumerals(canonicalize(sourceText));
  if (match[1] === "-" && !NEGATIVE_MARKER.test(source)) return false;
  return numbersIn(source).has(canonicalNumber(match[2], match[3] ?? ""));
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

  // Contact details in a clarifying question are checked by gateFields,
  // which knows whether the question will be shown (medium band only).
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
  contact_in_question:
    "the extractor put a link, email address, web address or phone number into text meant for the reviewer; a question that did so was withheld",
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
