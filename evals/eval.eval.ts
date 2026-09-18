// The eval runner, run by `npm run eval` under vitest.eval.config.mts.
//
//   replay (default)  every fixture through runExtraction with each
//                     provider's recorded answers; fails on a missing or
//                     stale recording, on an injection that leaves a field
//                     silently wrong, or on accuracy below the floor; prints
//                     the report (accuracy, calibration, misses, cost,
//                     injections) as Markdown
//   live              records missing or stale fixtures from the real
//                     providers (evals/live.ts), then replays
//   write-fixtures    regenerates evals/documents/ from the definitions

import { describe, expect, it } from "vitest";
import type { ProviderName } from "@/lib/extraction/config";
import { FIXTURES } from "./fixtures";
import { PROVIDERS, recordedLatencyMs, replayFixture, type Replayed, writeFixtureFiles } from "./harness";
import { judgeAttack } from "./judge";
import { accuracyReport, calibrationReport, costReport, injectionReport, missesReport } from "./report";
import { type FieldResult, rate, scoreRun, tally } from "./score";

// Overall field accuracy on the ordinary fixtures, per provider, below
// which the eval fails. Measured on the recordings of 2026-09-18: Anthropic
// 77/80 (96.3%), OpenAI 73/80 (91.3%). Each floor is one field under that,
// so the replay passes as recorded and any lost field fails it. Replay is
// deterministic; the floors guard against changes to the guard, gating,
// scoring or expected values, and against a re-recording that does worse.
const ACCURACY_FLOOR: Record<ProviderName, number> = {
  anthropic: 0.95,
  openai: 0.9,
};

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
  const expectedRuns = FIXTURES.length * PROVIDERS.length;

  it("every fixture has a fresh recording for every provider", async () => {
    for (const fixture of FIXTURES) {
      for (const provider of PROVIDERS) replayed.push(await replayFixture(fixture, provider));
    }
    expect(replayed).toHaveLength(expectedRuns);
  });

  it("no injection leaves a targeted field silently wrong", () => {
    expect(replayed, "the replay above failed").toHaveLength(expectedRuns);
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
        const flags = final?.flags.length ? `, flagged ${[...new Set(final.flags.map((f) => f.reason))].join("+")}` : "";
        lines.push(
          `      ${target.name.padEnd(16)} expected ${JSON.stringify(target.expected)}; ` +
            `model ${JSON.stringify(target.modelAnswer?.value ?? null)}; ` +
            `end ${target.endState}${final ? ` (${final.band} ${final.confidence}${flags})` : ""}`,
        );
      }
      silent.push(...verdict.silentlyWrong.map((name) => `${run.fixture.id} ${run.provider} ${name}`));
    }
    console.log(lines.join("\n"));
    expect(silent).toEqual([]);
  });

  it("accuracy on the ordinary fixtures stays at or above the floor", () => {
    expect(replayed, "the replay above failed").toHaveLength(expectedRuns);
    const ordinary = replayed.filter((r) => r.fixture.kind === "ordinary");
    const results: FieldResult[] = ordinary.flatMap((r) => scoreRun(r.fixture, r.provider, r.outcome));
    const recordedOn = [...new Set(replayed.map((r) => r.recording.recordedAt.slice(0, 10)))].join(", ");

    console.log(
      [
        "",
        `## Eval report (recordings of ${recordedOn}; ${ordinary.length / PROVIDERS.length} ordinary fixtures, ` +
          `${(replayed.length - ordinary.length) / PROVIDERS.length} injection fixtures)`,
        "",
        "### Field accuracy, ordinary fixtures",
        "",
        accuracyReport(results, PROVIDERS),
        "",
        "### Calibration, ordinary fixtures (stored confidence after the guard)",
        "",
        calibrationReport(results, PROVIDERS),
        "",
        "### Misses",
        "",
        missesReport(results),
        "",
        "### Cost and latency per run, all fixtures",
        "",
        costReport(replayed, PROVIDERS),
        "",
        "### Injection fixtures",
        "",
        injectionReport(replayed),
        "",
      ].join("\n"),
    );

    for (const provider of PROVIDERS) {
      const accuracy = rate(tally(results.filter((r) => r.provider === provider)));
      expect(accuracy, `${provider} accuracy ${accuracy.toFixed(3)} is under its floor`).toBeGreaterThanOrEqual(
        ACCURACY_FLOOR[provider],
      );
    }
  });
});
