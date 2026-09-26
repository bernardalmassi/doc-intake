// The structured logger (src/lib/log.ts) and the scrubbing it shares with
// stored run errors (src/lib/redact.ts). What this file proves:
//
//   - a log line is one JSON object with a closed set of keys, and a valid
//     line passes the final scan (the checks don't fire on honest output)
//   - no route gets a key, a token or a signed URL into a line: the event
//     name, every allowed field, unknown and nested fields, arrays, an Error
//     whose message holds the key, a URL, the key glued mid-string, a value
//     forced through a cast; also keys of every known shape that were never
//     registered, and a seeded fuzz of a few thousand strings with a secret
//     spliced in
//   - value, source_text, raw_response, fields and filename are dropped, and
//     a real orchestrator run (fake providers) logs counts and kinds, never
//     a field value, the file name, the model's answer or an error message
//   - logging never throws, whatever it is handed
//   - the closed fields (error_code, model) take only their listed values,
//     counts hold at most ten digits, and a secret cut into short pieces
//     finds no closed field to hide in
//   - describeError, whose output is stored in extraction_runs.error, gets
//     the same scrubbing (including OpenAI organization ids) and otherwise
//     reads as before
//   - every known route around the logger is a lint error in src/lib
//
// "Contains a secret" is checked here independently of redact.ts: the raw
// value, or any 12-character slice of it. The fake keys are generated at
// runtime, in the real formats, from a seeded generator, so the file holds no
// key-shaped literal for a secret scanner to flag, the fuzz is reproducible,
// and none of them is real.

import { ESLint } from "eslint";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  describeError,
  ProviderError,
  type ExtractionProvider,
  type ProviderResponse,
} from "@/lib/extraction/providers/types";
import { runExtraction } from "@/lib/extraction/run";
import { FIELD_NAMES } from "@/lib/extraction/schema";
import { ERROR_CODES } from "@/lib/errors";
import { PRICING } from "@/lib/extraction/config";
import {
  defaultLogSink,
  log,
  LOG_ERROR_CODES,
  LOG_EVENTS,
  LOG_FIELD_NAMES,
  setLogSink,
  type LogEvent,
  type LogFieldName,
  type LogFields,
} from "@/lib/log";
import { containsSecret, REDACTED, redact, registerSecret } from "@/lib/redact";

// Seeded randomness ---------------------------------------------------------

// mulberry32: small, fast, and the same sequence on every machine
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const DIGITS = "0123456789";
const ALNUM = UPPER + LOWER + DIGITS;
const BASE64URL = ALNUM + "-_";
const HEX = "0123456789abcdef";

const keyRandom = prng(0xc0ffee);

function randomFrom(alphabet: string | readonly string[], length: number, next = keyRandom): string {
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[Math.floor(next() * alphabet.length)];
  return out;
}

function pick<T>(items: readonly T[], next: () => number): T {
  return items[Math.floor(next() * items.length)];
}

function uuid(): string {
  const h = (n: number) => randomFrom(HEX, n);
  return `${h(8)}-${h(4)}-4${h(3)}-${pick(["8", "9", "a", "b"], keyRandom)}${h(3)}-${h(12)}`;
}

function base64url(text: string): string {
  return Buffer.from(text).toString("base64url");
}

function jwt(payload: Record<string, unknown>): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  return `${header}.${base64url(JSON.stringify(payload))}.${randomFrom(BASE64URL, 43)}`;
}

// Fake secrets, in the real formats ------------------------------------------

// registered below, as providers/select.ts registers the API keys it reads
const ANTHROPIC_KEY = `sk-ant-api03-${randomFrom(BASE64URL, 93)}AA`;
const OPENAI_KEY = `sk-proj-${randomFrom(BASE64URL, 156)}`;
// a run's claim token is a UUID; the worker registers it (see the limit test)
const CLAIM_TOKEN = uuid();
// no known shape: only its registration catches it
const HEX_SECRET = randomFrom(HEX, 40);
// letters only, capital first: fits error_name's shape, so only the
// redactor stops it there
const LETTERS_SECRET = `Q${randomFrom(UPPER + LOWER, 29)}`;
const REGISTERED = [ANTHROPIC_KEY, OPENAI_KEY, CLAIM_TOKEN, HEX_SECRET, LETTERS_SECRET];

// never registered: caught by shape alone
const OPENAI_LEGACY_KEY = `sk-${randomFrom(ALNUM, 48)}`;
const ANTHROPIC_UNREGISTERED = `sk-ant-api03-${randomFrom(BASE64URL, 93)}AA`;
const SUPABASE_SECRET_KEY = `sb_secret_${randomFrom(BASE64URL, 31)}`;
const SUPABASE_PUBLISHABLE_KEY = `sb_publishable_${randomFrom(BASE64URL, 31)}`;
const SERVICE_ROLE_JWT = jwt({ iss: "supabase", ref: randomFrom(LOWER, 20), role: "service_role", iat: 1758000000, exp: 2073576000 });
const SESSION_JWT = jwt({ sub: uuid(), role: "authenticated", aal: "aal1", exp: 1758003600 });
const UNREGISTERED = [
  OPENAI_LEGACY_KEY,
  ANTHROPIC_UNREGISTERED,
  SUPABASE_SECRET_KEY,
  SUPABASE_PUBLISHABLE_KEY,
  SERVICE_ROLE_JWT,
  SESSION_JWT,
];
const ALL_SECRETS = [...REGISTERED, ...UNREGISTERED];

const PROJECT_HOST = `${randomFrom(LOWER, 20)}.supabase.co`;
const SIGNED_URL = `https://${PROJECT_HOST}/storage/v1/object/sign/documents/${uuid()}/${uuid()}?token=${SESSION_JWT}`;

const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);
const SOFT_HYPHEN = String.fromCharCode(0xad);
const WORD_JOINER = String.fromCharCode(0x2060);
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);
const INVISIBLES = [ZERO_WIDTH_SPACE, SOFT_HYPHEN, WORD_JOINER, BYTE_ORDER_MARK];
const NUL = String.fromCharCode(0);
const ESC = String.fromCharCode(0x1b);

// What a reader sees: the text with invisible characters removed.
function visible(text: string): string {
  return INVISIBLES.reduce((out, char) => out.split(char).join(""), text);
}

// Checks independent of redact.ts --------------------------------------------

const SLICE = 12;

