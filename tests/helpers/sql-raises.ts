// Every RAISE in the migrations, with the function it belongs to, its level,
// SQLSTATE and message, for the error taxonomy's drift tests
// (tests/unit/errors.test.ts): each user-facing error the database can
// raise must have a code.
//
// Strict on purpose. A RAISE it can't read completely throws a
// SqlParseError naming the file and line: a message or errcode built from
// an expression, an unknown condition name, an option given twice, a
// function body that isn't dollar-quoted, a RAISE outside any body, or a
// function renamed by ALTER. A form nobody taught it about must fail the
// test, not slip past the check.
//
// It reads all of PL/pgSQL's RAISE forms:
//
//   RAISE [level] 'format' [, expr ...] [USING option = expr [, ...]];
//   RAISE [level] condition_name [USING ...];
//   RAISE [level] SQLSTATE 'xxxxx' [USING ...];
//   RAISE [level] USING option = expr [, ...];
//   RAISE;                                       (re-raise: skipped)
//
// with = or := in options, and ERRCODE as a SQLSTATE or a condition name.
// The level defaults to EXCEPTION, the SQLSTATE to P0001; with no message,
// Postgres reports the condition name or SQLSTATE, and so does this.
//
// A function redefined by a later migration counts only in its last
// definition, and not at all after a DROP, so a phrase deleted from the
// live function can't pass on an older body. Functions are keyed by name
// without schema (ALTER ... SET SCHEMA keeps the name) and by their
// argument types, so overloads are separate definitions: a DROP with an
// argument list removes that overload, one without removes them all.
// Parameter names, modes and defaults are ignored; a type the parser can't
// normalize fails the parse.
//
// A plain module, not a test file: Vitest doesn't collect it.

export type RaiseLevel = "debug" | "log" | "info" | "notice" | "warning" | "exception";

export type SqlRaise = {
  file: string;
  line: number;
  // the function or procedure it is in; null in a DO block, which runs once
  // when the migration is applied, as the migration's role
  fn: string | null;
  level: RaiseLevel;
  sqlstate: string;
  // as written: the format string (% placeholders unexpanded) or the
  // MESSAGE option; without either, the condition name or SQLSTATE
  message: string;
};

export type SqlFile = { name: string; sql: string };

export type ParsedMigrations = {
  // every RAISE in every file, re-raises excepted
  all: SqlRaise[];
  // those in the definition of each function that is in force after the
  // last migration
  live: SqlRaise[];
  // that definition's body, comments blanked, by function name; with
  // overloads, every live overload's body, in the order they were defined
  liveBodies: Map<string, string>;
};

export class SqlParseError extends Error {
  constructor(file: string, sql: string, offset: number, problem: string) {
    const line = lineAt(sql, offset);
    const text = sql.split("\n")[line - 1]?.trim() ?? "";
    super(`${file}:${line}: ${problem}: ${text}`);
    this.name = "SqlParseError";
  }
}

const LEVELS = new Set<RaiseLevel>(["debug", "log", "info", "notice", "warning", "exception"]);

// USING options PL/pgSQL accepts
const OPTIONS = new Set(["message", "detail", "hint", "errcode", "column", "constraint", "datatype", "table", "schema"]);

// Condition names a RAISE or ERRCODE may use instead of a SQLSTATE: the ones
// this repo's errors and its taxonomy deal in, and their near neighbours
// (Postgres manual, Appendix A). Any other name fails the parse.
export const CONDITION_SQLSTATES: Record<string, string> = {
  raise_exception: "P0001",
  no_data_found: "P0002",
  too_many_rows: "P0003",
  assert_failure: "P0004",
  insufficient_privilege: "42501",
  undefined_object: "42704",
  undefined_function: "42883",
  duplicate_object: "42710",
  feature_not_supported: "0A000",
  invalid_authorization_specification: "28000",
  data_exception: "22000",
  string_data_right_truncation: "22001",
  numeric_value_out_of_range: "22003",
  invalid_parameter_value: "22023",
  invalid_text_representation: "22P02",
  integrity_constraint_violation: "23000",
  restrict_violation: "23001",
  not_null_violation: "23502",
  foreign_key_violation: "23503",
  unique_violation: "23505",
  check_violation: "23514",
  exclusion_violation: "23P01",
  serialization_failure: "40001",
  deadlock_detected: "40P01",
  insufficient_resources: "53000",
  configuration_limit_exceeded: "53400",
  program_limit_exceeded: "54000",
  object_not_in_prerequisite_state: "55000",
  object_in_use: "55006",
  lock_not_available: "55P03",
  query_canceled: "57014",
};

