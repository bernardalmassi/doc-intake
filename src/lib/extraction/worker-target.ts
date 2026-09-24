// The Supabase project the worker may reach with the secret key it holds.
// In production that is the app's project, from NEXT_PUBLIC_SUPABASE_URL.
// Under test (NODE_ENV=test, which Vitest sets), the local runner
// (tests/helpers/local-worker.ts) points the worker at the test project, and
// this refuses the app's project before any request is made, so a
// misconfigured test run can't claim, run or charge a real user's
// extraction. Pure, so tests/unit/worker-target.test.ts can drive it.

// The app's project (CLAUDE.md, "Commands"). Its test counterpart is
// jqhqvtkhijrrvhfwseaq.
export const APP_PROJECT_REF = "rimxdhisbmhjhjdvultm";

// The project URL's origin, or an error naming what is wrong with it,
// never the URL itself.
export function workerProjectUrl(url: string | undefined, nodeEnv: string | undefined): string {
  if (typeof url !== "string" || url.length === 0) throw new Error("the worker has no Supabase URL");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("the worker's Supabase URL is not a URL");
  }
  const host = parsed.hostname.toLowerCase();
  const local = host === "localhost" || host === "127.0.0.1";
  if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) {
    throw new Error("the worker's Supabase URL must be https");
  }
  const hosted = /^([a-z0-9]+)\.supabase\.(co|in)$/.exec(host);
  if (nodeEnv === "test" && hosted?.[1] === APP_PROJECT_REF) {
    throw new Error("refusing to run the worker against the app's project under test; point it at the test project");
  }
  return parsed.origin;
}
