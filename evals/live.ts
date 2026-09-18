// Live recording: sends fixtures to the real providers and writes what they
// answered to evals/recordings/. Only `npm run eval -- --live` reaches this
// module (the eval runner imports it dynamically in live mode), and only
// the eval vitest config loads the API keys, so replay, CI and the unit
// tests can't call a model.
//
// These calls bypass the database's spend ceilings, so the caps here are
// the only guard: one run per fixture per provider, at most
// 1 + MAX_VALIDATION_RETRIES calls per run, and a hard stop before any call
// that could take the cumulative estimated cost (computeCostUsd, the same
// formula the database uses) over LIVE_MAX_USD. Fixtures whose recordings
// replay cleanly are skipped unless --force is given, so a second
// invocation doesn't spend anything.

import { writeFileSync } from "node:fs";
import {
  computeCostUsd,
  DEFAULT_MODELS,
  MAX_OUTPUT_TOKENS,
  MAX_VALIDATION_RETRIES,
  type ProviderName,
} from "@/lib/extraction/config";
import { selectProviders } from "@/lib/extraction/providers/select";
import type { ExtractionProvider } from "@/lib/extraction/providers/types";
import { runExtraction } from "@/lib/extraction/run";
import type { Fixture } from "./fixtures";
import { committedPdf, PROVIDERS, recordingPath, replayFixture } from "./harness";
import { CallBudget, endedAbnormally, recordingProvider, serializeRecording, StaleRecordingError, toRecording } from "./recording";

export const LIVE_MAX_USD = 0.5;

// Well above a one- or two-page fixture (about 5 000 input tokens on
// Anthropic), so a reservation is conservative.
const WORST_CASE_INPUT_TOKENS = 20_000;

// A hard ceiling on calls whatever the fixture count.
const ABSOLUTE_MAX_CALLS = 60;

export type LiveResult = { recorded: string[]; skipped: string[]; calls: number; spentUsd: number };

// Fresh: replays cleanly and didn't end on a timeout, 5xx, refusal or
// truncation (endedAbnormally), which are worth another try.
async function isFresh(fixture: Fixture, provider: ProviderName): Promise<boolean> {
  try {
    const { recording } = await replayFixture(fixture, provider);
    return !endedAbnormally(recording);
  } catch (error) {
    if (error instanceof StaleRecordingError) return false;
    throw error;
  }
}

function realProviders(): Record<ProviderName, ExtractionProvider> {
  const { primary, fallback } = selectProviders();
  if (!fallback) throw new Error("live recording needs both ANTHROPIC_API_KEY and OPENAI_API_KEY in .env.local");
  const byName = { [primary.name]: primary, [fallback.name]: fallback } as Record<ProviderName, ExtractionProvider>;
  for (const name of PROVIDERS) {
    if (!byName[name]) throw new Error(`no ${name} provider configured`);
    if (byName[name].model !== DEFAULT_MODELS[name]) throw new Error(`${name} is not using ${DEFAULT_MODELS[name]}`);
  }
  return byName;
}

export async function recordLive(
  fixtures: readonly Fixture[],
  options: { force: boolean; log: (line: string) => void },
): Promise<LiveResult> {
  const todo: [Fixture, ProviderName][] = [];
  const skipped: string[] = [];
  for (const fixture of fixtures) {
    for (const provider of PROVIDERS) {
      if (!options.force && (await isFresh(fixture, provider))) skipped.push(`${fixture.id}.${provider}`);
      else todo.push([fixture, provider]);
    }
  }
  const maxCalls = Math.min(todo.length * (1 + MAX_VALIDATION_RETRIES), ABSOLUTE_MAX_CALLS);
  if (todo.length * (1 + MAX_VALIDATION_RETRIES) > ABSOLUTE_MAX_CALLS) {
    throw new Error(`${todo.length} runs could need more than ${ABSOLUTE_MAX_CALLS} calls; record fewer fixtures at once`);
  }
  if (todo.length === 0) return { recorded: [], skipped, calls: 0, spentUsd: 0 };

  const providers = realProviders();
  const budget = new CallBudget(maxCalls, LIVE_MAX_USD, (model) =>
    computeCostUsd(model, WORST_CASE_INPUT_TOKENS, MAX_OUTPUT_TOKENS),
  );
  options.log(`live: ${todo.length} runs, at most ${maxCalls} calls, cost cap ${LIVE_MAX_USD} USD`);

  const recorded: string[] = [];
  for (const [fixture, provider] of todo) {
    const recorder = recordingProvider(providers[provider], budget, (usage) =>
      computeCostUsd(usage.model, usage.inputTokens, usage.outputTokens),
    );
    const recordedAt = new Date();
    const outcome = await runExtraction({
      bytes: committedPdf(fixture),
      mimeType: "application/pdf",
      filename: `${fixture.id}.pdf`,
      primary: recorder,
      // one provider per recording
      fallback: null,
    });
    // a cap reached mid-run aborts everything; nothing half-recorded is kept
    if (budget.exceeded) throw budget.exceeded;
    writeFileSync(recordingPath(fixture, provider), serializeRecording(toRecording(fixture.id, recorder, recordedAt)));
    recorded.push(`${fixture.id}.${provider}`);
    options.log(
      `live: ${fixture.id} ${provider} -> ${outcome.status} (${recorder.calls.length} calls, ` +
        `${budget.spentUsd.toFixed(6)} USD so far)`,
    );
  }
  return { recorded, skipped, calls: budget.calls, spentUsd: budget.spentUsd };
}
