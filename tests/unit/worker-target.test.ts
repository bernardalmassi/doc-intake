// The project the worker may reach with the secret key
// (src/lib/extraction/worker-target.ts): under test it refuses the app's
// project before any request, and it refuses anything that isn't an https
// Supabase URL. Needs no database.

import { describe, expect, it } from "vitest";
import { APP_PROJECT_REF, workerProjectUrl } from "@/lib/extraction/worker-target";

const APP = `https://${APP_PROJECT_REF}.supabase.co`;
const TEST = "https://jqhqvtkhijrrvhfwseaq.supabase.co";

describe("the worker's Supabase project", () => {
  it("is Vitest's: NODE_ENV really is test here", () => {
    expect(process.env.NODE_ENV).toBe("test");
    expect(APP_PROJECT_REF).toBe("rimxdhisbmhjhjdvultm");
  });

  it("refuses the app's project under test, however its URL is written", () => {
    for (const url of [APP, `${APP}/`, `${APP}/rest/v1`, `https://${APP_PROJECT_REF.toUpperCase()}.supabase.co`, `https://${APP_PROJECT_REF}.supabase.in`]) {
      expect(() => workerProjectUrl(url, "test"), url).toThrow(/app's project under test/);
      expect(() => workerProjectUrl(url, process.env.NODE_ENV), url).toThrow(/app's project under test/);
    }
  });

  it("lets the test project through under test, and the app's in production", () => {
    expect(workerProjectUrl(TEST, "test")).toBe(TEST);
    expect(workerProjectUrl(`${TEST}/`, "test")).toBe(TEST);
    expect(workerProjectUrl(APP, "production")).toBe(APP);
    expect(workerProjectUrl("http://127.0.0.1:54321", "test")).toBe("http://127.0.0.1:54321");
  });

  it("refuses a missing, malformed or plain-http URL, without echoing it", () => {
    expect(() => workerProjectUrl(undefined, "production")).toThrow(/no Supabase URL/);
    expect(() => workerProjectUrl("", "production")).toThrow(/no Supabase URL/);
    expect(() => workerProjectUrl("not a url", "production")).toThrow(/not a URL/);
    expect(() => workerProjectUrl("http://example.supabase.co", "production")).toThrow(/must be https/);
    expect(() => workerProjectUrl("ftp://example.supabase.co", "production")).toThrow(/must be https/);
    try {
      workerProjectUrl("not a url sb_secret_should_not_echo", "production");
    } catch (error) {
      expect(String(error)).not.toContain("sb_secret_");
    }
  });
});
