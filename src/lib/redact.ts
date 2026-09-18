// Scrubbing for text that leaves the process: every log line (src/lib/log.ts)
// and the error text stored in extraction_runs.error, which tenant members
// can read (describeError in extraction/providers/types.ts). One module, so
// both follow the same rules.
//
// This is the second line of defence. The first is the logger's allowlist:
// a log line can only hold ids, enum values, counts and codes, so a key, a
// signed URL or an extracted value has nowhere to go. This module catches
// what an allowlisted format can't rule out, and scrubs the free text of
// stored errors.
//
// What it removes:
//   - Registered secrets. registerSecret(value) is called where a secret is
//     read (the provider API keys, in extraction/providers/select.ts) or
//     handed out (a run's close token, once src/app registers it). Any 12
//     character slice of a registered value is a hit, so a truncated copy is
//     caught as well as the whole value, and so is a copy broken up by
//     whitespace or invisible characters.
//   - Credential shapes, registered or not: Anthropic and OpenAI keys
//     (sk-ant-..., sk-proj-..., sk-...), Supabase keys (sb_secret_...,
//     sb_publishable_...), JWTs (eyJ...: Supabase's legacy anon and
//     service_role keys, and every session access token), Bearer and Basic
//     credentials, key=value and "key": "value" pairs whose key names a
//     credential, and any run of 40 or more token characters without a
//     slash (a key format not listed here, or base64 document bytes).
//   - The query string, fragment and userinfo of every URL (a Supabase
//     signed URL carries its token in ?token=), and data: URLs (the OpenAI
//     provider sends the document as one).
//
// A close token is a UUID, which no shape rule can tell apart from a run or
// document id, so it is only caught once registered.
//
// Not a goal: stopping a developer who deliberately encodes a secret
// (base64, reversed, one character per line). That is for code review; this
// is for accidents and for hostile content.

export const REDACTED = "[redacted]";

// Nothing we hold is shorter; matching shorter values would mangle ordinary
// text (and the timestamp of every log line).
const MIN_SECRET_LENGTH = 12;
const SLICE_LENGTH = 12;

// Longer input is cut before scrubbing so the regexes stay cheap. Callers
// cap their own output far below this.
const MAX_INPUT_LENGTH = 20_000;

// full value -> number of live registrations
const secrets = new Map<string, number>();
// every SLICE_LENGTH-long slice of every registered value -> registrations
const slices = new Map<string, number>();

// Registers a value that must never appear in a log line or stored error.
// Returns a function that releases this registration (for per-request
// secrets such as a close token); process-lifetime secrets such as API keys
// simply never call it. Values shorter than 12 characters are ignored.
export function registerSecret(value: string): () => void {
  if (typeof value !== "string" || value.length < MIN_SECRET_LENGTH) return () => {};
  const own = slicesOf(value);
  increment(secrets, value);
  for (const slice of own) increment(slices, slice);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    decrement(secrets, value);
    for (const slice of own) decrement(slices, slice);
  };
}

type Rule = {
  pattern: RegExp;
  replacement: string | ((match: string) => string);
  // what counts as still present after replacement; defaults to pattern
  detect?: RegExp;
};

