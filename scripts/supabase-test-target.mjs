// The Supabase project the database tests run against (the two Vitest
// suites and the SQL reaper test), and the refusal to run them against the
// app's own project.
//
// The suites sign up users, forge extraction spend up to the monthly
// ceilings and delete what they create. Against the app's project that
// spend would count against the app's real budget and could pause
// extraction for real users until the month ends. So the tests need a
// project of their own, and this checks it is a different one:
//
//   - the test project is SUPABASE_TEST_URL, from .env.test (or the
//     environment, as in CI), with SUPABASE_TEST_PUBLISHABLE_KEY
//   - the app's project is NEXT_PUBLIC_SUPABASE_URL (and its publishable
//     key) in any .env file Next.js reads (.env.local and the others), plus
//     SUPABASE_APP_URL from the environment, which CI sets from a
//     repository variable because it has no .env.local
//
// It refuses when the two share a project ref, a URL or a publishable key,
// and when no app project is known at all, because then nothing was
// checked. SUPABASE_TEST_SECRET_KEY, the test project's secret key, which
// only the local worker runner in the Vitest suites uses
// (tests/helpers/local-worker.ts), must be a secret key (sb_secret_...) and
// must not be the app's SUPABASE_SECRET_KEY from any of the app's .env
// files; the Vitest suites require it, test:db doesn't. Plain JavaScript so
// `npm run test:db` can use it without a build step; the Vitest suites
// import it too.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The files Next.js loads NEXT_PUBLIC_* variables from, in any mode.
export const APP_ENV_FILES = [".env", ".env.local", ".env.development", ".env.development.local", ".env.production", ".env.production.local"];
const TEST_ENV_FILES = [".env.test", ".env.test.local"];

// KEY=value lines, as dotenv reads them: comments and blank lines skipped,
// an optional `export `, optional matching quotes, and the last value of a
// repeated key wins.
export function parseEnv(text) {
  /** @type {Record<string, string>} */
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2];
    const quoted = /^(['"])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2];
    else value = value.replace(/\s+#.*$/, "");
    values[match[1]] = value;
  }
  return values;
}

// The project a Supabase URL points at: its ref for a hosted project
// (<ref>.supabase.co), otherwise its host and port. Null if it isn't a URL.
export function projectRef(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const hosted = /^([a-z0-9]+)\.supabase\.(co|in)$/.exec(host);
  return hosted ? hosted[1] : parsed.port ? `${host}:${parsed.port}` : host;
}

/**
 * Checks the test target against every app project it knows of. Pure: the
 * caller supplies what it read.
 * @param {{ testUrl?: string, testKey?: string, appUrls: string[], appKeys: string[], testSecretKey?: string, appSecretKeys?: string[], requireSecretKey?: boolean }} input
 * @returns {{ url: string, publishableKey: string, ref: string, secretKey?: string }}
 */
export function checkTestTarget({ testUrl, testKey, appUrls, appKeys, testSecretKey, appSecretKeys = [], requireSecretKey = false }) {
  if (!testUrl || !testKey) {
    throw new Error("Set SUPABASE_TEST_URL and SUPABASE_TEST_PUBLISHABLE_KEY in .env.test (see .env.test.example).");
  }
  const ref = projectRef(testUrl);
  if (!ref) throw new Error("SUPABASE_TEST_URL is not a URL.");
  const known = appUrls.filter((url) => url && url.trim().length > 0);
  if (known.length === 0) {
    throw new Error(
      "Refusing to run the Supabase tests: no app project to compare against. Set NEXT_PUBLIC_SUPABASE_URL in .env.local, or SUPABASE_APP_URL in the environment (see README, Tests).",
    );
  }
  for (const appUrl of known) {
    if (projectRef(appUrl) === ref) {
      throw new Error(
        `Refusing to run the Supabase tests against the app's own project (${ref}): its spend would count against the app's budget. Point SUPABASE_TEST_URL in .env.test at the separate test project (see README, Tests).`,
      );
    }
  }
  if (appKeys.some((key) => key && key === testKey)) {
    throw new Error(
      "Refusing to run the Supabase tests: SUPABASE_TEST_PUBLISHABLE_KEY is the app's publishable key. Use the test project's key (see README, Tests).",
    );
  }
  if (!testSecretKey) {
    if (requireSecretKey) {
      throw new Error(
        "Set SUPABASE_TEST_SECRET_KEY in .env.test: the test project's secret key, which the local worker runner uses (see .env.test.example).",
      );
    }
    return { url: testUrl, publishableKey: testKey, ref };
  }
  if (!testSecretKey.startsWith("sb_secret_")) {
    throw new Error("SUPABASE_TEST_SECRET_KEY must be one of the test project's secret keys (sb_secret_...).");
  }
  if (appSecretKeys.some((key) => key && key === testSecretKey)) {
    throw new Error(
      "Refusing to run the Supabase tests: SUPABASE_TEST_SECRET_KEY is the app's secret key. Use a secret key of the test project (see README, Tests).",
    );
  }
  return { url: testUrl, publishableKey: testKey, ref, secretKey: testSecretKey };
}

function readEnvFiles(root, names) {
  return names
    .map((name) => join(root, name))
    .filter((path) => existsSync(path))
    .map((path) => parseEnv(readFileSync(path, "utf8")));
}

/**
 * Reads the test target and the app project(s) from the repository's .env
 * files and the environment, and checks them. The environment wins over the
 * files for the test target, as in CI. The app's secret key is read from its
 * .env files only: inside the Vitest suites the environment's
 * SUPABASE_SECRET_KEY is the test key, mapped there for the local runner.
 * @param {string} root the repository root
 * @param {Record<string, string | undefined>} env
 * @param {{ requireSecretKey?: boolean }} [options]
 */
export function supabaseTestTarget(root, env = process.env, { requireSecretKey = false } = {}) {
  const testFiles = Object.assign({}, ...readEnvFiles(root, TEST_ENV_FILES));
  const appFiles = readEnvFiles(root, APP_ENV_FILES);
  return checkTestTarget({
    testSecretKey: env.SUPABASE_TEST_SECRET_KEY || testFiles.SUPABASE_TEST_SECRET_KEY,
    appSecretKeys: appFiles.map((values) => values.SUPABASE_SECRET_KEY).filter((key) => typeof key === "string"),
    requireSecretKey,
    testUrl: env.SUPABASE_TEST_URL || testFiles.SUPABASE_TEST_URL,
    testKey: env.SUPABASE_TEST_PUBLISHABLE_KEY || testFiles.SUPABASE_TEST_PUBLISHABLE_KEY,
    appUrls: [...appFiles.map((values) => values.NEXT_PUBLIC_SUPABASE_URL), env.SUPABASE_APP_URL, env.NEXT_PUBLIC_SUPABASE_URL].filter(
      (url) => typeof url === "string",
    ),
    appKeys: [...appFiles.map((values) => values.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY), env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY].filter(
      (key) => typeof key === "string",
    ),
  });
}
