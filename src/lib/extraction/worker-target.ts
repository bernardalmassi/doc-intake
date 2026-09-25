// The Supabase project the worker may reach with the secret key it holds,
// decided before any client exists. The key reads every tenant's files and
// can claim and finish runs, so the URL it is sent to is not trusted from
// the environment: NEXT_PUBLIC_SUPABASE_URL must be exactly the one project
// the worker is meant to use for its NODE_ENV.
//   production  the app's project
//   test        the test project (Vitest sets NODE_ENV=test, and the local
//               runner, tests/helpers/local-worker.ts, points it there)
// Anything else, including development, is refused. So a mistyped or
// poisoned URL, or a test run pointed at the app, sends the key nowhere.
// Pure, so tests/unit/worker-target.test.ts can drive it.

// Both refs are public (CLAUDE.md, "Commands").
export const APP_PROJECT_REF = "rimxdhisbmhjhjdvultm";
export const TEST_PROJECT_REF = "jqhqvtkhijrrvhfwseaq";

const PROJECT_URLS: Readonly<Record<string, string>> = {
  production: `https://${APP_PROJECT_REF}.supabase.co`,
  test: `https://${TEST_PROJECT_REF}.supabase.co`,
};

// The project's URL, or an error naming what is wrong, never the URL given.
// The parsed URL must be exactly https://<ref>.supabase.co/: https, that
// host, no port, no path beyond /, no query or fragment, no username or
// password.
export function workerProjectUrl(url: string | undefined, nodeEnv: string | undefined): string {
  const expected = nodeEnv === "production" || nodeEnv === "test" ? PROJECT_URLS[nodeEnv] : undefined;
  if (expected === undefined) {
    throw new Error("the worker runs only under NODE_ENV production (the app's project) or test (the test project)");
  }
  if (typeof url !== "string" || url.length === 0) throw new Error("the worker has no Supabase URL");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("the worker's Supabase URL is not a URL");
  }
  if (parsed.href !== `${expected}/`) {
    throw new Error(`under NODE_ENV=${nodeEnv} the worker's Supabase URL must be exactly ${expected}`);
  }
  return expected;
}
