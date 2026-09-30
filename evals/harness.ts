// Where fixture files and recordings live, and how one fixture is replayed
// through the real orchestrator. Shared by the eval runner and the unit
// tests; imports nothing that holds a secret or calls a network.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FIELD_NAMES } from "@/lib/extraction/schema";
import type { ProviderName } from "@/lib/extraction/config";
import { runExtraction, type RunOutcome } from "@/lib/extraction/run";
import { FIXTURES, type Fixture } from "./fixtures";
import { buildPdf } from "./pdf";
import { parseRecording, type Recording, replayProvider, StaleRecordingError } from "./recording";

export const PROVIDERS: readonly ProviderName[] = ["anthropic", "openai"];

const DOCUMENTS_DIR = fileURLToPath(new URL("./documents/", import.meta.url));
const RECORDINGS_DIR = fileURLToPath(new URL("./recordings/", import.meta.url));

export function documentPath(fixture: Fixture): string {
  return `${DOCUMENTS_DIR}${fixture.id}.pdf`;
}

export function expectedPath(fixture: Fixture): string {
  return `${DOCUMENTS_DIR}${fixture.id}.expected.json`;
}

export function recordingPath(fixture: Fixture, provider: ProviderName): string {
  return `${RECORDINGS_DIR}${fixture.id}.${provider}.json`;
}

// Generated files -----------------------------------------------------------

export function generatePdf(fixture: Fixture): Uint8Array {
  return buildPdf(fixture.pages);
}

export function generateExpectedJson(fixture: Fixture): string {
  const ordered = Object.fromEntries(FIELD_NAMES.map((name) => [name, fixture.expected[name] ?? null]));
  const body = {
    fixture: fixture.id,
    kind: fixture.kind,
    description: fixture.description,
    ...(fixture.attack ? { attack: fixture.attack } : {}),
    expected: ordered,
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

export function writeFixtureFiles(fixtures: readonly Fixture[] = FIXTURES): string[] {
  const written: string[] = [];
  for (const fixture of fixtures) {
    writeFileSync(documentPath(fixture), generatePdf(fixture));
    writeFileSync(expectedPath(fixture), generateExpectedJson(fixture));
    written.push(fixture.id);
  }
  return written;
}

// The bytes that were sent to the providers when the fixture was recorded.
export function committedPdf(fixture: Fixture): Uint8Array {
  return new Uint8Array(readFileSync(documentPath(fixture)));
}

// Replay ---------------------------------------------------------------------

export function loadRecording(fixture: Fixture, provider: ProviderName): Recording {
  const path = recordingPath(fixture, provider);
  if (!existsSync(path)) {
    throw new StaleRecordingError(`${fixture.id} (${provider}) has no recording at evals/recordings/`);
  }
  const recording = parseRecording(readFileSync(path, "utf8"), path);
  if (recording.fixture !== fixture.id || recording.provider !== provider) {
    throw new StaleRecordingError(`${path} is for ${recording.fixture} (${recording.provider})`);
  }
  return recording;
}

export type Replayed = { fixture: Fixture; provider: ProviderName; recording: Recording; outcome: RunOutcome };

// One fixture through runExtraction with its recorded answers, fallback off
// (each recording is one provider). Throws StaleRecordingError if the
// recording is missing, malformed, or doesn't match today's requests.
export async function replayFixture(fixture: Fixture, provider: ProviderName): Promise<Replayed> {
  const recording = loadRecording(fixture, provider);
  const replay = replayProvider(recording);
  const outcome = await runExtraction({
    bytes: committedPdf(fixture),
    mimeType: "application/pdf",
    filename: `${fixture.id}.pdf`,
    pages: fixture.pages.length,
    primary: replay,
    fallback: null,
  });
  replay.assertComplete();
  return { fixture, provider, recording, outcome };
}

// Total latency the provider took across the run's calls when recorded.
export function recordedLatencyMs(recording: Recording): number {
  return recording.calls.reduce((sum, call) => sum + call.latencyMs, 0);
}
