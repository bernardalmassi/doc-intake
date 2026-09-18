// The one logger. Code in src/lib writes logs through this module and
// nothing else (eslint.config.mjs makes console.* and process.stdout/stderr
// an error there), so this is the single place that decides what can reach
// a log line.
//
// The guarantee is structural, not a regex hoping to catch everything:
//
//   - A line is one JSON object: { ts, level, event, fields, dropped? }.
//   - event is one of LOG_EVENTS, a closed list, checked by the type system
//     and again at runtime. Anything else writes a fixed log.invalid_event
//     line instead.
//   - fields is a closed set of keys (LOG_FIELDS), each with a narrow format:
//     a lowercase UUID, a member of a fixed enum, a lowercase model id, a
//     SQLSTATE, a snake_case code, an error class name, a bounded integer
//     or a boolean. An unknown key is a compile-time error in an object
//     literal and is dropped at runtime (a caller can cast); so is a value
//     that doesn't fit its key's format, and anything nested. `dropped`
//     counts them, so a mistake shows in the log without echoing what was
//     dropped (not even the key, whose name the caller controls).
//   - So no field can hold free text: no message, filename, URL, model
//     output, extracted value (value, source_text, raw_response, fields),
//     document content, or SDK or database error message (V8's JSON.parse
//     errors quote their input, and provider errors can echo the request).
//     Errors are logged as error_kind, error_name, http_status and db_code.
//   - Belt and braces: a string that fits its format is still dropped if
//     redact.ts finds anything secret in it (a registered key, a key shape),
//     and the finished line is scanned once more. If that scan finds
//     anything, a fixed log.redaction_failed line is written instead.
//   - Logging never throws. Hostile input (throwing getters, proxies,
//     circular objects, BigInt, symbols, huge strings) is dropped, and a
//     sink that throws is ignored.
//
// No "server-only" import and no secrets of its own, so tests import it
// directly; the sink is injectable so they can capture what it writes.

import type { ProviderName } from "./extraction/config";
import type { ProviderErrorKind } from "./extraction/providers/types";
import { SUPPORTED_MIME_TYPES } from "./extraction/sniff";
import { containsSecret } from "./redact";

// Events --------------------------------------------------------------------

// Every event name, lowercase dotted words. Add a name here to log a new
// event.
export const LOG_EVENTS = [
  // extraction/providers/select.ts
  "extraction.providers_selected",
  "extraction.not_configured",
  // extraction/run.ts
  "extraction.call_succeeded",
  "extraction.call_failed",
  "extraction.fallback",
  "extraction.validation_retry",
  "extraction.run_finished",
  // for src/app/app/extract-action.ts, which can't be edited while the UI
  // is redesigned: one line per step around the RPCs
  "extraction.run_opened",
  "extraction.open_refused",
  "extraction.download_failed",
  "extraction.type_mismatch",
  "extraction.run_closed",
  "extraction.close_failed",
] as const;

export type LogEvent = (typeof LOG_EVENTS)[number];

// The logger's own, written in place of a line it refuses.
type OwnEvent = "log.invalid_event" | "log.redaction_failed" | "log.failed";

const KNOWN_EVENTS = new Set<string>(LOG_EVENTS);
const MAX_EVENT_LENGTH = 64;

// Fields --------------------------------------------------------------------

// A format returns the value if it is acceptable, otherwise undefined.
type Format<T> = (value: unknown) => T | undefined;
type FormatValue<F> = F extends Format<infer T> ? T : never;

function oneOf<T extends string>(values: readonly T[]): Format<T> {
  const allowed = new Set<string>(values);
  return (value) => (typeof value === "string" && allowed.has(value) ? (value as T) : undefined);
}

// A record rather than an array so that adding a member to the source union
// is a compile error here until it is listed.
function keysOf<T extends string>(record: Record<T, true>): T[] {
  return Object.keys(record) as T[];
}

function matching(pattern: RegExp, maxLength: number): Format<string> {
  // length first, so a huge string never reaches the regex
  return (value) =>
    typeof value === "string" && value.length <= maxLength && pattern.test(value) ? value : undefined;
}

function count(max: number = Number.MAX_SAFE_INTEGER): Format<number> {
  return (value) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : undefined;
}