const SQLSTATE = /^[0-9A-Z]{5}$/;

export function parseMigrations(files: SqlFile[]): ParsedMigrations {
  const all: SqlRaise[] = [];
  // keyed by name and argument types: "f(uuid,integer)"
  const live = new Map<string, { name: string; raises: SqlRaise[]; body: string }>();
  for (const file of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    const parsed = parseFile(file);
    all.push(...parsed.raises);
    for (const event of parsed.events) {
      if (event.kind === "define") {
        const key = `${event.name}(${event.types})`;
        // a redefinition replaces the overload in place, keeping its order
        live.delete(key);
        live.set(key, { name: event.name, raises: event.raises, body: event.body });
      } else {
        for (const [key, definition] of [...live]) {
          if (definition.name === event.name && (event.types === null || key === `${event.name}(${event.types})`)) {
            live.delete(key);
          }
        }
      }
    }
  }
  const liveBodies = new Map<string, string>();
  for (const definition of live.values()) {
    const earlier = liveBodies.get(definition.name);
    liveBodies.set(definition.name, earlier === undefined ? definition.body : `${earlier}\n${definition.body}`);
  }
  return {
    all,
    live: [...live.values()].flatMap((definition) => definition.raises),
    liveBodies,
  };
}

// One file ------------------------------------------------------------------

type Literal = { start: number; end: number; value: string; escaped: boolean };
type Range = { start: number; end: number };
type Body = Range & { fn: string | null; types: string };
type FileEvent =
  | { kind: "define"; name: string; types: string; offset: number; raises: SqlRaise[]; body: string }
  // types null: every overload of the name
  | { kind: "drop"; name: string; types: string | null; offset: number };

