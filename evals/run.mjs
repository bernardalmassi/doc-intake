#!/usr/bin/env node
// npm run eval                     replay every recording, score, check
// npm run eval -- --live           record fixtures whose recording is
//                                  missing or stale, then replay
// npm run eval -- --live --force   re-record every fixture
// npm run eval -- --write-fixtures regenerate evals/documents/ from the
//                                  fixture definitions
//
// A thin wrapper: it checks the arguments and runs vitest with
// vitest.eval.config.mts and EVAL_MODE set. See EVALS.md.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const USAGE = "usage: npm run eval [-- --live [--force] | --write-fixtures]";
const KNOWN = new Set(["--live", "--force", "--write-fixtures"]);

const args = process.argv.slice(2);
const unknown = args.filter((arg) => !KNOWN.has(arg));
const live = args.includes("--live");
const force = args.includes("--force");
const writeFixtures = args.includes("--write-fixtures");

function usageError(message) {
  console.error(`${message}\n${USAGE}`);
  process.exit(2);
}

if (unknown.length > 0) usageError(`unknown argument ${unknown.join(" ")}`);
if (live && writeFixtures) usageError("--live and --write-fixtures don't combine");
if (force && !live) usageError("--force only applies to --live");

const mode = live ? "live" : writeFixtures ? "write-fixtures" : "replay";
const root = fileURLToPath(new URL("..", import.meta.url));
const vitest = fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url));

const result = spawnSync(process.execPath, [vitest, "run", "--config", "vitest.eval.config.mts"], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, EVAL_MODE: mode, EVAL_FORCE: force ? "1" : "" },
});
process.exit(result.status ?? 1);
