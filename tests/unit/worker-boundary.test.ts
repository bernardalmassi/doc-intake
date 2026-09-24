// What may touch the worker, and what the worker alone may hold
// (docs/worker-design.md, section 10). The worker (src/lib/extraction/
// worker.ts) holds the project's secret key, which runs as service_role and
// reads every tenant's files, so:
//
//   - only the worker route and the local test runner import it, in any of
//     src/, scripts/, evals/ and tests/ (resolved import paths, relative
//     and aliased alike; a comment may name the file)
//   - the secret key's and the bearer's variable names, and the names of
//     the two RPCs only service_role may call, appear in src/ only in it
//   - nothing in src/ calls the pre-queue RPCs any more
//   - it can't load into a client bundle: its first line is
//     import "server-only"
//   - the route exports nothing but POST and a literal maxDuration
//
// Reads the sources as text. Needs no database.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
const WORKER = "src/lib/extraction/worker.ts";
const ROUTE = "src/app/api/extraction-worker/route.ts";
const RUNNER = "tests/helpers/local-worker.ts";

function sourceFiles(dir: string): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(path);
    return /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name) ? [path] : [];
  });
}

const read = (path: string) => readFileSync(join(root, path), "utf8");

// Every module a file imports, re-exports, loads dynamically or mocks, as a
// repository path without its extension; packages are left out.
function importedPaths(path: string): string[] {
  const source = read(path);
  const specifiers = [
    ...source.matchAll(/\b(?:import|export)\b[^'"`;]*?\bfrom\s*["']([^"']+)["']/g),
    ...source.matchAll(/\bimport\s*["']([^"']+)["']/g),
    ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
    ...source.matchAll(/\b(?:vi\.mock|vi\.doMock|require)\s*\(\s*["']([^"']+)["']/g),
  ].map((match) => match[1]);
  return specifiers.flatMap((specifier) => {
    let target: string;
    if (specifier.startsWith("@/")) target = join("src", specifier.slice(2));
    else if (specifier.startsWith(".")) target = relative(root, resolve(root, dirname(path), specifier));
    else return [];
    return [target.replace(/\.(ts|tsx|mts|js|mjs)$/, "")];
  });
}

describe("the worker's boundary", () => {
  it("is imported only by the worker route and the local runner", () => {
    const files = ["src", "scripts", "evals", "tests"].flatMap(sourceFiles);
    expect(files.length).toBeGreaterThan(50);
    const importers = files.filter((path) => importedPaths(path).includes(WORKER.replace(/\.ts$/, "")));
    expect(importers.sort()).toEqual([ROUTE, RUNNER].sort());
  });

  it("alone in src/ names the secret key, the bearer, and the worker's RPCs", () => {
    const names = ["SUPABASE_SECRET_KEY", "EXTRACTION_WORKER_SECRET", '"claim_extraction_run"', '"finish_extraction_run"'];
    const files = sourceFiles("src");
    for (const name of names) {
      const naming = files.filter((path) => read(path).includes(name));
      expect(naming, name).toEqual([WORKER]);
    }
  });

  it("leaves nothing in src/ calling the pre-queue RPCs", () => {
    for (const path of sourceFiles("src")) {
      expect(read(path), path).not.toMatch(/["'`](open|close)_extraction_run["'`]/);
    }
  });

  it("keeps the worker out of any client bundle", () => {
    expect(read(WORKER).split("\n")[0]).toBe('import "server-only";');
  });

  it("gives the route no export but POST and a literal maxDuration", () => {
    const exports = read(ROUTE)
      .split("\n")
      .filter((line) => /^\s*export\b/.test(line));
    expect(exports).toHaveLength(2);
    expect(exports).toContainEqual(expect.stringMatching(/^export const maxDuration = \d+;$/));
    expect(exports).toContainEqual(expect.stringMatching(/^export async function POST\(request: Request\): Promise<Response> \{$/));
  });
});
