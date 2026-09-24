// The worker route's bearer check (src/lib/extraction/worker-auth.ts):
// only "Bearer <the configured secret>" gets through, the comparison is in
// constant time, and a missing or short configured secret lets nothing
// through, not even an empty bearer. Needs no database.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isAuthorizedWorkerCall, MIN_WORKER_SECRET_LENGTH } from "@/lib/extraction/worker-auth";

const SECRET = "a-worker-secret-that-is-long-enough-0123456789";

describe("the worker route's bearer check", () => {
  it("accepts the configured secret as a Bearer credential, the scheme in any case", () => {
    expect(isAuthorizedWorkerCall(`Bearer ${SECRET}`, SECRET)).toBe(true);
    expect(isAuthorizedWorkerCall(`bearer ${SECRET}`, SECRET)).toBe(true);
    expect(isAuthorizedWorkerCall(`BEARER ${SECRET}`, SECRET)).toBe(true);
  });

  it.each([
    ["no header", null],
    ["an empty header", ""],
    ["the secret alone", SECRET],
    ["another scheme", `Basic ${SECRET}`],
    ["a token scheme", `Token ${SECRET}`],
    ["two spaces", `Bearer  ${SECRET}`],
    ["a trailing space", `Bearer ${SECRET} `],
    ["an empty bearer", "Bearer "],
    ["a shorter value", `Bearer ${SECRET.slice(0, -1)}`],
    ["a longer value", `Bearer ${SECRET}x`],
    ["the same length, one character off", `Bearer ${SECRET.slice(0, -1)}X`],
    ["a different secret", `Bearer ${"b".repeat(SECRET.length)}`],
  ])("refuses %s", (_label, header) => {
    expect(isAuthorizedWorkerCall(header, SECRET)).toBe(false);
  });

  it("refuses everything while the configured secret is unset, empty or short", () => {
    for (const configured of [undefined, "", "short", "x".repeat(MIN_WORKER_SECRET_LENGTH - 1)]) {
      expect(isAuthorizedWorkerCall(`Bearer ${configured ?? ""}`, configured), String(configured)).toBe(false);
      expect(isAuthorizedWorkerCall("Bearer ", configured), String(configured)).toBe(false);
    }
    const minimal = "x".repeat(MIN_WORKER_SECRET_LENGTH);
    expect(isAuthorizedWorkerCall(`Bearer ${minimal}`, minimal)).toBe(true);
    expect(MIN_WORKER_SECRET_LENGTH).toBeGreaterThanOrEqual(32);
  });

  it("compares with crypto.timingSafeEqual, never with === on the secret", () => {
    const source = readFileSync(fileURLToPath(new URL("../../src/lib/extraction/worker-auth.ts", import.meta.url)), "utf8");
    expect(source).toMatch(/^import \{ timingSafeEqual \} from "node:crypto";$/m);
    expect(source).toMatch(/timingSafeEqual\(given, expected\)/);
    // neither value is compared for equality any other way (type checks aside)
    const code = source.replace(/typeof \w+ !== "string"/g, "");
    expect(code).not.toMatch(/\b(configured|match\[1\]|given)\s*[=!]==?[^=]|[=!]==?\s*(configured|match\[1\]|given)\b/);
  });
});
