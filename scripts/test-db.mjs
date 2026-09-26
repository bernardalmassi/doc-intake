#!/usr/bin/env node
// npm run test:db: runs every file in supabase/tests (the stale-run reaper
// and the extraction queue, each inside begin; ... rollback;), then the
// two-session tests in supabase/tests/sessions (the lock order, and a
// ceiling check racing a finish), against the TEST
// project from .env.test, never the app's, through the Supabase CLI's
// Management API access. The CLI stays linked to the app's project: `db
// query` takes --project-ref only together with --linked, and then queries
// that project instead, without relinking. See
// scripts/supabase-test-target.mjs.
//
// Each `db query` runs on a connection of its own, so two of them running
// at once are two sessions: that is how the lock-order tests race a finish
// against the sweep and against a claim (supabase/tests/sessions/setup.sql
// says how each case runs). Every call first resets the CLI's temporary
// login role, and two calls doing that at once can fail one of them
// (28P01, password authentication failed for cli_login_postgres). So the
// second session starts only once the first has sent its query, which the
// first's --debug output shows; the sessions then order themselves through
// advisory locks, not timing. pg_cron's extraction-sweep job is paused for
// the cases and turned back on in a finally; the run fails unless it is
// active again and no tick started meanwhile.

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { supabaseTestTarget } from "./supabase-test-target.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

let target;
try {
  target = supabaseTestTarget(root);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
if (!/^[a-z0-9]{20}$/.test(target.ref)) {
  console.error(`SUPABASE_TEST_URL must be a hosted project (<ref>.supabase.co) for test:db, got ${target.ref}`);
  process.exit(1);
}

const files = readdirSync(join(root, "supabase/tests"))
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => `supabase/tests/${name}`);
const supabase = fileURLToPath(new URL("../node_modules/.bin/supabase", import.meta.url));
for (const file of files) {
  console.error(`test:db ${file} against project ${target.ref}`);
  const result = spawnSync(supabase, ["db", "query", "--linked", "--project-ref", target.ref, "-f", file], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// The two-session lock-order tests -------------------------------------------

const SESSIONS = "supabase/tests/sessions";

// The CLI's --debug lines: requests and profile notes, no credentials
const DEBUG_LINE = /^(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2} HTTP |Using |Supabase CLI |NotFound: |Pooler username )/;

// One `db query` of a file, on its own connection: its exit status, the
// rows of its last statement (null on an error) and what it printed.
// onSent, if given, is called once the query request has gone out (or the
// call has ended without sending it, with false).
function query(file, onSent) {
  return new Promise((resolve) => {
    const path = isAbsolute(file) ? file : `${SESSIONS}/${file}`;
    const args = ["db", "query", "--linked", "--project-ref", target.ref, "--output-format", "json", "-f", path];
    if (onSent) args.push("--debug");
    const child = spawn(supabase, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (onSent && /HTTP POST: \S+\/database\/query/.test(stderr)) {
        onSent(true);
        onSent = null;
      }
    });
    child.on("close", (status) => {
      onSent?.(false);
      let rows = null;
      try {
        const parsed = JSON.parse(stdout);
        if (Array.isArray(parsed.rows)) rows = parsed.rows;
      } catch {
        // not JSON: an error the CLI printed as text
      }
      const printed = stderr.split("\n").filter((line) => !DEBUG_LINE.test(line)).join("\n");
      resolve({ file, status, rows: status === 0 ? rows : null, text: `${stdout}\n${printed}`.trim() });
    });
  });
}

function failure(result) {
  return `${result.file} failed (exit ${result.status}): ${result.text.slice(0, 2000)}`;
}