// The value itself or any 12-character slice of it.
function leaks(text: string, secret: string): boolean {
  if (text.includes(secret)) return true;
  for (let i = 0; i + SLICE <= secret.length; i++) {
    if (text.includes(secret.slice(i, i + SLICE))) return true;
  }
  return false;
}

type Line = {
  ts: string | null;
  level: string;
  event: string;
  fields: Record<string, unknown>;
  dropped?: number;
};

const OWN_EVENTS = ["log.invalid_event", "log.redaction_failed", "log.failed"];

// One JSON object, only the documented keys, a known event, and in fields
// only allowlisted keys holding primitives.
function parse(line: string): Line {
  expect(line).not.toMatch(/[\r\n]/);
  const parsed = JSON.parse(line) as Line;
  expect(Object.keys(parsed).every((k) => ["ts", "level", "event", "fields", "dropped"].includes(k))).toBe(true);
  expect(["info", "warn", "error"]).toContain(parsed.level);
  expect([...LOG_EVENTS, ...OWN_EVENTS]).toContain(parsed.event);
  const allowed: readonly string[] = OWN_EVENTS.includes(parsed.event) ? ["original_event"] : LOG_FIELD_NAMES;
  for (const [key, value] of Object.entries(parsed.fields)) {
    expect(allowed).toContain(key);
    expect(value === null || ["string", "number", "boolean"].includes(typeof value)).toBe(true);
  }
  return parsed;
}

function expectNoLeak(texts: readonly string[], secrets: readonly string[]): void {
  for (const text of texts) {
    for (const secret of secrets) {
      if (leaks(text, secret)) throw new Error(`a secret leaked into: ${text.slice(0, 300)}`);
    }
  }
}

// Capture ---------------------------------------------------------------------

let lines: string[] = [];
let restoreSink: () => void = () => {};

beforeEach(() => {
  lines = [];
  restoreSink = setLogSink((line) => {
    lines.push(line);
  });
});

afterEach(() => {
  restoreSink();
  vi.restoreAllMocks();
});

function lastLine(): Line {
  expect(lines.length).toBeGreaterThan(0);
  return parse(lines[lines.length - 1]);
}

// A value for every field, all valid: the test won't compile until a new
// field gets one here.
const VALID: { [K in LogFieldName]-?: NonNullable<LogFields[K]> } = {
  run_id: uuid(),
  document_id: uuid(),
  tenant_id: uuid(),
  user_id: uuid(),
  provider: "anthropic",
  primary_provider: "anthropic",
  fallback_provider: "openai",
  from_provider: "anthropic",
  to_provider: "openai",
  model: "gpt-5-nano-2025-08-07",
  attempt: 2,
  attempts: 4,
  retry: 1,
  input_tokens: 800_000,
  output_tokens: 8_192,
  input_limit: 304_500,
  latency_ms: 60_000,
  size_bytes: 10_485_760,
  page_count: 100,
  expected_page_count: 1,
  field_count: 10,
  high_count: 8,
  medium_count: 1,
  low_count: 1,
  run_status: "succeeded",
  document_status: "needs_review",
  mime_type: "application/pdf",
  detected_mime_type: "image/png",
  fallback_used: true,
  error_kind: "transport",
  error_name: "APIConnectionTimeoutError",
  error_code: "primary_key_missing",
  db_code: "53400",
  http_status: 529,
};

// Line format -------------------------------------------------------------------