function parseFile({ name: file, sql }: SqlFile): { raises: SqlRaise[]; events: FileEvent[] } {
  const scanned = scan(file, sql);
  const { code } = scanned;
  const fail = (offset: number, problem: string): never => {
    throw new SqlParseError(file, sql, offset, problem);
  };
  const inCode = (offset: number) => !scanned.quoted.some((r) => offset >= r.start && offset < r.end);

  const bodies: Body[] = [];
  const events: FileEvent[] = [];

  // CREATE FUNCTION / PROCEDURE, with or without OR REPLACE. A header this
  // pattern doesn't recognize (a quoted name, say) is caught by the count.
  const loose = [...code.matchAll(/\bcreate\s+(?:or\s+replace\s+)?(?:function|procedure)\b/gi)].filter((m) => inCode(m.index));
  const creates = [
    ...code.matchAll(/\bcreate\s+(?:or\s+replace\s+)?(?:function|procedure)\s+(?:[A-Za-z_][\w$]*\s*\.\s*)?([A-Za-z_][\w$]*)\s*\(/gi),
  ].filter((m) => inCode(m.index));
  if (loose.length !== creates.length) {
    const unread = loose.find((l) => !creates.some((c) => c.index === l.index));
    fail(unread?.index ?? 0, "a function header this parser can't read");
  }
  for (const create of creates) {
    const open = create.index + create[0].length - 1;
    const close = matchingParen(code, open);
    if (close === null) fail(create.index, "a function header whose argument list doesn't close");
    const types = argumentTypes(code.slice(open + 1, close ?? open), true);
    if (types === null) fail(create.index, "a function argument list this parser can't read");
    const body = dollarBody(code, create.index + create[0].length, inCode);
    if (!body) fail(create.index, "a function body that isn't dollar-quoted after AS");
    else bodies.push({ ...body, fn: create[1].toLowerCase(), types: types ?? "" });
  }

  for (const block of code.matchAll(/\bdo\s+(?:language\s+\w+\s+)?(?=\$)/gi)) {
    if (!inCode(block.index)) continue;
    const body = dollarBody(code, block.index + block[0].length, inCode, false);
    if (!body) fail(block.index, "a DO block this parser can't read");
    else bodies.push({ ...body, fn: null, types: "" });
  }

  for (const alter of code.matchAll(/\balter\s+(?:function|procedure)\b[^;]*\brename\s+to\b/gi)) {
    if (inCode(alter.index)) fail(alter.index, "a function renamed by ALTER, which this parser doesn't follow");
  }

  for (const drop of code.matchAll(/\bdrop\s+(?:function|procedure)\s+(?:if\s+exists\s+)?([^;]*);/gi)) {
    if (!inCode(drop.index)) continue;
    for (const part of splitTopLevel(drop[1])) {
      const match = /^(?:[\w$]+\s*\.\s*)?([A-Za-z_][\w$]*)\s*(?:\(([\s\S]*)\))?(?:\s+(?:cascade|restrict))?$/i.exec(part.trim());
      const types = match?.[2] === undefined ? null : argumentTypes(match[2], false);
      if (!match || (match[2] !== undefined && types === null)) fail(drop.index, "a DROP FUNCTION this parser can't read");
      else events.push({ kind: "drop", name: match[1].toLowerCase(), types, offset: drop.index });
    }
  }

  const found: { raise: SqlRaise; offset: number }[] = [];
  for (const keyword of code.matchAll(/\braise\b/gi)) {
    if (!inCode(keyword.index)) continue;
    const body = bodies.find((b) => keyword.index >= b.start && keyword.index < b.end);
    if (!body) fail(keyword.index, "a RAISE outside any function or DO block");
    const raise = parseRaise(file, sql, scanned, keyword.index, fail);
    if (raise) found.push({ raise: { ...raise, fn: body?.fn ?? null }, offset: keyword.index });
  }

  for (const body of bodies) {
    if (body.fn === null) continue;
    const inside = found.filter((f) => f.offset >= body.start && f.offset < body.end).map((f) => f.raise);
    events.push({ kind: "define", name: body.fn, types: body.types, offset: body.start, raises: inside, body: code.slice(body.start, body.end) });
  }
  events.sort((a, b) => a.offset - b.offset);
  return { raises: found.map((f) => f.raise), events };
}

// The dollar-quoted body that starts at the first $tag$ after `from`,
// preceded by AS when it's a function. Null when the next thing that
// matters is a ; or there is no closing tag.
function dollarBody(code: string, from: number, inCode: (offset: number) => boolean, needsAs = true): Range | null {
  const pattern = /\$(?:[A-Za-z_]\w*)?\$/g;
  pattern.lastIndex = from;
  for (let open = pattern.exec(code); open; open = pattern.exec(code)) {
    if (!inCode(open.index)) continue;
    const between = code.slice(from, open.index);
    const semicolon = [...between.matchAll(/;/g)].some((m) => inCode(from + m.index));
    if (semicolon) return null;
    if (needsAs && !/\bas\s*$/i.test(between)) continue;
    const close = code.indexOf(open[0], open.index + open[0].length);
    if (close < 0) return null;
    return { start: open.index + open[0].length, end: close };
  }
  return null;
}

// Comments and quoting --------------------------------------------------------

type Scanned = {
  // the SQL with every comment blanked to spaces, so offsets and lines match
  code: string;
  // single-quoted literals, by start offset (the E of an E'' string)
  literals: Map<number, Literal>;
  // literals and quoted identifiers: text that is never a keyword
  quoted: Range[];
};

// Dollar quotes are left as code: in migrations they delimit function and
// DO bodies, whose RAISEs are the point.
function scan(file: string, sql: string): Scanned {
  const out = sql.split("");
  const literals = new Map<number, Literal>();
  const quoted: Range[] = [];
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k += 1) if (out[k] !== "\n") out[k] = " ";
  };

  let i = 0;
  while (i < sql.length) {
    if (sql.startsWith("--", i)) {
      const newline = sql.indexOf("\n", i);
      const end = newline < 0 ? sql.length : newline;
      blank(i, end);
      i = end;
    } else if (sql.startsWith("/*", i)) {
      // Postgres block comments nest
      let depth = 0;
      let k = i;
      while (k < sql.length) {
        if (sql.startsWith("/*", k)) {
          depth += 1;
          k += 2;
        } else if (sql.startsWith("*/", k)) {
          depth -= 1;
          k += 2;
          if (depth === 0) break;
        } else k += 1;
      }
      if (depth !== 0) throw new SqlParseError(file, sql, i, "an unterminated block comment");
      blank(i, k);
      i = k;
    } else if (sql[i] === "'") {
      const escaped = i > 0 && /[eE]/.test(sql[i - 1]) && !(i > 1 && /[\w$]/.test(sql[i - 2]));
      let k = i + 1;
      let value = "";
      for (;;) {
        if (k >= sql.length) throw new SqlParseError(file, sql, i, "an unterminated string");
        if (escaped && sql[k] === "\\") {
          value += sql[k + 1] ?? "";
          k += 2;
        } else if (sql[k] === "'" && sql[k + 1] === "'") {
          value += "'";
          k += 2;
        } else if (sql[k] === "'") {
          k += 1;
          break;
        } else {
          value += sql[k];
          k += 1;
        }
      }
      const start = escaped ? i - 1 : i;
      literals.set(start, { start, end: k, value, escaped });
      quoted.push({ start, end: k });
      i = k;
    } else if (sql[i] === '"') {
      let k = i + 1;
      while (k < sql.length && !(sql[k] === '"' && sql[k + 1] !== '"')) k += sql[k] === '"' ? 2 : 1;
      quoted.push({ start: i, end: k + 1 });
      i = k + 1;
    } else i += 1;
  }
  return { code: out.join(""), literals, quoted };
}

