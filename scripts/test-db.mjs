#!/usr/bin/env node
// npm run test:db: runs every file in supabase/tests (the stale-run reaper
// and the extraction queue, each inside begin; ... rollback;), then the
// two-session tests in supabase/tests/sessions (the lock order, a ceiling
// check racing a finish, and a claim held up past its own timeout), against the TEST
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
//
// A case may also name its own first session (`first`, in place of
// finish.sql), take its report from that session (`reportFrom: "first"`),
// expect the database to end the second session with an error matching
// `endedBy`, and skip check.sql, which checks the finish (`check: false`).
const CASES = [
  {
    name: "a finish holds its run while the sweep runs at the message's visibility timeout",
    session: "sweep.sql",
    expect: (r) => [
      [r.candidate === true, "the message was not a claimed message past its visibility timeout"],
      [r.xmax_before === "0", "the message was held before the sweep ran"],
      // since 20260925000005 the sweep waits for the run's document (F goes
      // on and finishes once it does) instead of skipping the run
      [r.finish_held_locks === false, "the sweep returned while the finish still held the run (it didn't wait)"],
      [Number(r.sweep_ms) < 5000, "the sweep waited longer than its lock timeout"],
      [r.run_after_sweep === "succeeded", "the sweep ended the run the finish held, or the finish wasn't kept"],
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
  {
    name: "a claim stuck behind a lock is ended by its own timeout, and its claim rolls back whole",
    setup: "setup-second.sql",
    first: "hold-tokens.sql",
    session: "claim-stuck.sql",
    endedBy: /25P04|terminating connection due to transaction timeout/,
    reportFrom: "first",
    check: false,
    ok: "the database ended the stuck claim at its timeout and rolled back its read, its status and its token",
    expect: (r) => [
      [r.waited === true, "the claim never waited on session H's lock"],
      [r.ended_while_held === true, "the claim's session was not ended while session H held the table (it has no timeout of its own)"],
      [r.claim_returned === false, "the claim returned"],
      [Number(r.waited_ms) >= 3000 && Number(r.waited_ms) <= 9000, "the claim was not ended about 5 s into its wait"],
      [r.run_status === "queued", "the second run is not queued again"],
      [Number(r.read_ct) === 0 && r.visible === true, "the claim's read of the message was not rolled back"],
      [r.has_token === false, "the second run kept a claim token"],
    ],
  },
  {
    name: "a run past its deadline whose document a rename holds: the sweep waits for the lock, then ends the run",
    setup: "setup-stale.sql",
    first: "hold-document.sql",
    session: "sweep-stale.sql",
    check: false,
    ok: "the sweep waited for the held document, in the lock order, and expired the run past its deadline at 0",
    expect: (r) => [
      [r.run_status === "failed" && typeof r.run_error === "string" && r.run_error.startsWith("expired: "),
        "the sweep didn't end the run past its deadline (it skipped the held document)"],
      [Number(r.sweep_ms) >= 900, "the sweep didn't wait for the held document"],
      [Number(r.sweep_ms) < 5000, "the sweep waited longer than its lock timeout"],
    ],
  },
  {
    name: "a document held past the sweep's lock timeout: the sweep gives up at the timeout and leaves the run for its next tick",
    setup: "setup-stale.sql",
    first: "hold-document-long.sql",
    session: "sweep-stale.sql",
    check: false,
    ok: "the sweep gave up at its 5 s lock timeout, raised nothing, and left the run queued",
    expect: (r) => [
      [r.run_status === "queued", "the run past its deadline was ended though its document was held"],
      [Number(r.sweep_ms) >= 4500 && Number(r.sweep_ms) < 8000, "the sweep did not give up at its 5 s lock timeout"],
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
      const firstFile = testCase.first ?? testCase.finish ?? "finish.sql";
      const firstSent = new Promise((resolve) => (sent = resolve));
      const running = query(firstFile, sent);
      const [finish, other] = await Promise.all([
        running,
        firstSent.then((ok) =>
          ok
            ? query(testCase.session)
            : { file: testCase.session, status: null, rows: null, text: `not started: ${firstFile} ended before sending its query` },
        ),
      ]);
      for (const session of [finish, other]) {
        if (/deadlock detected|40P01/i.test(session.text)) problems.push(`${session.file}: a deadlock was reported`);
        if (session === other && testCase.endedBy) {
          if (session.rows) problems.push(`${testCase.session} returned, but the database should have ended its session`);
          else if (!testCase.endedBy.test(session.text)) problems.push(failure(session));
          else console.error(`  ${testCase.session}: ended by the database, as expected`);
          continue;
        }
        if (!session.rows) problems.push(failure(session));
      }
      const reporter = testCase.reportFrom === "first" ? finish : other;
      const report = reporter.rows?.[0];
      if (reporter.rows && !report) problems.push(`${reporter.file} reported nothing`);
      if (report) {
        for (const [ok, problem] of testCase.expect(report)) if (!ok) problems.push(`${problem}: ${JSON.stringify(report)}`);
        console.error(`  ${reporter.file}: ${JSON.stringify(report)}`);
      }
      if (finish.rows && reporter !== finish) console.error(`  ${firstFile}: ${JSON.stringify(finish.rows[0] ?? null)}`);

      if (testCase.check !== false) {
        const check = await query("check.sql");
        if (check.rows) console.error(`  check.sql: ${JSON.stringify(check.rows[0] ?? null)}`);
        else problems.push(failure(check));
      }
    }
  } finally {
    const after = await query("cleanup.sql");
    if (after.status !== 0) problems.push(failure(after));
  }

  for (const problem of problems) console.error(`  FAILED: ${problem}`);
  if (problems.length === 0) console.error(`  ok: ${testCase.ok ?? "the finish committed with its result, no deadlock, the message archived once"}`);
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
