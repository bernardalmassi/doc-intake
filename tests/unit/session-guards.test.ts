// The guards around the two-session tests (supabase/tests/sessions), which
// commit fixtures and pause pg_cron's extraction-sweep job, read as text:
// sweep-pause.sql refuses a project whose Vault holds the worker's URL
// before it pauses anything, and scripts/test-db.mjs proves that refusal
// (the guard run against a pair made inside a rolled-back transaction)
// before every pause, and leaves the job alone when the pause refuses. The
// refusal itself runs against the test project in test:db.
//
// Needs no database.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
const pause = readFileSync(join(root, "supabase/tests/sessions/sweep-pause.sql"), "utf8");
const runner = readFileSync(join(root, "scripts/test-db.mjs"), "utf8");

describe("sweep-pause.sql", () => {
  const guard = /^-- guard: begin\n([\s\S]*?)^-- guard: end$/m.exec(pause);

  it("refuses a project whose Vault holds extraction_worker_url, before it pauses the job", () => {
    expect(guard).not.toBeNull();
    expect(guard![1]).toContain("exists (select 1 from vault.secrets s where s.name = 'extraction_worker_url')");
    expect(guard![1]).toMatch(/raise exception 'this project''s Vault holds extraction_worker_url/);
    expect(pause.indexOf("-- guard: end")).toBeLessThan(pause.indexOf("cron.alter_job"));
    // in the same transaction as the pause, so a refusal pauses nothing
    expect(pause.lastIndexOf("begin;", pause.indexOf("-- guard: begin"))).toBeGreaterThanOrEqual(0);
    expect(pause.slice(pause.indexOf("-- guard: end"), pause.indexOf("cron.alter_job"))).not.toContain("commit;");
  });
});

describe("scripts/test-db.mjs", () => {
  it("proves the guard refuses before every pause, and leaves the job alone when the pause refuses", () => {
    const probe = runner.indexOf("vault.create_secret('https://worker.invalid/api/extraction-worker', 'extraction_worker_url')");
    const pauseQuery = runner.indexOf('await query("sweep-pause.sql")');
    expect(probe).toBeGreaterThan(0);
    expect(pauseQuery).toBeGreaterThan(probe);
    expect(runner).toMatch(/rollback;\\n`/);
    expect(runner).toContain("if (/already paused|holds extraction_worker_url/.test(pause.text)) process.exit(1);");
  });
});
