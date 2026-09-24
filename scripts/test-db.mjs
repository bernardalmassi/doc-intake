#!/usr/bin/env node
// npm run test:db: runs every file in supabase/tests (the stale-run reaper
// and the extraction queue, each inside begin; ... rollback;) against the
// TEST project from .env.test, never the app's, through the Supabase CLI's
// Management API access. The CLI stays linked to the app's project: `db
// query` takes --project-ref only together with --linked, and then queries
// that project instead, without relinking. See
// scripts/supabase-test-target.mjs.

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
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