// One RAISE -------------------------------------------------------------------

type Token =
  | { kind: "word"; text: string; start: number; end: number }
  | { kind: "string"; literal: Literal; start: number; end: number }
  | { kind: "punct"; text: string; start: number; end: number }
  | { kind: "eof"; start: number; end: number };

function tokenAt(scanned: Scanned, from: number): Token {
  const { code } = scanned;
  let i = from;
  while (i < code.length && /\s/.test(code[i])) i += 1;
  if (i >= code.length) return { kind: "eof", start: i, end: i };
  const literal = scanned.literals.get(i);
  if (literal) return { kind: "string", literal, start: i, end: literal.end };
  const word = /[A-Za-z_][\w$]*/y;
  word.lastIndex = i;
  const w = word.exec(code);
  if (w) return { kind: "word", text: w[0].toLowerCase(), start: i, end: i + w[0].length };
  if (code.startsWith(":=", i)) return { kind: "punct", text: ":=", start: i, end: i + 2 };
  return { kind: "punct", text: code[i], start: i, end: i + 1 };
}

const isPunct = (t: Token, text: string) => t.kind === "punct" && t.text === text;
const isWord = (t: Token, text: string) => t.kind === "word" && t.text === text;

function parseRaise(
  file: string,
  sql: string,
  scanned: Scanned,
  at: number,
  fail: (offset: number, problem: string) => never,
): Omit<SqlRaise, "fn"> | null {
  let pos = at + "raise".length;
  const peek = () => tokenAt(scanned, pos);
  const next = () => {
    const token = peek();
    pos = token.end;
    return token;
  };

  // An expression, up to a , or ; (or, for format arguments, USING) at
  // depth 0. Returns its tokens.
  const expression = (stopAtUsing: boolean): Token[] => {
    const tokens: Token[] = [];
    let depth = 0;
    for (;;) {
      const token = peek();
      if (token.kind === "eof") fail(at, "a RAISE with no terminating ;");
      if (depth === 0 && (isPunct(token, ",") || isPunct(token, ";") || (stopAtUsing && isWord(token, "using")))) {
        return tokens;
      }
      if (isPunct(token, "(")) depth += 1;
      if (isPunct(token, ")")) depth -= 1;
      tokens.push(next());
    }
  };
  // A MESSAGE or ERRCODE must be one plain literal for its text to be known.
  const literalOf = (tokens: Token[], what: string): string => {
    const only = tokens.length === 1 ? tokens[0] : undefined;
    if (!only || only.kind !== "string" || only.literal.escaped) fail(at, `a RAISE whose ${what} isn't a single plain string literal`);
    return (only as Extract<Token, { kind: "string" }>).literal.value;
  };
  const sqlstateOf = (text: string): string => {
    if (SQLSTATE.test(text)) return text;
    const mapped = CONDITION_SQLSTATES[text.toLowerCase()];
    if (!mapped) fail(at, `a RAISE with an unknown condition name "${text}" (add it to CONDITION_SQLSTATES)`);
    return mapped;
  };

  let token = peek();
  if (isPunct(token, ";")) return null;

  let level: RaiseLevel = "exception";
  if (token.kind === "word" && LEVELS.has(token.text as RaiseLevel)) {
    level = token.text as RaiseLevel;
    next();
    token = peek();
  }

  let message: string | undefined;
  let sqlstate: string | undefined;
  // what Postgres reports as the message when none is given
  let fallbackMessage: string | undefined;

  if (token.kind === "string") {
    next();
    message = literalOf([token], "format string");
    while (isPunct(peek(), ",")) {
      next();
      expression(true);
    }
  } else if (isWord(token, "sqlstate")) {
    next();
    const state = literalOf([next()], "SQLSTATE");
    if (!SQLSTATE.test(state)) fail(at, "a RAISE SQLSTATE that isn't five characters");
    sqlstate = state;
    fallbackMessage = state;
  } else if (token.kind === "word" && token.text !== "using") {
    next();
    sqlstate = sqlstateOf(token.text);
    fallbackMessage = token.text;
  }

  if (isWord(peek(), "using")) {
    next();
    for (;;) {
      const option = next();
      if (option.kind !== "word" || !OPTIONS.has(option.text)) fail(at, "a RAISE with an unknown USING option");
      const assign = next();
      if (!isPunct(assign, "=") && !isPunct(assign, ":=")) fail(at, "a RAISE option without = or :=");
      const value = expression(false);
      if (isWord(option, "message")) {
        if (message !== undefined) fail(at, "a RAISE that gives its message twice");
        message = literalOf(value, "MESSAGE");
      } else if (isWord(option, "errcode")) {
        if (sqlstate !== undefined) fail(at, "a RAISE that gives its SQLSTATE twice");
        const text = literalOf(value, "ERRCODE");
        sqlstate = sqlstateOf(text);
        fallbackMessage = text;
      }
      if (!isPunct(peek(), ",")) break;
      next();
    }
  }

  if (!isPunct(peek(), ";")) fail(at, "a RAISE this parser can't read to its ;");
  if (message === undefined && sqlstate === undefined) fail(at, "a RAISE with a level but no message or condition");
  return {
    file,
    line: lineAt(sql, at),
    level,
    sqlstate: sqlstate ?? "P0001",
    message: message ?? fallbackMessage ?? sqlstate ?? "P0001",
  };
}

