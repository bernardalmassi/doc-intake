// The eval report as Markdown tables, so a run's output can be pasted into
// EVALS.md as it is. Pure formatting over the scores in score.ts and the
// recordings; no decisions are made here.

import { computeCostUsd, type ProviderName } from "@/lib/extraction/config";
import { FIELD_NAMES } from "@/lib/extraction/schema";
import type { Replayed } from "./harness";
import { recordedLatencyMs } from "./harness";
import { judgeAttack } from "./judge";
import { calibration, type FieldResult, rate, tally } from "./score";

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
const frac = (results: readonly FieldResult[]) => {
  const t = tally(results);
  return `${t.correct}/${t.total} (${pct(rate(t))})`;
};

function table(header: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  return [line(header), line(header.map(() => "---")), ...rows.map(line)].join("\n");
}

export function accuracyReport(results: readonly FieldResult[], providers: readonly ProviderName[]): string {
  const of = (provider: ProviderName) => results.filter((r) => r.provider === provider);
  const byField = table(
    ["Field", ...providers],
    [
      ...FIELD_NAMES.map((name) => [
        name === "summary" ? "summary (presence)" : name,
        ...providers.map((p) => frac(of(p).filter((r) => r.field === name))),
      ]),
      ["**all fields**", ...providers.map((p) => `**${frac(of(p))}**`)],
      ["present in the document", ...providers.map((p) => frac(of(p).filter((r) => r.expected !== null)))],
      ["absent from the document", ...providers.map((p) => frac(of(p).filter((r) => r.expected === null)))],
      // the costly error: a wrong value in the high band is written with no
      // question and, if no other field is low, no review
      [
        "wrong and still high band",
        ...providers.map((p) => String(of(p).filter((r) => !r.correct && r.band === "high").length)),
      ],
    ],
  );
  return byField;
}

export function calibrationReport(results: readonly FieldResult[], providers: readonly ProviderName[]): string {
  const rows: string[][] = [];
  for (const provider of providers) {
    const c = calibration(results.filter((r) => r.provider === provider));
    for (const band of c.bands) {
      rows.push([provider, band.band, String(band.n), band.n ? pct(band.accuracy) : "-", band.n ? band.meanConfidence.toFixed(3) : "-"]);
    }
    rows.push([provider, "**all**", String(c.n), `ECE ${c.ece.toFixed(3)}`, `Brier ${c.brier.toFixed(3)}`]);
  }
  return table(["Provider", "Band", "Fields", "Accuracy", "Mean confidence"], rows);
}

export function missesReport(results: readonly FieldResult[]): string {
  const misses = results.filter((r) => !r.correct);
  if (misses.length === 0) return "No misses.";
  return table(
    ["Provider", "Fixture", "Field", "Expected", "Extracted", "Stored band (confidence)"],
    misses.map((r) => [
      r.provider,
      r.fixture,
      r.field,
      JSON.stringify(r.expected),
      JSON.stringify(r.got),
      r.band ? `${r.band} (${r.confidence})${r.flagged ? ", flagged" : ""}` : "run failed",
    ]),
  );
}

// Cost is what close_extraction_run would charge (the same formula),
// latency is the provider's time per run as recorded.
export function costReport(runs: readonly Replayed[], providers: readonly ProviderName[]): string {
  const rows = providers.map((provider) => {
    const mine = runs.filter((r) => r.provider === provider);
    const models = [...new Set(mine.map((r) => r.recording.reportedModel))].join(", ");
    let input = 0;
    let output = 0;
    let cost = 0;
    let calls = 0;
    const latencies: number[] = [];
    for (const run of mine) {
      for (const call of run.recording.calls) {
        const usage = call.response ?? call.error?.usage;
        calls += 1;
        if (!usage) continue;
        input += usage.inputTokens;
        output += usage.outputTokens;
        cost += computeCostUsd(usage.model, usage.inputTokens, usage.outputTokens);
      }
      latencies.push(recordedLatencyMs(run.recording));
    }
    const n = mine.length;
    const sorted = [...latencies].sort((a, b) => a - b);
    return [
      provider,
      models,
      String(n),
      String(calls),
      `${Math.round(input / n)} / ${Math.round(output / n)}`,
      `${(cost / n).toFixed(6)}`,
      `${cost.toFixed(6)}`,
      `${(sorted[Math.floor((n - 1) / 2)] / 1000).toFixed(1)} s`,
      `${(sorted[n - 1] / 1000).toFixed(1)} s`,
    ];
  });
  return table(
    ["Provider", "Model served", "Runs", "Calls", "Mean tokens in / out", "Mean cost (USD)", "Total cost (USD)", "Median latency", "Max latency"],
    rows,
  );
}

export function injectionReport(runs: readonly Replayed[]): string {
  const rows: string[][] = [];
  for (const run of runs.filter((r) => r.fixture.kind === "injection")) {
    const verdict = judgeAttack(run.fixture, run.provider, run.recording, run.outcome);
    const ends = verdict.targets.reduce<Record<string, number>>((acc, t) => ({ ...acc, [t.endState]: (acc[t.endState] ?? 0) + 1 }), {});
    rows.push([
      run.fixture.id,
      run.provider,
      verdict.modelFollowed ? "**followed**" : "resisted",
      Object.entries(ends)
        .map(([state, count]) => `${count} ${state}`)
        .join(", "),
      String(verdict.documentStatus ?? "run failed"),
    ]);
  }
  return table(["Fixture", "Provider", "Model's own answer", "Targeted fields, end state", "Document"], rows);
}
