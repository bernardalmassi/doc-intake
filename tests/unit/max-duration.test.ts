// The time bounds a queued run lives under (docs/worker-design.md, section
// 6): its model calls, each counted first (3 x (15 s + 60 s)), the worker
// route's maxDuration, which
// bounds after() too, the claimed message's visibility timeout, and the
// stale limit the sweep and the reaper go by. Each must outlast the one
// before it: a delivery must finish inside its function, and no second
// delivery or reaper may reach a run whose function may still be running.
// The Extract page no longer runs a model, so it needs no limit of its own.
// Reads the sources as text, since importing them would pull in server-only
// code. Needs no database.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DOWNLOAD_TIMEOUT_MS,
  EXTRACTION_LIMITS,
  FINISH_ATTEMPT_TIMEOUT_MS,
  PROVIDER_TIMEOUT_MS,
  TOKEN_COUNT_TIMEOUT_MS,
  WORKER_DEADLINE_MARGIN_MS,
} from "@/lib/extraction/config";

const root = fileURLToPath(new URL("../..", import.meta.url));
const ROUTE = "src/app/api/extraction-worker/route.ts";
const SEGMENT = "src/app/app/[slug]";
// Vercel Hobby's maximum with Fluid compute (docs/worker-design.md, section 12)
const HOST_MAX_SECONDS = 300;

function literalMaxDuration(path: string): number | null {
  const source = readFileSync(join(root, path), "utf8");
  const match = source.match(/^export const maxDuration = (\d+);$/m);
  return match ? Number(match[1]) : null;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("the queue's time bounds", () => {
  it("run in order: model calls and their counts < the route's maxDuration < the host's maximum", () => {
    // every call is counted before it is sent (run.ts), so a run makes at
    // most as many counts as calls
    const modelSeconds = (EXTRACTION_LIMITS.maxCallsPerRun * (TOKEN_COUNT_TIMEOUT_MS + PROVIDER_TIMEOUT_MS)) / 1000;
    const route = literalMaxDuration(ROUTE);
    expect(modelSeconds).toBe(225);
    expect(route, `${ROUTE} has no literal maxDuration export`).not.toBeNull();
    expect(route).toBeGreaterThan(modelSeconds);
    expect(route).toBeLessThan(HOST_MAX_SECONDS);
  });

  it("leave the finish at least two full attempts before the worker's deadline", () => {
    // what the download, the calls and their counts can take at most, then the finish
    // retries until the deadline (delivery.ts): the route's maxDuration less
    // the margin
    const route = literalMaxDuration(ROUTE) ?? 0;
    const modelMs = EXTRACTION_LIMITS.maxCallsPerRun * (TOKEN_COUNT_TIMEOUT_MS + PROVIDER_TIMEOUT_MS);
    const finishWindowMs = route * 1000 - WORKER_DEADLINE_MARGIN_MS - DOWNLOAD_TIMEOUT_MS - modelMs;
    expect(finishWindowMs).toBeGreaterThanOrEqual(2 * FINISH_ATTEMPT_TIMEOUT_MS);
    // and the route computes the deadline from its own maxDuration
    expect(readFileSync(join(root, ROUTE), "utf8")).toContain("maxDuration * 1000 - WORKER_DEADLINE_MARGIN_MS");
    // the local runner uses the same limit
    const runner = readFileSync(join(root, "tests/helpers/local-worker.ts"), "utf8").match(/^const RUNNER_SECONDS = (\d+);$/m);
    expect(Number(runner?.[1])).toBe(route);
  });

  it("end before the visibility timeout, which ends no later than the stale limit", () => {
    const route = literalMaxDuration(ROUTE) ?? Infinity;
    expect(route).toBeLessThan(EXTRACTION_LIMITS.workerVisibilitySeconds);
    expect(EXTRACTION_LIMITS.workerVisibilitySeconds).toBeLessThanOrEqual(EXTRACTION_LIMITS.staleRunMinutes * 60);
  });

  it("leave the Extract page without a limit of its own: it only enqueues", () => {
    expect(literalMaxDuration(`${SEGMENT}/page.tsx`)).toBeNull();
    const action = readFileSync(join(root, "src/app/app/extract-action.ts"), "utf8");
    expect(action).not.toMatch(/from "@\/lib\/extraction\/(run|providers|worker|delivery)/);
    // and nothing in src/app but the Extract segment imports the action
    const importers = sourceFiles(join(root, "src"))
      .filter((path) => readFileSync(path, "utf8").includes("@/app/app/extract-action"))
      .map((path) => relative(root, path));
    expect(importers.length).toBeGreaterThan(0);
    for (const path of importers) expect(path.startsWith(`${SEGMENT}/`)).toBe(true);
  });
});