// What session S or C must report: the race happened (the message was the
// candidate, F held the run when the other session acted, and the run was
// still running), and the other session neither waited nor kept anything.
// The third case races a ceiling check against a finish (finish-table.sql
// instead of finish.sql): the check must count the run exactly once.
const CASES = [
  {
    name: "a finish holds its run while the sweep runs at the message's visibility timeout",
    session: "sweep.sql",
    expect: (r) => [
      [r.candidate === true, "the message was not a claimed message past its visibility timeout"],
      [r.finish_held_locks === true, "session F no longer held the run when the sweep returned"],
      [r.xmax_before === "0" && r.xmax_after === "0", "the sweep locked the message"],
      [Number(r.sweep_ms) < 1000, "the sweep waited (it took longer than deadlock_timeout)"],
      [r.run_after_sweep === "running", "the sweep ended the run the finish held"],
    ],
  },
  {
    name: "a claim skips the expired message of a run a finish holds, and claims the next run",
    setup: "setup-second.sql",
    session: "claim.sql",
    expect: (r) => [
      [r.candidate === true, "the message was not visible to the claim"],
      [r.finish_held_locks === true, "session F no longer held the run when the claim returned"],
      [r.xmax_before === "0" && r.xmax_after === "0", "the claim locked the message of the run it couldn't lock"],
      [Number(r.read_ct_before) === 1 && Number(r.read_ct_after) === 1, "the claim read the message of the run it couldn't lock (read_ct)"],
      [r.vt_unchanged === true, "the claim read the message of the run it couldn't lock (vt)"],
      [Number(r.claimed) === 1 && r.claimed_document === "f3f3f3f3-0000-4000-8000-000000000002", "the claim did not go on to the next run"],
      [Number(r.claim_ms) < 1000, "the claim waited (it took longer than deadlock_timeout)"],
      [r.run_after_claim === "running", "the claim ended the run the finish held"],
    ],
  },
  {
    name: "a ceiling check runs while a finish commits the run it would count: counted exactly once",
    finish: "finish-table.sql",
    session: "limits.sql",
    expect: (r) => [
      [
        Number(r.ledger_after) === Number(r.ledger_before) + 1 && r.run_after_check === "succeeded",
        "the finish did not commit while the check ran (the organization's ledger gained no row during it)",
      ],
      [
        typeof r.result === "string" && r.result.startsWith("refused: this organization has reached its monthly extraction spend ceiling"),
        "the check did not count the finished run (it read the ledger and the runs in flight in two snapshots)",
      ],
      [Number(r.rows_left) === 0, "the check's ledger row was committed"],
    ],
  },
];

// One case: cleanup, setup, the two sessions, the check, cleanup again.
// True if it passed.
async function runCase(testCase) {
  console.error(`test:db ${SESSIONS}: ${testCase.name}, against project ${target.ref}`);
  const problems = [];

  const before = await query("cleanup.sql");
  if (before.status !== 0) {
    console.error(`  FAILED: ${failure(before)}`);
    return false;
  }
  try {
    const setup = await query("setup.sql");
    const claimed = setup.rows?.[0];
    const second = testCase.setup ? await query(testCase.setup) : null;
    if (!claimed || claimed.status !== "running" || Number(claimed.read_ct) !== 1 || claimed.hidden !== true) {
      problems.push(setup.rows ? `setup.sql did not leave one claimed run: ${JSON.stringify(setup.rows)}` : failure(setup));
    } else if (second && (second.rows?.[0]?.status !== "queued" || Number(second.rows[0].read_ct) !== 0)) {
      problems.push(second.rows ? `${testCase.setup} did not leave a queued run: ${JSON.stringify(second.rows)}` : failure(second));
    } else {
      let sent;
      const finishSent = new Promise((resolve) => (sent = resolve));
      const running = query(testCase.finish ?? "finish.sql", sent);
      const [finish, other] = await Promise.all([
        running,
        finishSent.then((ok) =>
          ok
            ? query(testCase.session)
            : { file: testCase.session, status: null, rows: null, text: "not started: finish.sql ended before sending its query" },
        ),
      ]);
      for (const session of [finish, other]) {
        if (/deadlock detected|40P01/i.test(session.text)) problems.push(`${session.file}: a deadlock was reported`);
        if (!session.rows) problems.push(failure(session));
      }
      const report = other.rows?.[0];
      if (other.rows && !report) problems.push(`${testCase.session} reported nothing`);
      if (report) {
        for (const [ok, problem] of testCase.expect(report)) if (!ok) problems.push(`${problem}: ${JSON.stringify(report)}`);
        console.error(`  ${testCase.session}: ${JSON.stringify(report)}`);
      }
      if (finish.rows) console.error(`  finish.sql: ${JSON.stringify(finish.rows[0] ?? null)}`);

      const check = await query("check.sql");
      if (check.rows) console.error(`  check.sql: ${JSON.stringify(check.rows[0] ?? null)}`);
      else problems.push(failure(check));
    }
  } finally {
    const after = await query("cleanup.sql");
    if (after.status !== 0) problems.push(failure(after));
  }

  for (const problem of problems) console.error(`  FAILED: ${problem}`);
  if (problems.length === 0) console.error("  ok: the finish committed with its result, no deadlock, the message archived once");
  return problems.length === 0;
}

