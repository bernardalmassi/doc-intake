// /app's one motion is the landing's: what a line opens onto fades in,
// 120ms, ease-out, opacity only, and only under
// prefers-reduced-motion: no-preference, as the landing's readout arrives.
// Read from the stylesheets themselves. No browser.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (file: string) => readFileSync(join(root, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

const app = read("src/app/globals.css");
const landing = read("src/app/_landing/landing.module.css");

// the block of the first @media or @keyframes rule that starts with `head`
function block(css: string, head: RegExp): string {
  const match = head.exec(css);
  if (!match) throw new Error(`no ${head}`);
  let depth = 0;
  for (let i = css.indexOf("{", match.index); i < css.length; i++) {
    if (css[i] === "{") depth += 1;
    if (css[i] === "}" && --depth === 0) return css.slice(match.index, i + 1);
  }
  throw new Error(`unclosed ${head}`);
}

describe("/app's motion", () => {
  const landingArrive = /animation:\s*arrive\s+(\d+ms)\s+(ease-out)\s+both;/.exec(landing);
  const appArrive = /animation:\s*ledger-arrive\s+(\d+ms)\s+(ease-out)\s+both;/.exec(app);

  it("has the landing's duration and easing", () => {
    expect(landingArrive).not.toBeNull();
    expect(appArrive).not.toBeNull();
    expect(appArrive![1]).toBe(landingArrive![1]);
    expect(appArrive![2]).toBe(landingArrive![2]);
  });

  it("moves opacity only, as the landing's arrive does", () => {
    const keyframes = block(app, /@keyframes ledger-arrive/);
    expect(keyframes).toMatch(/opacity:\s*0/);
    expect(keyframes).not.toMatch(/transform|translate|scale/);
    const properties = [...keyframes.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);
    expect(new Set(properties)).toEqual(new Set(["opacity"]));
    expect(new Set([...block(landing, /@keyframes arrive/).matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]))).toEqual(
      new Set(["opacity"]),
    );
  });

  it("runs only under prefers-reduced-motion: no-preference, as the landing's does", () => {
    const appQuery = block(app, /@media \(prefers-reduced-motion: no-preference\)/);
    expect(appQuery).toContain("ledger-arrive");
    expect(app.replace(appQuery, "")).not.toMatch(/animation:\s*ledger-arrive/);
    const landingQuery = block(landing, /@media \(prefers-reduced-motion: no-preference\)/);
    expect(landingQuery).toMatch(/animation:\s*arrive/);
  });
});
