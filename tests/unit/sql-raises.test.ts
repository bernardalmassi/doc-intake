// The RAISE parser behind the error taxonomy's migration checks
// (tests/helpers/sql-raises.ts). It must read every form PL/pgSQL allows,
// credit each RAISE to the right function, count only a function's live
// definition, and throw on anything it can't read completely, because a
// RAISE it silently skipped would be a user-facing error with no code.

import { describe, expect, it } from "vitest";
import { parseMigrations, SqlParseError, type SqlRaise } from "../helpers/sql-raises";

// One migration holding one function whose body is `body`.
function inFunction(body: string, name = "f", header = "create or replace function public.") {
  return `${header}${name}(p uuid)\nreturns void language plpgsql as $$\nbegin\n  ${body}\nend;\n$$;\n`;
}

function raisesIn(sql: string): Pick<SqlRaise, "fn" | "level" | "sqlstate" | "message">[] {
  return parseMigrations([{ name: "001.sql", sql }]).all.map(({ fn, level, sqlstate, message }) => ({
    fn,
    level,
    sqlstate,
    message,
  }));
}

const one = (body: string) => raisesIn(inFunction(body));

describe("the RAISE forms", () => {
  it.each([
    ["an exception with an errcode", "raise exception 'no' using errcode = '42501';", "42501", "no"],
    ["no level", "raise 'no' using errcode = '42501';", "42501", "no"],
    ["no errcode", "raise exception 'it''s gone';", "P0001", "it's gone"],
    ["capitals and more options", "RAISE EXCEPTION 'no' USING ERRCODE = '55000', HINT = 'wait';", "55000", "no"],
    ["errcode with :=", "raise exception 'no' using errcode := '42501';", "42501", "no"],
    ["errcode as a condition name", "raise exception 'no' using errcode = 'insufficient_privilege';", "42501", "no"],
    ["SQLSTATE with a message", "raise sqlstate '42501' using message = 'no';", "42501", "no"],
    ["SQLSTATE alone", "raise sqlstate '22012';", "22012", "22012"],
    ["a condition name with a message", "raise insufficient_privilege using message = 'no';", "42501", "no"],
    ["a condition name alone", "raise unique_violation;", "23505", "unique_violation"],
    ["only options", "raise exception using message = 'no', errcode = '55000';", "55000", "no"],
    ["only an errcode", "raise using errcode = 'check_violation';", "23514", "check_violation"],
    [
      "format arguments holding commas, ; and USING in literals",
      "raise exception 'a % b %', format('%s, %s;', x, y), 'using' using errcode = '22023';",
      "22023",
      "a % b %",
    ],
    ["across lines", "raise exception\n    'a %', v\n    using errcode = '53400';", "53400", "a %"],
  ])("%s", (_label, body, sqlstate, message) => {
    expect(one(body)).toEqual([{ fn: "f", level: "exception", sqlstate, message }]);
  });

  it("records the level of a RAISE that doesn't abort", () => {
    expect(one("raise notice 'fyi %', v;")).toEqual([{ fn: "f", level: "notice", sqlstate: "P0001", message: "fyi %" }]);
  });

  it("skips a bare re-raise", () => {
    expect(one("raise;")).toEqual([]);
  });

  it("ignores raise in comments, strings and identifiers", () => {
    const body = [
      "-- raise exception 'in a line comment';",
      "/* raise exception 'in a block comment'; /* nested raise */ */",
      "perform 'raise exception ''in a string''';",
      'perform "raise";',
      "perform raise_exception_count;",
    ].join("\n  ");
    expect(one(body)).toEqual([]);
  });
});