describe("line format", () => {
  it("writes one JSON object per line: ts, level, event, fields", () => {
    log.info("extraction.call_succeeded", {
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      attempt: 1,
      input_tokens: 5036,
      output_tokens: 468,
      latency_ms: 3800,
    });
    expect(lines).toHaveLength(1);
    const line = parse(lines[0]);
    expect(line.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(line).toMatchObject({
      level: "info",
      event: "extraction.call_succeeded",
      fields: {
        provider: "anthropic",
        model: "claude-haiku-4-5-20251001",
        attempt: 1,
        input_tokens: 5036,
        output_tokens: 468,
        latency_ms: 3800,
      },
    });
    expect(line.dropped).toBeUndefined();
  });

  it("keeps every field when every value is valid, and the final scan lets it through", () => {
    log.warn("extraction.run_finished", VALID);
    const line = lastLine();
    expect(line.event).toBe("extraction.run_finished");
    expect(line.fields).toEqual(VALID);
    expect(line.dropped).toBeUndefined();
  });

  it("accepts null for any field", () => {
    const nulls = Object.fromEntries(LOG_FIELD_NAMES.map((name) => [name, null])) as LogFields;
    log.info("extraction.run_finished", nulls);
    expect(lastLine().fields).toEqual(nulls);
  });

  it("with() adds its fields to every line, checked the same way", () => {
    const runLog = log.with({ run_id: VALID.run_id, document_id: VALID.document_id });
    runLog.info("extraction.call_succeeded", { attempt: 1 });
    runLog.warn("extraction.call_failed", { attempt: 2 });
    expect(lines.map((l) => parse(l).fields)).toEqual([
      { run_id: VALID.run_id, document_id: VALID.document_id, attempt: 1 },
      { run_id: VALID.run_id, document_id: VALID.document_id, attempt: 2 },
    ]);
  });

  it("refuses unknown events, unknown keys and off-type values at compile time as well as at runtime", () => {
    // Each call is a type error; tsc fails if one stops being one, because
    // an unused @ts-expect-error is itself an error.
    // @ts-expect-error: not an event
    log.info("extraction.anything");
    // @ts-expect-error: not a field
    log.info("extraction.run_finished", { value: "Zebra Canary GmbH" });
    // @ts-expect-error: not a field
    log.info("extraction.run_finished", { filename: "invoice.pdf" });
    // @ts-expect-error: not a provider
    log.info("extraction.run_finished", { provider: "gemini" });
    // @ts-expect-error: a count is a number
    log.info("extraction.run_finished", { attempts: "3" });
    const dropped = { event: "extraction.run_finished", fields: {}, dropped: 1 };
    expect(lines.map(parse)).toMatchObject([{ event: "log.invalid_event" }, dropped, dropped, dropped, dropped]);
  });

  it("names every event in lowercase dotted words", () => {
    for (const event of LOG_EVENTS) expect(event).toMatch(/^[a-z][a-z0-9_.]{0,63}$/);
  });

  it("sends info to stdout and warnings and errors to stderr by default", () => {
    // the test setup silences the logger; put the real default back
    setLogSink(defaultLogSink);
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    log.info("extraction.providers_selected", { primary_provider: "anthropic", fallback_provider: null });
    log.warn("extraction.fallback", { from_provider: "anthropic", to_provider: "openai" });
    log.error("extraction.not_configured", { error_code: "primary_key_missing" });
    expect(out).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalledTimes(2);
    const written = [...out.mock.calls, ...err.mock.calls].map((call) => String(call[0]));
    for (const line of written) {
      expect(line.endsWith("\n")).toBe(true);
      parse(line.slice(0, -1));
    }
  });
});

// Every route for a secret ---------------------------------------------------

describe("no route gets a secret into a line", () => {
  const releases: (() => void)[] = [];
  beforeAll(() => {
    for (const secret of REGISTERED) releases.push(registerSecret(secret));
  });
  afterAll(() => {
    for (const release of releases) release();
  });

  it("not through the event name", () => {
    for (const secret of [...ALL_SECRETS, SIGNED_URL]) {
      log.info(secret as LogEvent);
      log.info(`extraction.call_failed ${secret}` as LogEvent);
      log.info(`extraction.${secret.toLowerCase()}` as LogEvent);
    }
    for (const line of lines) expect(parse(line).event).toBe("log.invalid_event");
    expectNoLeak(lines, ALL_SECRETS);
  });

  it("not through any allowed field, as is, glued mid-string, lowercased or shaped like a model id", () => {
    for (const name of LOG_FIELD_NAMES) {
      for (const secret of [...ALL_SECRETS, SIGNED_URL]) {
        const variants = [
          secret,
          `x${secret}y`,
          `prefix ${secret} suffix`,
          secret.toLowerCase(),
          `gpt-5-${secret.toLowerCase()}`.slice(0, 64),
        ];
        for (const variant of variants) {
          lines = [];
          log.info("extraction.run_finished", { [name]: variant } as LogFields);
          const line = lastLine();
          expectNoLeak([lines[0]], ALL_SECRETS);
          // the exact value never survives in any field
          if (variant === secret) {
            expect(line.fields).toEqual({});
            expect(line.dropped).toBe(1);
          }
        }
      }
    }
  });

  it("drops a registered secret even where it fits a shape-limited field", () => {
    log.info("extraction.call_failed", { error_name: LETTERS_SECRET, attempt: 1 });
    const line = lastLine();
    expect(line.fields).toEqual({ attempt: 1 });
    expect(line.dropped).toBe(1);
    // and a registered claim token, where it would be a valid id
    log.info("worker.claimed", { run_id: CLAIM_TOKEN, document_id: VALID.document_id });
    expect(lastLine().fields).toEqual({ document_id: VALID.document_id });
  });

  it("not through unknown keys, nested objects, arrays, errors or URLs: all dropped", () => {
    const smuggled = {
      value: ANTHROPIC_KEY,
      source_text: ANTHROPIC_KEY,
      raw_response: `{"title":{"value":"${OPENAI_KEY}"}}`,
      fields: [{ name: "title", value: OPENAI_KEY }],
      filename: `${ANTHROPIC_KEY}.pdf`,
      message: ANTHROPIC_KEY,
      error: new Error(`invalid x-api-key ${ANTHROPIC_KEY}`),
      url: SIGNED_URL,
      signed_url: SIGNED_URL,
      headers: { authorization: `Bearer ${SESSION_JWT}` },
      close_token: CLAIM_TOKEN,
      api_key: OPENAI_KEY,
      [ANTHROPIC_KEY]: 1,
    };
    log.error("worker.finish_failed", smuggled as unknown as LogFields);
    const line = lastLine();
    expect(line.fields).toEqual({});
    expect(line.dropped).toBe(Object.keys(smuggled).length);
    expectNoLeak(lines, ALL_SECRETS);
  });

  it("not through a value forced into an allowed key with a cast", () => {
    const forced = {
      attempt: ANTHROPIC_KEY,
      provider: OPENAI_KEY,
      run_status: SERVICE_ROLE_JWT,
      http_status: SESSION_JWT,
      fallback_used: SUPABASE_SECRET_KEY,
      model: { toString: () => ANTHROPIC_KEY, toJSON: () => ANTHROPIC_KEY },
      error_name: [ANTHROPIC_KEY],
      error_code: new String(HEX_SECRET),
      run_id: { valueOf: () => CLAIM_TOKEN },
      document_id: Object.assign(new Error(ANTHROPIC_KEY), { toJSON: () => ANTHROPIC_KEY }),
    };
    log.info("extraction.call_failed", forced as unknown as LogFields);
    const line = lastLine();
    expect(line.fields).toEqual({});
    expect(line.dropped).toBe(Object.keys(forced).length);
    expectNoLeak(lines, ALL_SECRETS);
  });

  it("the final scan replaces a line whose fields spell a secret only once joined", () => {
    // Each value passes on its own (numbers aren't redacted one by one); the
    // registered value appears only in the serialized line.
    const secret = '424242,"output_tokens":242424';
    const release = registerSecret(secret);
    try {
      log.info("extraction.run_finished", { input_tokens: 424242, output_tokens: 242424 });
      const line = lastLine();
      expect(line.event).toBe("log.redaction_failed");
      expect(line.level).toBe("error");
      expect(line.fields).toEqual({ original_event: "extraction.run_finished" });
      expect(lines[0]).not.toContain(secret);
    } finally {
      release();
    }
  });

  it("limit: an unregistered claim token is indistinguishable from an id", () => {
    // Both are UUIDs, so no shape rule can tell them apart. This is why a
    // caller holding a claim token must register it (registerSecret) and
    // must not put it in an id field; the logger has no field named token.
    const unregistered = uuid();
    log.info("worker.claimed", { run_id: unregistered });
    expect(lastLine().fields).toEqual({ run_id: unregistered });
  });
});

// Closed fields and bounded shapes -------------------------------------------------

describe("closed fields take only their listed values; shapes are bounded", () => {
  const releases: (() => void)[] = [];
  beforeAll(() => {
    for (const secret of REGISTERED) releases.push(registerSecret(secret));
  });
  afterAll(() => {
    for (const release of releases) release();
  });

  function kept(fields: Record<string, unknown>): Record<string, unknown> {
    lines = [];
    log.info("extraction.run_finished", fields as LogFields);
    return lastLine().fields;
  }

  it("error_code also takes each user-facing code a Server Action returns", () => {
    for (const code of ERROR_CODES) expect(kept({ error_code: code })).toEqual({ error_code: code });
    for (const text of ["auth.invalid_credentials.", "Auth.invalid_credentials", "tenant.slug_taken see https://x"]) {
      expect(kept({ error_code: text })).toEqual({});
    }
  });

  it("error_code is one of LOG_ERROR_CODES, not any snake_case", () => {
    for (const code of LOG_ERROR_CODES) expect(kept({ error_code: code })).toEqual({ error_code: code });
    for (const text of ["ignore_previous_instructions", "primary_key_missing_", "the_total_is_7781", "a"]) {
      expect(kept({ error_code: text })).toEqual({});
    }
  });

  it("model is an id priced in config.ts, optionally with a date snapshot suffix", () => {
    const accepted = [
      ...Object.keys(PRICING),
      "gpt-5-nano-2025-08-07",
      "gpt-5-mini-20250807",
      "claude-sonnet-5-20260115",
      "claude-haiku-4-5-20251001",
    ];
    for (const model of accepted) expect(kept({ model })).toEqual({ model });
    const refused = [
      "4111-1111-1111-1111",
      "gpt-5-nano-ignore-previous-instructions",
      "gpt-5-nano-4111111111111111",
      "gpt-5-nano-2025-13-01",
      "gpt-5-nano-2025-0807",
      "gpt-5-nano-19990807",
      "gpt-5-nano-2025-08-07-2025-08-07",
      "gpt-5",
      "gpt-4o",
      "claude-haiku-4-5",
      "GPT-5-NANO",
      "",
    ];
    for (const model of refused) expect(kept({ model })).toEqual({});
  });

  it("a count holds at most ten digits, so a card number doesn't fit", () => {
    expect(kept({ size_bytes: 1_000_000_000 })).toEqual({ size_bytes: 1_000_000_000 });
    for (const value of [4111111111111111, 1_000_000_001]) expect(kept({ size_bytes: value, input_tokens: value })).toEqual({});
    expect(kept({ attempt: 1001, field_count: 1001 })).toEqual({});
  });

  it("a secret cut into short pieces finds no closed field; only a piece of the right shape fits error_name or db_code", () => {
    const stringFields = LOG_FIELD_NAMES.filter((name) => typeof VALID[name] === "string");
    for (const secret of [ANTHROPIC_KEY, OPENAI_KEY, HEX_SECRET, LETTERS_SECRET]) {
      for (const size of [4, 5, 8, 11]) {
        for (const text of [secret, secret.toLowerCase()]) {
          for (let at = 0; at < text.length; at += size) {
            const piece = text.slice(at, at + size);
            for (const name of stringFields) {
              if (!(name in kept({ [name]: piece }))) continue;
              // the only fields a piece can land in, and only in their shape
              const fits =
                (name === "error_name" && /^[A-Z][A-Za-z]{0,39}$/.test(piece)) ||
                (name === "db_code" && /^[0-9A-Z]{5}$/.test(piece));
              expect(fits, `${name} kept ${piece}`).toBe(true);
            }
          }
        }
      }
    }
  });

  it("the case the review found: pieces across with({ model }) and error_code are dropped", () => {
    for (const secret of [HEX_SECRET, ANTHROPIC_KEY.toLowerCase()]) {
      for (let at = 0; at + 22 <= secret.length; at += 22) {
        lines = [];
        log
          .with({ model: secret.slice(at, at + 11) } as LogFields)
          .info("extraction.run_finished", { error_code: secret.slice(at + 11, at + 22) } as LogFields);
        const line = lastLine();
        expect(line.fields).toEqual({});
        expect(line.dropped).toBe(2);
      }
    }
  });
});

// Free text: redact() and describeError() --------------------------------------

describe("free text is scrubbed of keys of every shape", () => {
  const releases: (() => void)[] = [];
  beforeAll(() => {
    for (const secret of REGISTERED) releases.push(registerSecret(secret));
  });
  afterAll(() => {
    for (const release of releases) release();
  });

  it.each([
    ["an Anthropic key (unregistered)", ANTHROPIC_UNREGISTERED],
    ["an OpenAI legacy key", OPENAI_LEGACY_KEY],
    ["a Supabase secret key", SUPABASE_SECRET_KEY],
    ["a Supabase publishable key", SUPABASE_PUBLISHABLE_KEY],
    ["a Supabase service_role JWT", SERVICE_ROLE_JWT],
    ["a session JWT", SESSION_JWT],
    ["a registered Anthropic key", ANTHROPIC_KEY],
    ["a registered OpenAI project key", OPENAI_KEY],
    ["a registered close token", CLAIM_TOKEN],
    ["a registered hex secret", HEX_SECRET],
    ["a registered letters-only secret", LETTERS_SECRET],
  ])("%s, alone, spaced or glued to other text", (_name, secret) => {
    for (const text of [secret, `error: ${secret} rejected`, `glued${secret}glued`, `(${secret})`, `"${secret}"`]) {
      const scrubbed = redact(text);
      expect(scrubbed).toContain(REDACTED);
      expectNoLeak([scrubbed], [secret]);
    }
    expect(containsSecret(secret)).toBe(true);
  });

  it("an Authorization header, whatever the token looks like", () => {
    const opaque = randomFrom(ALNUM, 32);
    for (const text of [`Authorization: Bearer ${opaque}`, `authorization: bearer ${opaque}`, `Basic ${opaque}`]) {
      expectNoLeak([redact(text)], [opaque]);
    }
  });

  it("credential-named parameters in queries, headers and JSON", () => {
    const opaque = randomFrom(ALNUM, 20);
    for (const text of [
      `apikey=${opaque}&x=1`,
      `x-api-key: ${opaque}`,
      `{"api_key": "${opaque}"}`,
      `password=${opaque}`,
      `client_secret=${opaque}`,
      `close_token=${opaque}`,
      `access_token: ${opaque}`,
    ]) {
      expectNoLeak([redact(text)], [opaque]);
    }
  });

  it("a signed URL loses its query string; userinfo goes too", () => {
    const scrubbed = redact(`download failed: ${SIGNED_URL}`);
    expect(scrubbed).not.toContain("token=");
    expect(scrubbed).toContain(`https://${PROJECT_HOST}`);
    expectNoLeak([scrubbed], [SESSION_JWT]);

    const password = randomFrom(ALNUM, 20);
    const dsn = redact(`connect to postgres://postgres:${password}@db.${PROJECT_HOST}:5432/postgres failed`);
    expect(dsn).toContain(`postgres://${REDACTED}@db.${PROJECT_HOST}`);
    expectNoLeak([dsn], [password]);

    const opaque = randomFrom(ALNUM, 16);
    expectNoLeak([redact(`https://example.com/cb?code=${opaque}#state=${opaque}`)], [opaque]);
  });

  it("a data: URL, which is how the OpenAI provider sends the document", () => {
    const content = Buffer.from(`%PDF-1.7 invoice for ${randomFrom(ALNUM, 30)}`).toString("base64");
    const scrubbed = redact(`request body: {"file_data":"data:application/pdf;base64,${content}"}`);
    expect(scrubbed).toContain(`data:${REDACTED}`);
    expectNoLeak([scrubbed], [content]);
  });

  it("a registered key split by invisible characters, control characters or newlines, or cut short", () => {
    const at = 40;
    const variants = [
      ANTHROPIC_KEY.slice(0, at) + ZERO_WIDTH_SPACE + ANTHROPIC_KEY.slice(at),
      ANTHROPIC_KEY.slice(0, at) + SOFT_HYPHEN + ANTHROPIC_KEY.slice(at),
      ANTHROPIC_KEY.slice(0, at) + "\n" + ANTHROPIC_KEY.slice(at),
      ANTHROPIC_KEY.slice(0, at) + NUL + ANTHROPIC_KEY.slice(at),
      ANTHROPIC_KEY.slice(0, 30),
      ANTHROPIC_KEY.slice(50, 70),
      OPENAI_KEY.slice(-20),
    ];
    for (const text of variants) {
      const scrubbed = redact(`before ${text} after`);
      expectNoLeak([scrubbed, visible(scrubbed).replace(/\s/g, "")], [ANTHROPIC_KEY, OPENAI_KEY]);
    }
  });

  it("an unregistered key split by an invisible character, where neither half fits a rule alone", () => {
    for (const secret of UNREGISTERED) {
      for (const at of [4, 13, 16, 20, secret.length - 20]) {
        for (const char of INVISIBLES) {
          const text = `key ${secret.slice(0, at)}${char}${secret.slice(at)} rejected`;
          expectNoLeak([visible(redact(text)), visible(describeError(new Error(text)))], [secret]);
        }
      }
    }
  });

  it("OpenAI organization and project ids, which its error messages quote, but not ordinary words", () => {
    const org = `org-${randomFrom(ALNUM, 24)}`;
    const project = `proj_${randomFrom(ALNUM, 24)}`;
    const rateLimited = (id: string) =>
      `429 Rate limit reached for gpt-5-nano in organization ${id} on tokens per min (TPM): Limit 200000, Used 199000, Requested 5036.`;
    expect(describeError(new ProviderError("openai", "client", rateLimited(org), 429))).toBe(
      `openai client 429: ${rateLimited(REDACTED)}`,
    );
    expectNoLeak([redact(`project ${project} is over its budget`), redact(`glued${org}glued`)], [org, project]);
    for (const ordinary of [
      "an org-wide setting",
      "see the org-chart",
      "org-12345",
      "proj_config is missing",
      "the user-agent header",
    ]) {
      expect(redact(ordinary)).toBe(ordinary);
    }
  });

  it("control characters, including NUL, which Postgres text can't store", () => {
    expect(redact(`a${NUL}b${ESC}[31mc`)).toBe("a b [31mc");
  });

  it("a key at the cut of a very long input, and in reasonable time", () => {
    const started = Date.now();
    for (const cut of [19_990, 19_999, 20_000, 20_010]) {
      const text = "x ".repeat(cut / 2) + ANTHROPIC_UNREGISTERED + " tail";
      expectNoLeak([redact(text)], [ANTHROPIC_UNREGISTERED]);
    }
    for (const huge of ["a".repeat(5_000_000), "a://".repeat(1_000_000), "token=".repeat(1_000_000)]) {
      expect(() => redact(huge)).not.toThrow();
    }
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("leaves ordinary error text alone", () => {
    for (const text of [
      "request timed out",
      "openai server 502: bad gateway",
      'Unexpected token \'x\', "xyz" is not valid JSON',
      "the answer exceeded the 2048 output token cap",
      "run not found or close token invalid",
      `document ${VALID.document_id} is already processing`,
    ]) {
      expect(redact(text)).toBe(text);
    }
  });
});

describe("describeError, whose output is stored in extraction_runs.error", () => {
  let release: () => void = () => {};
  beforeAll(() => {
    release = registerSecret(ANTHROPIC_KEY);
  });
  afterAll(() => release());

  it("reads as before for ordinary errors", () => {
    expect(describeError(new ProviderError("openai", "server", "bad gateway", 502))).toBe(
      "openai server 502: bad gateway",
    );
    expect(describeError(new ProviderError("anthropic", "transport", "request timed out"))).toBe(
      "anthropic transport: request timed out",
    );
    expect(describeError(new TypeError("fetch failed"))).toBe("TypeError: fetch failed");
    expect(describeError("plain string")).toBe("plain string");
  });

  it("scrubs a registered key, unregistered key shapes and signed URLs", () => {
    expect(describeError(new ProviderError("anthropic", "client", `invalid x-api-key ${ANTHROPIC_KEY}`, 401))).toBe(
      `anthropic client 401: invalid x-api-key ${REDACTED}`,
    );
    // the shape the previous implementation scrubbed still is
    expect(describeError(new Error(`bad key ${OPENAI_LEGACY_KEY}`))).toBe(`Error: bad key ${REDACTED}`);
    const stored = describeError(new Error(`could not download ${SIGNED_URL} with ${SERVICE_ROLE_JWT}`));
    expectNoLeak([stored], [SESSION_JWT, SERVICE_ROLE_JWT, ANTHROPIC_KEY]);
  });

  it("is capped at 2000 characters", () => {
    expect(describeError(new Error("word ".repeat(2000)))).toHaveLength(2000);
  });

  it("never throws, even on an error that can't be turned into a string", () => {
    const hostile = {
      toString() {
        throw new Error(ANTHROPIC_KEY);
      },
    };
    expect(() => describeError(hostile)).not.toThrow();
    expectNoLeak([describeError(hostile)], [ANTHROPIC_KEY]);
    expect(() => describeError(Symbol("x"))).not.toThrow();
    expect(() => describeError(null)).not.toThrow();
  });
});

// Seeded fuzz -----------------------------------------------------------------

describe("seeded fuzz", () => {
  const releases: (() => void)[] = [];
  beforeAll(() => {
    for (const secret of REGISTERED) releases.push(registerSecret(secret));
  });
  afterAll(() => {
    for (const release of releases) release();
  });

  it("no line, scrubbed text or stored error ever holds the spliced secret", () => {
    const next = prng(20260918);
    const noiseAlphabet = [
      ...ALNUM,
      ..."-_./:?=&%+@#~ ,;|'\"`()[]{}<>",
      "\n",
      "\t",
      "\r",
      ...INVISIBLES,
      NUL,
      ESC,
      String.fromCharCode(0xe9),
      String.fromCharCode(0xd83d, 0xde00),
      "sk-",
      "eyJ",
      "https://",
      "Bearer ",
      "token=",
    ];
    // [what is spliced in, what must never appear]
    const cases: [string, string][] = [
      ...ALL_SECRETS.map((secret): [string, string] => [secret, secret]),
      [SIGNED_URL, SESSION_JWT],
      [`Authorization: Bearer ${SERVICE_ROLE_JWT}`, SERVICE_ROLE_JWT],
    ];

    for (let i = 0; i < 3000; i++) {
      const [whole, secret] = pick(cases, next);
      // one time in four, an invisible character inside the secret itself
      const inside = Math.floor(next() * whole.length);
      const spliced =
        next() < 0.25 ? whole.slice(0, inside) + pick(INVISIBLES, next) + whole.slice(inside) : whole;
      const noise = randomFrom(noiseAlphabet, Math.floor(next() * 80), next);
      const at = Math.floor(next() * (noise.length + 1));
      const text = noise.slice(0, at) + spliced + noise.slice(at);

      const scrubbed = redact(text);
      expect(containsSecret(scrubbed)).toBe(false);
      const stored = describeError(new Error(text));

      lines = [];
      const field = pick(LOG_FIELD_NAMES, next);
      log.info(text as LogEvent);
      log.warn("extraction.call_failed", { [field]: text, note: text, nested: { text }, list: [text] } as LogFields);
      log.with({ [field]: text } as LogFields).error("extraction.run_finished", { attempts: 1 });
      expect(lines).toHaveLength(3);
      for (const line of lines) {
        parse(line);
        expect(containsSecret(line)).toBe(false);
      }

      expectNoLeak([scrubbed, stored, ...lines].map(visible), [secret]);
    }
  });
});

// Hostile input -----------------------------------------------------------------

describe("logging never throws", () => {
  function circular(): Record<string, unknown> {
    const a: Record<string, unknown> = { attempt: 1 };
    a.self = a;
    a.model = a;
    return a;
  }

  const throwingProxy = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error(ANTHROPIC_KEY);
      },
      get() {
        throw new Error(ANTHROPIC_KEY);
      },
    },
  );

  const throwingGetter = Object.defineProperty({ attempt: 1 }, "model", {
    enumerable: true,
    get() {
      throw new Error(ANTHROPIC_KEY);
    },
  });

  const cases: [string, unknown][] = [
    ["a circular object", circular()],
    ["a BigInt", { input_tokens: BigInt(5), attempt: 1 }],
    ["a symbol value", { model: Symbol(ANTHROPIC_KEY), attempt: 1 }],
    ["a symbol key", { [Symbol("k")]: ANTHROPIC_KEY, attempt: 1 }],
    ["a huge string", { model: "a".repeat(10_000_000), attempt: 1 }],
    ["a proxy that throws", throwingProxy],
    ["a getter that throws", throwingGetter],
    ["a function", () => ANTHROPIC_KEY],
    ["a string", ANTHROPIC_KEY],
    ["a number", 42],
    ["an array", [ANTHROPIC_KEY]],
    ["NaN and infinities", { attempt: NaN, attempts: Infinity, input_tokens: -1, output_tokens: 1.5, latency_ms: Number.MAX_VALUE }],
    ["prototype keys", JSON.parse('{"__proto__": {"model": "polluted"}, "constructor": 1, "toString": 2, "attempt": 1}')],
  ];

  it.each(cases)("%s", (_name, hostile) => {
    expect(() => log.info("extraction.call_failed", hostile as LogFields)).not.toThrow();
    expect(() => log.with(hostile as LogFields).warn("extraction.call_failed")).not.toThrow();
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const parsed = parse(line);
      expect(parsed.event).toBe("extraction.call_failed");
      expect(Object.keys(parsed.fields).every((k) => k === "attempt")).toBe(true);
    }
    expectNoLeak(lines, [ANTHROPIC_KEY]);
    expect(({} as Record<string, unknown>).model).toBeUndefined();
  });

  it("a huge or non-string event name", () => {
    for (const event of ["a".repeat(10_000_000), 42, null, undefined, Symbol("e"), { toString: () => "extraction.fallback" }]) {
      expect(() => log.info(event as LogEvent)).not.toThrow();
    }
    for (const line of lines) expect(parse(line).event).toBe("log.invalid_event");
  });

  it("reads a getter once, so it can't pass the check and then return something else", () => {
    let reads = 0;
    const flipping = Object.defineProperty({}, "model", {
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1 ? "gpt-5-nano" : ANTHROPIC_KEY;
      },
    });
    log.info("extraction.call_succeeded", flipping as LogFields);
    expect(lastLine().fields).toEqual({ model: "gpt-5-nano" });
    expect(reads).toBe(1);
  });

  it("a sink that throws", () => {
    const restore = setLogSink(() => {
      throw new Error("EPIPE");
    });
    try {
      expect(() => log.error("worker.finish_failed", { db_code: "42501" })).not.toThrow();
    } finally {
      restore();
    }
  });

  it("a clock that throws", () => {
    vi.spyOn(Date.prototype, "toISOString").mockImplementation(() => {
      throw new RangeError("Invalid time value");
    });
    expect(() => log.info("extraction.fallback", { from_provider: "anthropic" })).not.toThrow();
    expect(lastLine()).toMatchObject({ ts: null, event: "extraction.fallback" });
  });
});