// Turns the extraction-sweep job back on (sweep-resume.sql) and checks it is
// active and that no tick started after pausedAt. True if so.
async function resumeSweep(pausedAt) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const resume = await query("sweep-resume.sql");
    const row = resume.rows?.[0];
    if (!row) {
      console.error(`  sweep-resume.sql, attempt ${attempt}: ${failure(resume)}`);
      continue;
    }
    const resumedAt = Number(row.resumed_at);
    const whilePaused = Number.isFinite(pausedAt)
      ? (row.recent_starts ?? []).map(Number).filter((start) => start > pausedAt && start < resumedAt)
      : [];
    if (row.active !== true) {
      console.error(`  FAILED: the extraction-sweep cron job is not active again: ${JSON.stringify(row)}`);
      return false;
    }
    if (whilePaused.length > 0) {
      console.error(`  FAILED: ${whilePaused.length} extraction-sweep tick(s) started while the job was paused`);
      return false;
    }
    console.error(
      `test:db ${SESSIONS}: the extraction-sweep cron job is active again, and no tick started in the ${Math.round(resumedAt - pausedAt)} s it was paused`,
    );
    return true;
  }
  console.error(
    "  FAILED: the extraction-sweep cron job could not be turned back on; run: select cron.alter_job(jobid, active := true) from cron.job where jobname = 'extraction-sweep';",
  );
  return false;
}

// sweep-pause.sql's guard must refuse a project whose Vault holds the
// worker's URL: run it, the block between its markers, after making such a
// pair inside a transaction that is rolled back. It must fail with the
// guard's refusal; nothing is paused or committed either way.
const pauseSql = readFileSync(join(root, SESSIONS, "sweep-pause.sql"), "utf8");
const guard = /^-- guard: begin\n([\s\S]*?)^-- guard: end$/m.exec(pauseSql)?.[1];
if (!guard) {
  console.error("sweep-pause.sql has no guard between its markers");
  process.exit(1);
}
const scratch = mkdtempSync(join(tmpdir(), "test-db-"));
try {
  const probe = join(scratch, "pause-guard.sql");
  writeFileSync(
    probe,
    `begin;\nselect vault.create_secret('https://worker.invalid/api/extraction-worker', 'extraction_worker_url');\n${guard}\nrollback;\n`,
  );
  const refused = await query(probe);
  if (refused.status === 0 || !/holds extraction_worker_url/.test(refused.text)) {
    console.error(`  FAILED: sweep-pause.sql's guard did not refuse a project whose Vault holds extraction_worker_url: ${refused.text.slice(0, 500)}`);
    process.exit(1);
  }
  console.error(`test:db ${SESSIONS}: sweep-pause.sql refuses a project whose Vault holds extraction_worker_url`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

// The live sweep stays off the fixtures while the cases run
// (sweep-pause.sql says why), and is turned back on whatever happens.
console.error(`test:db ${SESSIONS}: pausing the extraction-sweep cron job on project ${target.ref}`);
let failed = false;
const pause = await query("sweep-pause.sql");
const paused = pause.rows?.[0]?.active === false;
if (!paused) {
  failed = true;
  console.error(`  FAILED: ${pause.rows ? `sweep-pause.sql did not pause the job: ${JSON.stringify(pause.rows)}` : failure(pause)}`);
  // it was paused before this run, or this is a project with the worker's
  // URL (the app's): leave the job alone, don't run sweep-resume.sql
  if (/already paused|holds extraction_worker_url/.test(pause.text)) process.exit(1);
}
try {
  if (paused) for (const testCase of CASES) if (!(await runCase(testCase))) failed = true;
} finally {
  if (!(await resumeSweep(Number(pause.rows?.[0]?.paused_at)))) failed = true;
}
process.exit(failed ? 1 : 0);