describe("what it refuses to guess", () => {
  it.each([
    ["a message built by an expression", "raise exception using message = format('no %s', x);"],
    ["a format string that is an expression", "raise exception 'no ' || x;"],
    ["an errcode from a variable", "raise exception 'no' using errcode = v_code;"],
    ["an unknown condition name", "raise exception 'no' using errcode = 'no_such_condition';"],
    ["an unknown bare condition", "raise no_such_condition;"],
    ["a message given twice", "raise exception 'no' using message = 'also no';"],
    ["a SQLSTATE given twice", "raise unique_violation using errcode = '42501';"],
    ["a SQLSTATE of the wrong length", "raise sqlstate '4250';"],
    ["an escape string", "raise exception E'no\\n';"],
    ["an unknown option", "raise exception 'no' using severity = 'high';"],
    ["a level and nothing else", "raise exception;"],
    ["no terminating ;", "raise exception 'no'"],
  ])("%s", (_label, body) => {
    expect(() => one(body)).toThrow(SqlParseError);
  });

  it("names the file and line", () => {
    expect(() => one("raise exception using message = format('x');")).toThrow(/^001\.sql:4: /);
  });

  it("a RAISE outside any function or DO block", () => {
    expect(() => raisesIn("raise exception 'loose';")).toThrow(/outside any function/);
  });

  it("a function body that isn't dollar-quoted", () => {
    expect(() => raisesIn("create function f() returns void language plpgsql as 'begin raise exception ''x''; end';")).toThrow(
      /isn't dollar-quoted/,
    );
  });

  it("a function header it can't read", () => {
    expect(() => raisesIn('create function "Weird Name"() returns void language sql as $$ select 1 $$;')).toThrow(
      /header/,
    );
  });

  it("a function renamed by ALTER", () => {
    expect(() => raisesIn(inFunction("raise 'x';") + "alter function public.f(uuid) rename to g;")).toThrow(/renamed/);
  });
});

describe("which function a RAISE belongs to", () => {
  it("credits each RAISE to its own function, with or without OR REPLACE, whatever the dollar tag", () => {
    const sql = [
      inFunction("raise exception 'from a' using errcode = '42501';", "a", "create function private."),
      "create procedure b() language plpgsql as $body$\nbegin\n  raise exception 'from b';\nend;\n$body$;",
      inFunction("raise exception 'from c';", "c"),
    ].join("\n");
    expect(raisesIn(sql).map((r) => `${r.fn}: ${r.message}`)).toEqual(["a: from a", "b: from b", "c: from c"]);
  });

  it("marks a RAISE in a DO block as belonging to no function", () => {
    expect(raisesIn("do $$ begin raise exception 'precondition'; end $$;")).toEqual([
      { fn: null, level: "exception", sqlstate: "P0001", message: "precondition" },
    ]);
  });
});

describe("live definitions", () => {
  const define = (name: string, message: string) => inFunction(`raise exception '${message}';`, name);

  it("counts only the last definition of a function", () => {
    const parsed = parseMigrations([
      { name: "002.sql", sql: define("f", "new wording") },
      { name: "001.sql", sql: define("f", "old wording") + define("g", "untouched") },
    ]);
    expect(parsed.all.map((r) => r.message).sort()).toEqual(["new wording", "old wording", "untouched"]);
    expect(parsed.live.map((r) => r.message).sort()).toEqual(["new wording", "untouched"]);
  });

  it("drops a function's raises when a later migration drops it", () => {
    const parsed = parseMigrations([
      { name: "001.sql", sql: define("f", "gone") + define("g", "kept") },
      { name: "002.sql", sql: "drop function if exists public.f(uuid), other.h(text) cascade;" },
    ]);
    expect(parsed.live.map((r) => r.message)).toEqual(["kept"]);
  });

  it("a later definition in the same file wins, and a drop before it doesn't matter", () => {
    const sql = define("f", "first") + "drop function f(uuid);\n" + define("f", "second");
    expect(parseMigrations([{ name: "001.sql", sql }]).live.map((r) => r.message)).toEqual(["second"]);
  });

  it("keeps no DO block raises", () => {
    expect(parseMigrations([{ name: "001.sql", sql: "do $$ begin raise exception 'x'; end $$;" }]).live).toEqual([]);
  });
});