// The orchestrator's lines -----------------------------------------------------------

describe("an extraction run logs counts and kinds, never content", () => {
  let release: () => void = () => {};
  beforeAll(() => {
    // as providers/select.ts does when it reads the key
    release = registerSecret(ANTHROPIC_KEY);
  });
  afterAll(() => release());

  const RUN_ID = uuid();
  const DOCUMENT_ID = uuid();
  const FILENAME = "Zebra Canary invoice.pdf";
  const BYTES = new TextEncoder().encode("%PDF-1.7 zebra canary");

  // Every value, source text and question carries "zebra", so one search
  // proves none of it reached a line.
  function canaryAnswer(): string {
    const values: Record<string, string> = {
      document_type: "invoice",
      title: "Zebra Canary Invoice",
      sender_name: "Zebra Canary GmbH",
      recipient_name: "Zebra Recipient",
      document_date: "2031-07-19",
      due_date: "2031-08-19",
      payment_terms_days: "31",
      reference_number: "ZEBRA-7781",
      total_amount: "7781.23",
      currency: "XPF", // a real ISO code (validation checks), rare enough to spot in a log line
      summary: "A zebra canary invoice.",
    };
    const confidence: Record<string, number> = { sender_name: 0.7, recipient_name: 0.3 };
    const fields: Record<string, unknown> = {};
    for (const name of FIELD_NAMES) {
      fields[name] = {
        value: values[name],
        confidence: confidence[name] ?? 0.95,
        source_text: `zebra source for ${values[name]}`,
        clarifying_question: confidence[name] ? "Is this the zebra?" : "",
      };
    }
    return JSON.stringify(fields);
  }

  function provider(
    name: "anthropic" | "openai",
    model: string,
    answers: (ProviderResponse | Error)[],
  ): ExtractionProvider {
    return {
      name,
      model,
      async countInputTokens() {
        return 1000;
      },
      async extract() {
        const next = answers.shift();
        if (!next) throw new Error("no answer left");
        if (next instanceof Error) throw next;
        return next;
      },
    };
  }

  const answer = (text: string, model: string): ProviderResponse => ({ text, inputTokens: 5036, outputTokens: 468, model });

  function expectNoContent(): void {
    for (const line of lines) {
      expect(line).not.toMatch(/zebra|canary|7781|2031-0|XPF/i);
      expect(line).not.toContain(FILENAME);
    }
    expectNoLeak(lines, [ANTHROPIC_KEY]);
  }

  it("a successful run: one line per call and one at the finish, with band counts", async () => {
    const outcome = await runExtraction({
      bytes: BYTES,
      mimeType: "application/pdf",
      pages: 1,
      filename: FILENAME,
      primary: provider("anthropic", "claude-haiku-4-5-20251001", [answer(canaryAnswer(), "claude-haiku-4-5-20251001")]),
      fallback: null,
      logContext: { run_id: RUN_ID, document_id: DOCUMENT_ID },
    });
    expect(outcome.status).toBe("succeeded");

    const parsed = lines.map(parse);
    // the count before the call, then the call, then the finish
    expect(parsed.map((l) => l.event)).toEqual(["extraction.input_counted", "extraction.call_succeeded", "extraction.run_finished"]);
    expect(parsed[0].fields).toEqual({
      run_id: RUN_ID,
      document_id: DOCUMENT_ID,
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      input_tokens: 1000,
      input_limit: 7500,
    });
    expect(parsed[1].fields).toMatchObject({
      run_id: RUN_ID,
      document_id: DOCUMENT_ID,
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      attempt: 1,
      input_tokens: 5036,
      output_tokens: 468,
    });
    expect(parsed[2]).toMatchObject({
      level: "info",
      fields: {
        run_id: RUN_ID,
        document_id: DOCUMENT_ID,
        run_status: "succeeded",
        provider: "anthropic",
        model: "claude-haiku-4-5-20251001",
        attempts: 1,
        input_tokens: 5036,
        output_tokens: 468,
        fallback_used: false,
        field_count: FIELD_NAMES.length,
        high_count: FIELD_NAMES.length - 2,
        medium_count: 1,
        low_count: 1,
        document_status: "needs_review",
      },
    });
    expect(parsed.every((l) => l.dropped === undefined)).toBe(true);
    expectNoContent();
  });

  it("a fallback and a validation retry: kinds and statuses, not messages or answers", async () => {
    const outcome = await runExtraction({
      bytes: BYTES,
      mimeType: "application/pdf",
      pages: 1,
      filename: FILENAME,
      primary: provider("anthropic", "claude-haiku-4-5-20251001", [
        new ProviderError("anthropic", "server", `overloaded; zebra; key ${ANTHROPIC_KEY}`, 529),
      ]),
      fallback: provider("openai", "gpt-5-nano", [
        answer('{"title": "zebra canary" not json', "gpt-5-nano-2025-08-07"),
        answer(canaryAnswer(), "gpt-5-nano-2025-08-07"),
      ]),
      logContext: { run_id: RUN_ID },
    });
    expect(outcome.status).toBe("succeeded");

    const parsed = lines.map(parse);
    expect(parsed.map((l) => l.event)).toEqual([
      "extraction.input_counted",
      "extraction.call_failed",
      "extraction.fallback",
      "extraction.input_counted",
      "extraction.call_succeeded",
      "extraction.validation_retry",
      "extraction.input_counted",
      "extraction.call_succeeded",
      "extraction.run_finished",
    ]);
    expect(parsed[1].fields).toMatchObject({ provider: "anthropic", attempt: 1, error_kind: "server", http_status: 529 });
    expect(parsed[2].fields).toMatchObject({ from_provider: "anthropic", to_provider: "openai", error_kind: "server" });
    expect(parsed[3].fields).toMatchObject({ provider: "openai", input_tokens: 1000, input_limit: 7500 });
    expect(parsed[5].fields).toEqual({ run_id: RUN_ID, provider: "openai", retry: 1, error_kind: "validation" });
    expect(parsed[8].fields).toMatchObject({ run_status: "succeeded", attempts: 3, fallback_used: true, provider: "openai" });
    expectNoContent();
  });

  it("a failed run: the failure's kind and status; the stored error is scrubbed", async () => {
    const outcome = await runExtraction({
      bytes: BYTES,
      mimeType: "application/pdf",
      pages: 1,
      filename: FILENAME,
      primary: provider("anthropic", "claude-haiku-4-5-20251001", [
        new ProviderError("anthropic", "client", `invalid x-api-key ${ANTHROPIC_KEY} for zebra`, 401),
      ]),
      fallback: null,
    });
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.error).toContain(REDACTED);
      expectNoLeak([outcome.error], [ANTHROPIC_KEY]);
    }
    const finished = parse(lines[lines.length - 1]);
    expect(finished).toMatchObject({
      level: "warn",
      event: "extraction.run_finished",
      fields: { run_status: "failed", error_kind: "client", http_status: 401, attempts: 1 },
    });
    expectNoContent();
  });

  it("an unexpected error is logged by class name only", async () => {
    await runExtraction({
      bytes: BYTES,
      mimeType: "application/pdf",
      pages: 1,
      filename: FILENAME,
      primary: provider("anthropic", "claude-haiku-4-5-20251001", [new TypeError(`fetch failed: ${SIGNED_URL} zebra`)]),
      fallback: null,
    });
    const failed = parse(lines[1]);
    expect(failed.event).toBe("extraction.call_failed");
    expect(failed.fields).toMatchObject({ error_kind: "unexpected", error_name: "TypeError" });
    expectNoContent();
    expectNoLeak(lines, [SESSION_JWT]);
  });

  it("an answer that fails validation twice: error_kind validation, no validation text", async () => {
    await runExtraction({
      bytes: BYTES,
      mimeType: "application/pdf",
      pages: 1,
      filename: FILENAME,
      primary: provider("anthropic", "claude-haiku-4-5-20251001", [
        answer("zebra canary, not JSON", "claude-haiku-4-5-20251001"),
        answer('{"zebra": "canary"}', "claude-haiku-4-5-20251001"),
      ]),
      fallback: null,
    });
    const finished = parse(lines[lines.length - 1]);
    expect(finished.fields).toMatchObject({ run_status: "failed", error_kind: "validation", attempts: 2 });
    expectNoContent();
  });
});

