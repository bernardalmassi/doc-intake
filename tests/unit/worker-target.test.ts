// The project the worker may reach with the secret key
// (src/lib/extraction/worker-target.ts): exactly the app's project under
// NODE_ENV=production, exactly the test project under NODE_ENV=test, and
// nothing under any other NODE_ENV. A pure function, so nothing here can
// make a request; tests/extraction.test.ts ("guards") drives the same
// refusals through the worker itself with fetch stubbed. Needs no database.

import { describe, expect, it } from "vitest";
import { APP_PROJECT_REF, TEST_PROJECT_REF, workerProjectUrl } from "@/lib/extraction/worker-target";

const APP = `https://${APP_PROJECT_REF}.supabase.co`;
const TEST = `https://${TEST_PROJECT_REF}.supabase.co`;

// Each URL beside the NODE_ENV under which it must be refused.
const REFUSED: [label: string, url: string | undefined, nodeEnv: string | undefined][] = [
  // lookalike hosts
  ["a lookalike host (suffix)", `https://${TEST_PROJECT_REF}.supabase.co.evil.example`, "test"],
  ["a lookalike host (extra letter)", `https://${TEST_PROJECT_REF}x.supabase.co`, "test"],
  ["a lookalike host (subdomain)", `https://x.${TEST_PROJECT_REF}.supabase.co`, "test"],
  ["a lookalike host (supabase.in)", `https://${TEST_PROJECT_REF}.supabase.in`, "test"],
  ["a lookalike host (trailing dot)", `${TEST}.`, "test"],
  ["another host entirely", "https://evil.example", "production"],
  ["a lookalike host (suffix), in production", `${APP}.evil.example`, "production"],
  // the other project's ref under the wrong NODE_ENV
  ["the app's project under test", APP, "test"],
  ["the test project in production", TEST, "production"],
  // http
  ["http", `http://${TEST_PROJECT_REF}.supabase.co`, "test"],
  ["http, in production", `http://${APP_PROJECT_REF}.supabase.co`, "production"],
  ["http to a local stack", "http://127.0.0.1:54321", "test"],
  // a port
  ["a port", `${TEST}:8443`, "test"],
  ["a port, in production", `${APP}:5432`, "production"],
  // a path, query or fragment
  ["a path", `${TEST}/rest/v1`, "test"],
  ["a path, in production", `${APP}/x`, "production"],
  ["a query", `${TEST}/?x=1`, "test"],
  ["a fragment", `${TEST}/#x`, "test"],
  // credentials
  ["a username and password", `https://user:pass@${TEST_PROJECT_REF}.supabase.co`, "test"],
  ["a username", `https://user@${APP_PROJECT_REF}.supabase.co`, "production"],
  ["the right host as a username", `https://${TEST_PROJECT_REF}.supabase.co@evil.example`, "test"],
  // any other NODE_ENV
  ["development mode, the app's project", APP, "development"],
  ["development mode, the test project", TEST, "development"],
  ["no NODE_ENV", APP, undefined],
  ["an empty NODE_ENV", APP, ""],
  ["another NODE_ENV", APP, "staging"],
  ["NODE_ENV in another case", APP, "Production"],
  // no URL at all
  ["no URL", undefined, "production"],
  ["an empty URL", "", "test"],
  ["not a URL", "not a url", "production"],
];

describe("the worker's Supabase project", () => {
  it("is Vitest's: NODE_ENV really is test here, and the refs are the two projects'", () => {
    expect(process.env.NODE_ENV).toBe("test");
    expect(APP_PROJECT_REF).toBe("rimxdhisbmhjhjdvultm");
    expect(TEST_PROJECT_REF).toBe("jqhqvtkhijrrvhfwseaq");
  });

  it("lets exactly the app's project through in production, and the test project under test", () => {
    expect(workerProjectUrl(APP, "production")).toBe(APP);
    expect(workerProjectUrl(`${APP}/`, "production")).toBe(APP);
    expect(workerProjectUrl(TEST, "test")).toBe(TEST);
    expect(workerProjectUrl(`${TEST}/`, "test")).toBe(TEST);
    expect(workerProjectUrl(TEST, process.env.NODE_ENV)).toBe(TEST);
  });

  it.each(REFUSED)("refuses %s", (_label, url, nodeEnv) => {
    expect(() => workerProjectUrl(url, nodeEnv)).toThrow();
  });

  it("says why without echoing the URL", () => {
    expect(() => workerProjectUrl(APP, "development")).toThrow(/only under NODE_ENV production .* or test/);
    expect(() => workerProjectUrl(undefined, "production")).toThrow(/no Supabase URL/);
    expect(() => workerProjectUrl("not a url", "production")).toThrow(/not a URL/);
    expect(() => workerProjectUrl(APP, "test")).toThrow(`under NODE_ENV=test the worker's Supabase URL must be exactly ${TEST}`);
    expect(() => workerProjectUrl(TEST, "production")).toThrow(`under NODE_ENV=production the worker's Supabase URL must be exactly ${APP}`);
    for (const secret of ["https://sb_secret_leak.example", "https://user:sb_secret_leak@evil.example", "sb_secret_leak not a url"]) {
      for (const nodeEnv of ["production", "test", "development"]) {
        try {
          workerProjectUrl(secret, nodeEnv);
          expect.unreachable(`${secret} under ${nodeEnv} was accepted`);
        } catch (error) {
          expect(String(error)).not.toContain("sb_secret_leak");
        }
      }
    }
  });
});
