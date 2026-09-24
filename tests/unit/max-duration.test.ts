// The time bounds a queued run lives under (docs/worker-design.md, section
// 6): its model calls (3 x 60 s), the worker route's maxDuration, which
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
import { EXTRACTION_LIMITS, PROVIDER_TIMEOUT_MS } from "@/lib/extraction/config";

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
  it("run in order: model calls < the route's maxDuration < the host's maximum", () => {
    const modelSeconds = (EXTRACTION_LIMITS.maxCallsPerRun * PROVIDER_TIMEOUT_MS) / 1000;
    const route = literalMaxDuration(ROUTE);
    expect(modelSeconds).toBe(180);
    expect(route, `${ROUTE} has no literal maxDuration export`).not.toBeNull();
    expect(route).toBeGreaterThan(modelSeconds);
    expect(route).toBeLessThan(HOST_MAX_SECONDS);
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