const flag: Format<boolean> = (value) => (typeof value === "boolean" ? value : undefined);

// Postgres and crypto.randomUUID both print UUIDs in lowercase.
const uuid = matching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 36);

const PROVIDERS: Record<ProviderName, true> = { anthropic: true, openai: true };
const provider = oneOf(keysOf(PROVIDERS));

export type LogErrorKind = ProviderErrorKind | "validation" | "unexpected";
const ERROR_KINDS: Record<LogErrorKind, true> = {
  transport: true,
  server: true,
  client: true,
  refusal: true,
  truncated: true,
  validation: true,
  unexpected: true,
};

// public.extraction_run_status and public.document_status
const RUN_STATUSES = ["running", "succeeded", "failed"] as const;
const DOCUMENT_STATUSES = ["uploading", "pending", "processing", "extracted", "needs_review", "failed"] as const;

const LOG_FIELDS = {
  // who and what: ids only, never names, emails or filenames
  run_id: uuid,
  document_id: uuid,
  tenant_id: uuid,
  user_id: uuid,

  // providers and models. A model id is what the provider reports, such as
  // gpt-5-nano-2025-08-07: lowercase, digits, dots and dashes.
  provider,
  primary_provider: provider,
  fallback_provider: provider,
  from_provider: provider,
  to_provider: provider,
  model: matching(/^[a-z0-9][a-z0-9.-]{0,63}$/, 64),

  // counts, sizes and durations
  attempt: count(1000),
  attempts: count(1000),
  retry: count(1000),
  input_tokens: count(),
  output_tokens: count(),
  latency_ms: count(),
  size_bytes: count(),
  field_count: count(1000),
  high_count: count(1000),
  medium_count: count(1000),
  low_count: count(1000),

  // outcomes
  run_status: oneOf(RUN_STATUSES),
  document_status: oneOf(DOCUMENT_STATUSES),
  mime_type: oneOf(SUPPORTED_MIME_TYPES),
  detected_mime_type: oneOf(SUPPORTED_MIME_TYPES),
  fallback_used: flag,

  // errors: what kind, which class, which code; never the message
  error_kind: oneOf(keysOf(ERROR_KINDS)),
  // an Error subclass name, such as TypeError or APIConnectionTimeoutError
  error_name: matching(/^[A-Z][A-Za-z]{0,39}$/, 40),
  // an application error code, such as primary_key_missing
  error_code: matching(/^[a-z][a-z0-9_]{0,47}$/, 48),
  // a Postgres SQLSTATE, such as 53400
  db_code: matching(/^[0-9A-Z]{5}$/, 5),
  http_status: (value: unknown) =>
    typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined,
} satisfies Record<string, Format<unknown>>;

export type LogFieldName = keyof typeof LOG_FIELDS;

// Every field is optional and may be null. Anything else is a type error.
export type LogFields = { [K in LogFieldName]?: FormatValue<(typeof LOG_FIELDS)[K]> | null };

export const LOG_FIELD_NAMES = Object.keys(LOG_FIELDS) as LogFieldName[];

type Clean = Partial<Record<LogFieldName, string | number | boolean | null>>;

// More keys than there are fields is already a mistake; don't walk them all.
const MAX_KEYS = LOG_FIELD_NAMES.length * 2;

// Keeps the allowlisted keys whose values fit their format and contain
// nothing secret. Reads each value once, so a getter can't pass the check
// and then return something else.
function sanitize(fields: unknown): { clean: Clean; dropped: number } {
  const clean: Clean = {};
  let dropped = 0;
  if (fields === undefined || fields === null) return { clean, dropped };
  if (typeof fields !== "object" || Array.isArray(fields)) return { clean, dropped: 1 };

  let keys: string[];
  try {
    keys = Object.keys(fields);
  } catch {
    return { clean, dropped: 1 };
  }

  for (const key of keys.slice(0, MAX_KEYS)) {
    if (!Object.prototype.hasOwnProperty.call(LOG_FIELDS, key)) {
      dropped += 1;
      continue;
    }
    const name = key as LogFieldName;
    let raw: unknown;
    try {
      raw = (fields as Record<string, unknown>)[name];
    } catch {
      dropped += 1;
      continue;
    }
    if (raw === undefined) continue;
    if (raw === null) {
      clean[name] = null;
      continue;
    }
    const value = (LOG_FIELDS[name] as Format<string | number | boolean>)(raw);
    if (value === undefined || (typeof value === "string" && containsSecret(value))) {
      dropped += 1;
      continue;
    }
    clean[name] = value;
  }
  dropped += Math.max(0, keys.length - MAX_KEYS);
  return { clean, dropped };
}