// One logger ------------------------------------------------------------------------

describe("one logger", () => {
  // The rules eslint.config.mjs adds for src/lib; an error from one of them
  // means the route is closed.
  const LOGGER_RULES = new Set([
    "no-console",
    "no-restricted-globals",
    "no-restricted-properties",
    "no-restricted-imports",
    "no-restricted-syntax",
    "no-eval",
    "no-implied-eval",
    "no-new-func",
  ]);

  let eslint: ESLint;
  beforeAll(() => {
    eslint = new ESLint({ cwd: process.cwd() });
  });

  async function lint(code: string, filePath: string) {
    const [result] = await eslint.lintText(code, { filePath });
    expect(result.messages.filter((m) => m.fatal)).toEqual([]);
    return result.messages.filter((m) => m.severity === 2).map((m) => m.ruleId ?? "");
  }

  // Each writes to a console, a process stream or a file descriptor without
  // the logger. The first seven are the ones a review found open.
  const bypasses = [
    'globalThis.console.log("x");',
    'import { stderr } from "node:process";\nstderr.write("x");',
    'import proc from "node:process";\nproc.stdout.write("x");',
    'const p = process;\np.stdout.write("x");',
    'import { writeSync } from "node:fs";\nwriteSync(2, "x");',
    'process._rawDebug("x");',
    '// eslint-disable-next-line no-console\nconsole.log("x");',
    '/* eslint-disable */\nconsole.log("x");',
    'console.log("x");',
    'const c = console;\nc.log("x");',
    'const g = globalThis;\ng["console"].log("x");',
    'global.process.stdout.write("x");',
    'window.console.log("x");',
    'self.console.log("x");',
    'process.stdout.write("x");',
    'process["stderr"].write("x");',
    'const { stdout } = process;\nstdout.write("x");',
    'send(process);',
    'import fs from "fs";\nfs.appendFileSync("/dev/stderr", "x");',
    'import { open } from "node:fs/promises";\nawait open("/dev/stderr", "a");',
    'export { writeSync } from "node:fs";',
    'import { WriteStream } from "node:tty";\nnew WriteStream(2).write("x");',
    'import { Socket } from "node:net";\nnew Socket({ fd: 2 }).write("x");',
    'import { execSync } from "node:child_process";\nexecSync("echo x >&2");',
    'import { createRequire } from "node:module";\ncreateRequire("/")("fs").writeSync(2, "x");',
    'import { console as inspectorConsole } from "node:inspector";\ninspectorConsole.log("x");',
    'const fs = require("fs");\nfs.writeSync(2, "x");',
    'import fs = require("fs");\nfs.writeSync(2, "x");',
    'const name = "fs";\nawait import(name);',
    'const fs = await import("node:fs");\nfs.writeSync(2, "x");',
    'eval("console.log(1)");',
    'new Function("console.log(1)")();',
    'const F = Function;\nF("console.log(1)")();',
    'setTimeout("console.log(1)", 0);',
  ];

  it.each(bypasses)("closed in src/lib: %s", async (code) => {
    const errors = await lint(code, "src/lib/extraction/example.ts");
    expect(errors.some((rule) => LOGGER_RULES.has(rule)), errors.join(", ")).toBe(true);
  });

  it.each(["js", "mjs", "cjs", "ts", "mts", "cts", "tsx", "jsx"])("covers .%s files", async (extension) => {
    expect(await lint('console.log("x");\n', `src/lib/example.${extension}`)).toContain("no-console");
  });

  it("still allows reading configuration from process.env", async () => {
    const code =
      'export const key = process.env.ANTHROPIC_API_KEY ?? process.env["OPENAI_API_KEY"];\n' +
      "export const settings = { process: 1 };\n" +
      "export const named = settings.process;\n";
    expect(await lint(code, "src/lib/extraction/example.ts")).toEqual([]);
  });

  it("leaves the logger itself alone, and doesn't reach src/app yet", async () => {
    const code = 'console.log("x");\nprocess.stdout.write("x");\n';
    expect(await lint(code, "src/lib/log.ts")).toEqual([]);
    expect(await lint(code, "src/app/example.ts")).toEqual([]);
  });

  // The strict rules cover the server-side code only; the rest of src/lib may
  // hold browser helpers (the UI redesign's), which need window and may need
  // an inline disable, and still can't log around the logger.
  it("keeps browser helpers elsewhere in src/lib usable, but still without console", async () => {
    const browser = 'export const dark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;\n';
    expect(await lint(browser, "src/lib/theme.ts")).toEqual([]);
    expect(await lint(browser, "src/lib/extraction/theme.ts")).toContain("no-restricted-globals");
    expect(await lint('console.log("x");\n', "src/lib/theme.ts")).toContain("no-console");
    expect(await lint('process.stderr.write("x");\n', "src/lib/theme.ts")).toContain("no-restricted-properties");
    for (const file of ["src/lib/redact.ts", "src/lib/errors.ts"]) {
      expect(await lint("export const w = globalThis;\n", file)).toContain("no-restricted-globals");
    }
  });
});
