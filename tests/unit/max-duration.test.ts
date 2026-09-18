// The function time limit on the page that serves the Extract Server
// Action. Next.js applies a page's maxDuration to the Server Actions used on
// it, so the limit must outlast a whole run, or the host kills the action
// mid-run and the reaper later charges the abandoned-run estimate; and it
// must end before the reaper could fail a run that is still in flight.
// Reads the page as text, since importing it would pull in server-only code.
// Needs no database.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EXTRACTION_LIMITS, PROVIDER_TIMEOUT_MS } from "@/lib/extraction/config";

const root = fileURLToPath(new URL("../..", import.meta.url));
const SEGMENT = "src/app/app/[slug]";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function maxDurationSeconds(): number {
  const page = readFileSync(join(root, SEGMENT, "page.tsx"), "utf8");
  const match = page.match(/^export const maxDuration = (\d+);$/m);
  if (!match) throw new Error(`${SEGMENT}/page.tsx has no literal maxDuration export`);
  return Number(match[1]);
}

describe("the Extract action's function time limit", () => {
  it("outlasts a whole run and ends before the stale-run reaper", () => {
    const runBoundSeconds = (EXTRACTION_LIMITS.maxCallsPerRun * PROVIDER_TIMEOUT_MS) / 1000;
    const reaperSeconds = EXTRACTION_LIMITS.staleRunMinutes * 60;
    expect(runBoundSeconds).toBe(180);
    expect(maxDurationSeconds()).toBeGreaterThan(runBoundSeconds);
    expect(maxDurationSeconds()).toBeLessThan(reaperSeconds);
  });

  it("is set on the only segment that uses the action", () => {
    const importers = sourceFiles(join(root, "src"))
      .filter((path) => readFileSync(path, "utf8").includes("@/app/app/extract-action"))
      .map((path) => relative(root, path));
    expect(importers.length).toBeGreaterThan(0);
    for (const path of importers) expect(path.startsWith(`${SEGMENT}/`)).toBe(true);
  });
});
