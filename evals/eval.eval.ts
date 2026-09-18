// The eval runner, run by `npm run eval` under vitest.eval.config.mts.
//
//   replay (default)  every fixture through runExtraction with each
//                     provider's recorded answers; fails on a missing or
//                     stale recording; prints how each injection fared
//   live              records missing or stale fixtures from the real
//                     providers (evals/live.ts), then replays
//   write-fixtures    regenerates evals/documents/ from the definitions

import { describe, expect, it } from "vitest";
import { FIXTURES } from "./fixtures";
import { PROVIDERS, recordedLatencyMs, replayFixture, type Replayed, writeFixtureFiles } from "./harness";
import { judgeAttack } from "./judge";

const MODE = process.env.EVAL_MODE ?? "replay";

describe.runIf(MODE === "write-fixtures")("fixture files", () => {
  it("regenerates every fixture's PDF and expected fields", () => {
    const written = writeFixtureFiles();
    console.log(`wrote ${written.length} fixtures to evals/documents/: ${written.join(", ")}`);
  });
});

describe.runIf(MODE === "live")("live recording", () => {
  it("records every fixture whose recording is missing or stale", async () => {
    // imported here so replay never loads the provider modules
    const { recordLive } = await import("./live");
    const result = await recordLive(FIXTURES, { force: process.env.EVAL_FORCE === "1", log: console.log });
    console.log(
      `live: recorded ${result.recorded.length}, skipped ${result.skipped.length} fresh, ` +
        `${result.calls} calls, ${result.spentUsd.toFixed(6)} USD estimated`,
    );
  });
});

describe.runIf(MODE === "replay" || MODE === "live")("replay", () => {
  const replayed: Replayed[] = [];

  it("every fixture has a fresh recording for every provider", async () => {
    for (const fixture of FIXTURES) {
      for (const provider of PROVIDERS) replayed.push(await replayFixture(fixture, provider));
    }
    expect(replayed).toHaveLength(FIXTURES.length * PROVIDERS.length);
  });

  it("no injection leaves a targeted field silently wrong", () => {
    expect(replayed, "the replay above failed").toHaveLength(FIXTURES.length * PROVIDERS.length);
    const lines = ["", "Injection fixtures (model: what the model's own answer did; end: after guard and gating)"];
    const silent: string[] = [];
    for (const run of replayed.filter((r) => r.fixture.kind === "injection")) {
      const verdict = judgeAttack(run.fixture, run.provider, run.recording, run.outcome);
      lines.push(
        `  ${run.fixture.id.padEnd(18)} ${run.provider.padEnd(9)} ${String(run.recording.reportedModel).padEnd(26)} ` +
          `run ${verdict.runStatus.padEnd(9)} doc ${String(verdict.documentStatus).padEnd(12)} ` +
          `model ${verdict.modelFollowed ? "FOLLOWED" : "resisted"}  ${recordedLatencyMs(run.recording)} ms`,
      );
      for (const target of verdict.targets) {
        const final = target.final;
        lines.push(
          `      ${target.name.padEnd(16)} expected ${JSON.stringify(target.expected).padEnd(38)} ` +
            `model ${JSON.stringify(target.modelAnswer?.value ?? null).padEnd(38)} ` +
            `end ${target.endState}${final ? ` (${final.band} ${final.confidence}${final.flags.length ? `, flagged ${[...new Set(final.flags.map((f) => f.reason))].join("+")}` : ""})` : ""}`,
        );
      }
      silent.push(...verdict.silentlyWrong.map((name) => `${run.fixture.id} ${run.provider} ${name}`));
    }
    console.log(lines.join("\n"));
    expect(silent).toEqual([]);
  });
});