// Order matters: URLs before the key=value rule (so a whole query string
// goes, not just one parameter), Bearer before key=value (so
// "Authorization: Bearer x" loses x, not the word Bearer), specific shapes
// before the generic long-token rule. Every open-ended quantifier either
// follows a literal or consumes what it matched, and the detectors are
// bounded, so none of these goes quadratic on a long input.
const RULES: Rule[] = [
  // data: URLs: the document itself, base64 encoded
  {
    pattern: /data:[^\s,]{0,100},[^\s"'<>`]*/gi,
    replacement: `data:${REDACTED}`,
    detect: /data:(?!\[redacted\])[^\s,]{0,100},/i,
  },
  // any URL: keep scheme, host and path; drop userinfo, query and fragment
  {
    pattern: /[a-z][a-z0-9+.-]{0,15}:\/\/[^\s"'<>`]*/gi,
    replacement: scrubUrl,
    detect: /[a-z][a-z0-9+.-]{0,15}:\/\/(?:[^\s"'<>`?#]{0,2048}[?#](?!\[redacted\])|(?!\[redacted\]@)[^\s"'<>`/?#@]{0,256}@)/i,
  },
  // Authorization header values
  { pattern: /(bearer|basic)(\s{1,8})[A-Za-z0-9._~+/=-]{8,}/gi, replacement: `$1$2${REDACTED}` },
  // key=value, key: value and "key": "value" where the key names a credential
  {
    pattern:
      /(api[_-]?key|x-api-key|authorization|password|passwd|secret|access[_-]?token|refresh[_-]?token|id[_-]?token|close[_-]?token|token)(["']?\s{0,8}[:=]\s{0,8}["']?)[^\s"'`&,;{}()<>[\]]+/gi,
    replacement: `$1$2${REDACTED}`,
  },
  // Anthropic (sk-ant-...) and OpenAI (sk-..., sk-proj-..., sk-svcacct-...)
  // keys. Not anchored on a word boundary, so a key glued to other text is
  // still caught (at the cost of redacting the odd "task-..." in an error).
  { pattern: /sk-[A-Za-z0-9_-]{8,}/g, replacement: REDACTED },
  // the key-... shape the previous describeError scrubbed; anchored, since
  // "monkey-..." is not a key
  { pattern: /\bkey-[A-Za-z0-9_-]{8,}/g, replacement: REDACTED },
  // Supabase API keys
  { pattern: /sb_(?:secret|publishable)_[A-Za-z0-9_-]{8,}/g, replacement: REDACTED },
  // JWTs: base64url of '{"' is always eyJ
  { pattern: /eyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*){0,2}/g, replacement: REDACTED },
  // anything long and opaque: a key format not listed above, or document
  // bytes. A UUID (36) is shorter. The slash is left out so a URL path or a
  // storage path (<tenant_id>/<id>) stays readable; no key we hold has one.
  { pattern: /[A-Za-z0-9_+=-]{40,}/g, replacement: REDACTED },
];

// Characters that render as nothing. Deleted before matching, so they can't
// split a key past the rules.
const INVISIBLE =
  /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0]/g;
// Control characters other than tab and newlines become spaces: they have
// no business in stored text, and Postgres text can't hold NUL at all.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
// Runs of characters a key can be glued into; a run holding any slice of a
// registered secret is replaced whole.
const TOKEN_RUN = /[^\s"'`<>()[\]{},;|]+/g;
// One character any key or token format here can contain.
const TOKEN_CHAR = /^[A-Za-z0-9_+/=.~-]$/;

// Scrubs free text. The result contains no registered secret (nor any 12
// character slice of one), and nothing any rule above detects; if the
// rules leave anything behind, the whole text becomes [redacted].
export function redact(input: string): string {
  let text = typeof input === "string" ? input : String(input);
  if (text.length > MAX_INPUT_LENGTH) {
    // drop the partial token at the cut, which could be the head of a key
    let end = MAX_INPUT_LENGTH;
    while (end > 0 && TOKEN_CHAR.test(text[end - 1])) end -= 1;
    text = `${text.slice(0, end)} [truncated]`;
  }
  text = text.replace(INVISIBLE, "").replace(CONTROL, " ");

  if (secrets.size > 0) {
    // whole values first (they may contain delimiters), longest first
    for (const secret of [...secrets.keys()].sort((a, b) => b.length - a.length)) {
      text = text.split(secret).join(REDACTED);
    }
    text = text.replace(TOKEN_RUN, (run) => (hasRegisteredSlice(run) ? REDACTED : run));
  }

  for (const rule of RULES) {
    text =
      typeof rule.replacement === "string"
        ? text.replace(rule.pattern, rule.replacement)
        : text.replace(rule.pattern, rule.replacement);
  }

  return containsSecret(text) ? REDACTED : text;
}

// True if the text holds a registered secret or a slice of one (also with
// whitespace and invisible characters removed), or anything a rule detects.
// The logger runs this over every finished line.
export function containsSecret(text: string): boolean {
  const visible = text.replace(INVISIBLE, "");
  if (hasRegisteredSlice(visible) || hasRegisteredSlice(visible.replace(/\s+/g, ""))) return true;
  // search() ignores and restores lastIndex, so the global patterns are safe here
  return RULES.some((rule) => visible.search(rule.detect ?? rule.pattern) !== -1);
}

function scrubUrl(url: string): string {
  const cut = url.search(/[?#]/);
  const base = (cut === -1 ? url : url.slice(0, cut)).replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/]*@/i, `$1${REDACTED}@`);
  return cut === -1 ? base : `${base}?${REDACTED}`;
}

function hasRegisteredSlice(text: string): boolean {
  if (slices.size === 0) return false;
  for (let i = 0; i + SLICE_LENGTH <= text.length; i++) {
    if (slices.has(text.slice(i, i + SLICE_LENGTH))) return true;
  }
  return false;
}

function slicesOf(value: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + SLICE_LENGTH <= value.length; i++) out.push(value.slice(i, i + SLICE_LENGTH));
  return out;
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function decrement(map: Map<string, number>, key: string): void {
  const count = map.get(key) ?? 0;
  if (count <= 1) map.delete(key);
  else map.set(key, count - 1);
}
