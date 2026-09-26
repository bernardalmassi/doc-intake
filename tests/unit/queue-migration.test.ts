// The queue's migrations, read as text like model-prices.test.ts reads the
// price rows (docs/worker-design.md, sections 6 and 11):
//
//   - the claimed message's visibility timeout is the one config.ts mirrors
//   - every net.http_post passes its own timeout (pg_net's default is 2 s,
//     and the wake's bound is chosen: 5 s)
//   - Vault is only read, and only the two worker secrets, by name: no
//     migration creates, changes or holds a secret
//   - no migration contains a URL but the pricing sources: the worker's URL
//     lives only in the app project's Vault, so the test project, which runs
//     every migration, can never be pointed at production
//   - the live check_extraction_limits reads each ceiling's ledger sum and
//     in-flight sum in one statement, one snapshot (20260925000004; the
//     two-session case in supabase/tests/sessions races one against a finish)
//   - the live claim locks a run's document and the run before it reads the
//     run's message, and skips at most 5 runs it can't lock (the two-session
//     claim case exercises it)
//
// Needs no database.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EXTRACTION_LIMITS, PRICING } from "@/lib/extraction/config";
import { parseMigrations } from "../helpers/sql-raises";

const dir = fileURLToPath(new URL("../../supabase/migrations/", import.meta.url));
const migrations = readdirSync(dir)
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => ({ name, sql: readFileSync(join(dir, name), "utf8") }));
const all = migrations.map((m) => m.sql).join("\n");

// The balanced argument list that starts at `open` (an opening paren).
function argumentsAt(sql: string, open: number): string {
  let depth = 0;
  for (let i = open; i < sql.length; i++) {
    if (sql[i] === "(") depth += 1;
    else if (sql[i] === ")" && --depth === 0) return sql.slice(open + 1, i);
  }
  throw new Error("unbalanced parentheses after net.http_post");
}

describe("the queue's migrations", () => {
  it("set the visibility timeout config.ts mirrors, and never change it later", () => {
    const settings = [...all.matchAll(/worker_visibility_seconds\s+(?:integer\s+not null\s+default\s+|=\s*)(\d+)/gi)];
    expect(settings.length).toBeGreaterThan(0);
    expect(Number(settings.at(-1)![1])).toBe(EXTRACTION_LIMITS.workerVisibilitySeconds);
    for (const setting of settings) expect(Number(setting[1])).toBe(EXTRACTION_LIMITS.workerVisibilitySeconds);
  });

  it("pass an explicit timeout to every net.http_post", () => {
    const calls = migrations.flatMap(({ name, sql }) =>
      [...sql.matchAll(/net\.http_post\s*\(/gi)].map((match) => ({ name, args: argumentsAt(sql, match.index + match[0].length - 1) })),
    );
    expect(calls.length).toBeGreaterThan(0);
    for (const { name, args } of calls) {
      expect(args, name).toMatch(/\btimeout_milliseconds\s*:=\s*\d+/);
    }
  });

  it("only read Vault, and only the two worker secrets, by name", () => {
    const references = [...all.matchAll(/\bvault\.(\w+)/gi)];
    expect(references.length).toBe(2);
    for (const reference of references) expect(reference[1]).toBe("decrypted_secrets");
    const names = [...all.matchAll(/vault\.decrypted_secrets\s+s\s+where\s+s\.name\s*=\s*'([^']+)'/gi)].map((m) => m[1]);
    expect(names.sort()).toEqual(["extraction_worker_secret", "extraction_worker_url"]);
    expect(all).not.toMatch(/create_secret|update_secret|insert\s+into\s+vault|decrypted_secret\s*=/i);
  });

  it("contain no URL but the pricing sources", () => {
    const pricingHosts = new Set(Object.values(PRICING).map((price) => new URL(price.source).host));
    for (const { name, sql } of migrations) {
      for (const match of sql.matchAll(/https?:\/\/([A-Za-z0-9][A-Za-z0-9.-]*)/g)) {
        expect(pricingHosts.has(match[1]), `${name}: ${match[0]}`).toBe(true);
      }
    }
    // the wake accepts only an https URL ending in the worker's path, read
    // from Vault
    expect(all).toContain("'^https://[^/]+/api/extraction-worker$'");
  });
});

describe("the live ceiling check", () => {
  const body = parseMigrations(migrations).liveBodies.get("check_extraction_limits") ?? "";
  // its statements, split at the semicolons that end them
  const statements = body.split(";").map((statement) => statement.replace(/\s+/g, " ").trim());

  it("reads the ledger and the runs in flight in the same statement, once per ceiling", () => {
    const ledger = statements.filter((statement) => statement.includes("private.extraction_spend"));
    expect(ledger).toHaveLength(2);
    for (const statement of ledger) {
      expect(statement).toMatch(/^select \(select coalesce\(sum\(s\.cost_usd\), 0\)/);
      expect(statement).toContain("private.abandoned_estimate(r.page_count)");
      expect(statement).toContain("r.status in ('queued', 'running')");
      expect(statement).toMatch(/into v_total$/);
    }
    // nothing else sums the runs in flight on its own
    expect(statements.filter((statement) => statement.includes("abandoned_estimate"))).toEqual(ledger);
  });
});

describe("the live claim", () => {
  const body = parseMigrations(migrations).liveBodies.get("claim_extraction_run") ?? "";

  it("locks the document and the run, without waiting, before it reads their message", () => {
    const lock = body.indexOf("private.lock_extraction_run(v_candidate.run_id, true)");
    const read = body.indexOf("pgmq.read(");
    expect(lock).toBeGreaterThan(0);
    expect(read).toBeGreaterThan(lock);
    // the message read is the candidate's own
    expect(body).toContain("jsonb_build_object('run_id', v_candidate.run_id)");
  });

  it("skips a run it can't lock and tries the next, at most 5 times", () => {
    expect(body).toMatch(/exception when lock_not_available then[\s\S]*?v_skipped := v_skipped \|\| v_candidate\.msg_id;[\s\S]*?cardinality\(v_skipped\) >= 5/);
    expect(body).toContain("q.msg_id <> all (v_skipped)");
  });
});
