// The Supabase suites and test:db refuse to run against the app's own
// project (scripts/supabase-test-target.mjs). Needs no database: the check
// is given what it would have read from the .env files.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkTestTarget, parseEnv, projectRef, supabaseTestTarget } from "../../scripts/supabase-test-target.mjs";

const APP = "https://rimxdhisbmhjhjdvultm.supabase.co";
const TEST = "https://jqhqvtkhijrrvhfwseaq.supabase.co";

describe("the Supabase test target", () => {
  it("accepts a test project that isn't the app's", () => {
    expect(checkTestTarget({ testUrl: TEST, testKey: "sb_publishable_test", appUrls: [APP], appKeys: ["sb_publishable_app"] })).toEqual({
      url: TEST,
      publishableKey: "sb_publishable_test",
      ref: "jqhqvtkhijrrvhfwseaq",
    });
  });

  it("refuses the app's project, however its URL is written", () => {
    for (const testUrl of [APP, `${APP}/`, "https://RIMXDHISBMHJHJDVULTM.supabase.co/rest/v1", "https://rimxdhisbmhjhjdvultm.supabase.in"]) {
      expect(() => checkTestTarget({ testUrl, testKey: "k", appUrls: [APP], appKeys: [] }), testUrl).toThrow(/app's own project/);
    }
  });

  it("refuses the app's publishable key", () => {
    expect(() => checkTestTarget({ testUrl: TEST, testKey: "sb_publishable_app", appUrls: [APP], appKeys: ["sb_publishable_app"] })).toThrow(
      /app's publishable key/,
    );
  });

  it("refuses when there is no app project to compare against, or no target", () => {
    expect(() => checkTestTarget({ testUrl: TEST, testKey: "k", appUrls: [], appKeys: [] })).toThrow(/no app project/);
    expect(() => checkTestTarget({ testUrl: TEST, testKey: "k", appUrls: [" "], appKeys: [] })).toThrow(/no app project/);
    expect(() => checkTestTarget({ testUrl: undefined, testKey: "k", appUrls: [APP], appKeys: [] })).toThrow(/Set SUPABASE_TEST_URL/);
    expect(() => checkTestTarget({ testUrl: "not a url", testKey: "k", appUrls: [APP], appKeys: [] })).toThrow(/not a URL/);
  });

  it("accepts the test project's secret key for the local runner, and requires it when asked", () => {
    const base = { testUrl: TEST, testKey: "sb_publishable_test", appUrls: [APP], appKeys: ["sb_publishable_app"] };
    expect(checkTestTarget({ ...base, testSecretKey: "sb_secret_test", appSecretKeys: ["sb_secret_app"] }).secretKey).toBe("sb_secret_test");
    // test:db needs none
    expect(checkTestTarget(base).secretKey).toBeUndefined();
    expect(() => checkTestTarget({ ...base, requireSecretKey: true })).toThrow(/Set SUPABASE_TEST_SECRET_KEY/);
  });

  it("refuses a test secret key that isn't a secret key, or is the app's", () => {
    const base = { testUrl: TEST, testKey: "sb_publishable_test", appUrls: [APP], appKeys: [] };
    for (const testSecretKey of ["sb_publishable_test", "eyJhbGciOiJIUzI1NiJ9.service_role", "secret"]) {
      expect(() => checkTestTarget({ ...base, testSecretKey }), testSecretKey).toThrow(/must be one of the test project's secret keys/);
    }
    expect(() => checkTestTarget({ ...base, testSecretKey: "sb_secret_app", appSecretKeys: ["sb_secret_app"] })).toThrow(/app's secret key/);
  });

  it("finds the app's secret key in its .env files, not in the environment the suites map", () => {
    const root = mkdtempSync(join(tmpdir(), "target-secret-"));
    writeFileSync(join(root, ".env.local"), `NEXT_PUBLIC_SUPABASE_URL=${APP}\nSUPABASE_SECRET_KEY=sb_secret_app\n`);
    writeFileSync(join(root, ".env.test"), `SUPABASE_TEST_URL=${TEST}\nSUPABASE_TEST_PUBLISHABLE_KEY=test\nSUPABASE_TEST_SECRET_KEY=sb_secret_app\n`);
    expect(() => supabaseTestTarget(root, {})).toThrow(/app's secret key/);
    // inside Vitest, SUPABASE_SECRET_KEY is the test key: it isn't an app key
    expect(
      supabaseTestTarget(root, { SUPABASE_TEST_SECRET_KEY: "sb_secret_test", SUPABASE_SECRET_KEY: "sb_secret_test" }, { requireSecretKey: true })
        .secretKey,
    ).toBe("sb_secret_test");
  });

  it("reads .env files the way dotenv does, the last of a repeated key winning", () => {
    expect(parseEnv("# c\nA=1\nexport B='two'\nA=3\nC=\"x # y\"\nD=v # note\n")).toEqual({ A: "3", B: "two", C: "x # y", D: "v" });
    expect(projectRef("http://127.0.0.1:54321")).toBe("127.0.0.1:54321");
  });

  it("finds the app's project in .env.local, and the test target in .env.test", () => {
    const root = mkdtempSync(join(tmpdir(), "target-"));
    writeFileSync(join(root, ".env.local"), `NEXT_PUBLIC_SUPABASE_URL=${APP}\nNEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=app\n`);
    // the old line first, the new one last: the last wins, as in Vitest
    writeFileSync(join(root, ".env.test"), `SUPABASE_TEST_URL=${APP}\nSUPABASE_TEST_PUBLISHABLE_KEY=app\nSUPABASE_TEST_URL=${TEST}\nSUPABASE_TEST_PUBLISHABLE_KEY=test\n`);
    expect(supabaseTestTarget(root, {}).ref).toBe("jqhqvtkhijrrvhfwseaq");
    // the environment wins over .env.test, and SUPABASE_APP_URL counts as an app project
    expect(() => supabaseTestTarget(root, { SUPABASE_TEST_URL: APP, SUPABASE_TEST_PUBLISHABLE_KEY: "test" })).toThrow(/app's own project/);
    const ci = mkdtempSync(join(tmpdir(), "target-ci-"));
    expect(() => supabaseTestTarget(ci, { SUPABASE_TEST_URL: TEST, SUPABASE_TEST_PUBLISHABLE_KEY: "t" })).toThrow(/no app project/);
    expect(supabaseTestTarget(ci, { SUPABASE_TEST_URL: TEST, SUPABASE_TEST_PUBLISHABLE_KEY: "t", SUPABASE_APP_URL: APP }).ref).toBe("jqhqvtkhijrrvhfwseaq");
  });
});