// Offsets and lines -----------------------------------------------------------

function lineAt(sql: string, offset: number): number {
  let line = 1;
  for (let k = 0; k < offset && k < sql.length; k += 1) if (sql[k] === "\n") line += 1;
  return line;
}

// Arguments ----------------------------------------------------------------

// The index of the ")" matching the "(" at `open`, or null.
function matchingParen(code: string, open: number): number | null {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "(") depth++;
    else if (code[i] === ")" && --depth === 0) return i;
  }
  return null;
}

// Splits on commas outside parentheses: "a numeric(12, 8), b" -> two parts.
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") depth--;
    else if (text[i] === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

// Types that are more than one word, and the aliases Postgres treats as one
// type, so f(p_n int) and drop function f(integer) name the same overload.
const MULTIWORD_TYPES = /^(double\s+precision|character\s+varying|timestamp\s+with(?:out)?\s+time\s+zone|time\s+with(?:out)?\s+time\s+zone)\b/i;
const TYPE_ALIASES: Record<string, string> = {
  int: "integer",
  int4: "integer",
  int8: "bigint",
  int2: "smallint",
  bool: "boolean",
  float8: "double precision",
  float4: "real",
  varchar: "character varying",
  "timestamp with time zone": "timestamptz",
};

// "p_document_id uuid, p_page_count integer default null" -> "uuid,integer".
// `named`: a CREATE's list, whose parameters normally carry names; a DROP's
// usually doesn't. Null when a parameter isn't a shape this reads.
function argumentTypes(list: string, named: boolean): string | null {
  const types: string[] = [];
  for (const raw of splitTopLevel(list)) {
    let param = raw.replace(/\s+(?:default\b|=)[\s\S]*$/i, "").trim();
    param = param.replace(/^(?:in|out|inout|variadic)\s+/i, "");
    let type: string;
    const multi = MULTIWORD_TYPES.exec(param);
    if (multi) {
      type = param;
    } else {
      const words = param.split(/\s+/);
      if (words.length === 1) type = words[0];
      else if (words.length === 2 && (named || !MULTIWORD_TYPES.test(param))) type = words[1];
      else return null;
    }
    const normal = type.toLowerCase().replace(/\s+/g, " ").replace(/\s*\(\s*/g, "(").replace(/\s*,\s*/g, ",").replace(/\s*\)/g, ")");
    if (!/^[a-z_][\w.]*(?: [a-z]+)*(?:\(\d+(?:,\d+)?\))?(?:\[\])?$/.test(normal)) return null;
    types.push(TYPE_ALIASES[normal] ?? normal);
  }
  return types.join(",");
}