// Output --------------------------------------------------------------------

export type LogLevel = "info" | "warn" | "error";

// Receives one finished line, without a trailing newline.
export type LogSink = (line: string, level: LogLevel) => void;

// stdout for info, stderr for warnings and errors. Falls back to the console
// where there is no process stream (an edge runtime, a browser bundle).
export const defaultLogSink: LogSink = (line, level) => {
  const stream =
    typeof process === "undefined" ? undefined : level === "info" ? process.stdout : process.stderr;
  if (stream && typeof stream.write === "function") {
    stream.write(`${line}\n`);
  } else if (level === "info") {
    console.log(line);
  } else {
    console.error(line);
  }
};

let sink: LogSink = defaultLogSink;

// Replaces where lines go (tests capture them). Returns a function that
// puts the previous sink back.
export function setLogSink(next: LogSink): () => void {
  const previous = sink;
  sink = next;
  return () => {
    sink = previous;
  };
}

// Written when even the fixed line fails its own scan, which would take a
// registered secret that is a slice of a timestamp.
const LAST_RESORT = '{"ts":null,"level":"error","event":"log.redaction_failed","fields":{}}';

function timestamp(): string | null {
  try {
    return new Date().toISOString();
  } catch {
    return null;
  }
}

function fixedLine(event: OwnEvent, original?: LogEvent): string {
  try {
    const line = JSON.stringify({
      ts: timestamp(),
      level: "error",
      event,
      fields: original ? { original_event: original } : {},
    });
    return containsSecret(line) ? LAST_RESORT : line;
  } catch {
    return LAST_RESORT;
  }
}

function render(
  level: LogLevel,
  event: unknown,
  fields: unknown,
  context: Clean,
  contextDropped: number,
): [string, LogLevel] {
  if (typeof event !== "string" || event.length > MAX_EVENT_LENGTH || !KNOWN_EVENTS.has(event)) {
    return [fixedLine("log.invalid_event"), "error"];
  }
  const { clean, dropped } = sanitize(fields);
  const record: Record<string, unknown> = {
    ts: timestamp(),
    level,
    event,
    fields: { ...context, ...clean },
  };
  if (contextDropped + dropped > 0) record.dropped = contextDropped + dropped;
  // only strings, finite numbers, booleans and null by now, so this can't throw
  const line = JSON.stringify(record);
  if (containsSecret(line)) return [fixedLine("log.redaction_failed", event as LogEvent), "error"];
  return [line, level];
}

function write(level: LogLevel, event: unknown, fields: unknown, context: Clean, contextDropped: number): void {
  let line: string;
  let lineLevel: LogLevel;
  try {
    [line, lineLevel] = render(level, event, fields, context, contextDropped);
  } catch {
    [line, lineLevel] = [fixedLine("log.failed"), "error"];
  }
  try {
    sink(line, lineLevel);
  } catch {
    // a log line is never worth failing the request it describes
  }
}

// Logger --------------------------------------------------------------------

export interface Logger {
  info(event: LogEvent, fields?: LogFields): void;
  warn(event: LogEvent, fields?: LogFields): void;
  error(event: LogEvent, fields?: LogFields): void;
  // A logger that adds these fields (typically ids) to every line; they
  // pass the same checks, once, here.
  with(context: LogFields): Logger;
}

function createLogger(context: Clean, contextDropped: number): Logger {
  return {
    info: (event, fields) => write("info", event, fields, context, contextDropped),
    warn: (event, fields) => write("warn", event, fields, context, contextDropped),
    error: (event, fields) => write("error", event, fields, context, contextDropped),
    with: (more) => {
      try {
        const extra = sanitize(more);
        return createLogger({ ...context, ...extra.clean }, contextDropped + extra.dropped);
      } catch {
        return createLogger(context, contextDropped + 1);
      }
    },
  };
}

export const log: Logger = createLogger({}, 0);
