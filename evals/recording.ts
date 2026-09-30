// Record and replay of provider responses. A recording holds, for one
// fixture and one provider, every call runExtraction made (the first answer
// and, if it failed validation, the retry) with a fingerprint of the request
// that produced it. Replay serves those answers back through the same
// ExtractionProvider interface, so the orchestrator, validation, the output
// guard and gating run exactly as in production, offline and for free.
//
// Replay recomputes each request's fingerprint and refuses to answer a
// request that differs from the recorded one: a change to the system prompt,
// the user prompt, the schema, the output cap, the model, the fixture's
// bytes, or the retry turn makes the recording stale and fails loudly, so a
// prompt change can't pass CI on answers to the old prompt.
//
// What the fingerprint cannot see: how each provider module turns a request
// into its wire format (message order, SDK version). A change there needs a
// deliberate re-record.

import { createHash } from "node:crypto";
import { ANTHROPIC_THINKING, DEFAULT_MODELS, OPENAI_REASONING_EFFORT, type ProviderName, withCountMargin } from "@/lib/extraction/config";
import {
  type ExtractionProvider,
  type ExtractionRequest,
  ProviderError,
  type ProviderErrorKind,
  type ProviderResponse,
  type ProviderUsage,
} from "@/lib/extraction/providers/types";
import { ATTACHMENT_FILENAME } from "@/lib/extraction/schema";

export const RECORDING_VERSION = 1;

export const RE_RECORD_HINT = "re-record with npm run eval -- --live";

// Fingerprints -------------------------------------------------------------

function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

// JSON with sorted keys, so the same schema always hashes the same.
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export type FingerprintPart = "provider" | "file" | "systemPrompt" | "userPrompt" | "schema" | "maxOutputTokens" | "previousAttempt";

export type RequestFingerprint = {
  hash: string;
  parts: Record<FingerprintPart, string>;
};

// What each provider module adds to the request on its own, from config.
function providerSettings(provider: ProviderName, model: string): Record<string, string> {
  return provider === "openai"
    ? { provider, model, reasoningEffort: OPENAI_REASONING_EFFORT, attachmentFilename: ATTACHMENT_FILENAME }
    : { provider, model, thinking: ANTHROPIC_THINKING.type };
}

export function fingerprintRequest(provider: ProviderName, model: string, request: ExtractionRequest): RequestFingerprint {
  const parts: Record<FingerprintPart, string> = {
    provider: sha256(canonicalJson(providerSettings(provider, model))),
    file: sha256(`${request.mimeType}\n${sha256(request.bytes)}`),
    systemPrompt: sha256(request.systemPrompt),
    userPrompt: sha256(request.userPrompt),
    schema: sha256(canonicalJson(request.schema)),
    maxOutputTokens: sha256(String(request.maxOutputTokens)),
    previousAttempt: sha256(canonicalJson(request.previousAttempt ?? null)),
  };
  return { hash: sha256(canonicalJson(parts)), parts };
}

const PART_NAMES: Record<FingerprintPart, string> = {
  provider: "provider, model or provider settings",
  file: "fixture document",
  systemPrompt: "system prompt",
  userPrompt: "user prompt",
  schema: "output schema",
  maxOutputTokens: "output token cap",
  previousAttempt: "retry turn",
};

function changedParts(recorded: RequestFingerprint, current: RequestFingerprint): string[] {
  return (Object.keys(PART_NAMES) as FingerprintPart[])
    .filter((part) => recorded.parts[part] !== current.parts[part])
    .map((part) => PART_NAMES[part]);
}

// Recordings ---------------------------------------------------------------

// usage: what an unusable answer (a refusal, a truncation) was billed, so
// replay counts it exactly as the live run did; null when nothing answered.
export type RecordedError = {
  kind: ProviderErrorKind;
  status: number | null;
  message: string;
  usage: ProviderUsage | null;
};

export type RecordedCall = {
  fingerprint: RequestFingerprint;
  latencyMs: number;
  response: ProviderResponse | null;
  error: RecordedError | null;
};

export type Recording = {
  version: typeof RECORDING_VERSION;
  fixture: string;
  provider: ProviderName;
  // the model the request named, and the one the provider said it served
  requestedModel: string;
  reportedModel: string | null;
  recordedAt: string;
  calls: RecordedCall[];
};

export class StaleRecordingError extends Error {
  constructor(message: string) {
    super(`recording is stale: ${message}; ${RE_RECORD_HINT}`);
    this.name = "StaleRecordingError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// A recording read from disk is checked for shape, not trusted.
export function parseRecording(text: string, source: string): Recording {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed) || parsed.version !== RECORDING_VERSION || !Array.isArray(parsed.calls)) {
    throw new StaleRecordingError(`${source} is not a version ${RECORDING_VERSION} recording`);
  }
  for (const call of parsed.calls) {
    if (!isRecord(call) || !isRecord(call.fingerprint) || typeof call.fingerprint.hash !== "string") {
      throw new StaleRecordingError(`${source} has a call without a fingerprint`);
    }
    if ((call.response === null) === (call.error === null)) {
      throw new StaleRecordingError(`${source} has a call with neither or both of a response and an error`);
    }
  }
  return parsed as Recording;
}

export function serializeRecording(recording: Recording): string {
  return `${JSON.stringify(recording, null, 2)}\n`;
}

// Replay -------------------------------------------------------------------

export type ReplayProvider = ExtractionProvider & {
  // throws the first problem, or if the run made fewer calls than recorded
  assertComplete(): void;
  readonly problems: readonly StaleRecordingError[];
};

// Serves a recording's calls in order. The fingerprint is computed with the
// model the app would use today (config.ts), not the recorded one, so
// changing DEFAULT_MODELS makes every recording stale.
export function replayProvider(recording: Recording): ReplayProvider {
  const model = DEFAULT_MODELS[recording.provider];
  const label = `${recording.fixture} (${recording.provider})`;
  const problems: StaleRecordingError[] = [];
  let next = 0;

  // runExtraction turns a provider's exception into a failed outcome, so
  // the error is also kept here for assertComplete to rethrow.
  function fail(message: string): never {
    const error = new StaleRecordingError(`${label}: ${message}`);
    problems.push(error);
    throw error;
  }

  return {
    name: recording.provider,
    model,
    problems,
    // No count was recorded: a call's recorded input stands in for what the
    // count before it would have said, so replay checks the same per-call
    // limit a live run does (run.ts). The call's fingerprint is checked when
    // it is made.
    async countInputTokens() {
      const call = recording.calls[next];
      if (!call) fail(`the run counted call ${next + 1} but only ${recording.calls.length} were recorded`);
      return call.response?.inputTokens ?? call.error?.usage?.inputTokens ?? 0;
    },
    async extract(request) {
      const index = next;
      next += 1;
      const call = recording.calls[index];
      if (!call) fail(`the run made call ${index + 1} but only ${recording.calls.length} were recorded`);
      const current = fingerprintRequest(recording.provider, model, request);
      if (current.hash !== call.fingerprint.hash) {
        const changed = call.fingerprint.parts ? changedParts(call.fingerprint, current) : [];
        fail(`call ${index + 1} changed (${changed.length > 0 ? changed.join(", ") : "request fingerprint"})`);
      }
      if (call.error) {
        const { kind, message, status, usage } = call.error;
        throw new ProviderError(recording.provider, kind, message, status ?? undefined, usage ?? undefined);
      }
      return { ...(call.response as ProviderResponse) };
    },
    assertComplete() {
      if (problems.length > 0) throw problems[0];
      if (next < recording.calls.length) {
        throw new StaleRecordingError(`${label}: the run made ${next} calls but ${recording.calls.length} were recorded`);
      }
    },
  };
}

// Recording (live) ---------------------------------------------------------

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

// The only guard on live spend: these calls go straight to the providers
// and bypass the database's ceilings. Every call must reserve first; a
// reservation fails once the call count is reached or once the spend so far
// plus a worst-case call would pass the cap. It fails closed: a model it
// can't price (before or after the call) aborts the pass instead of
// counting as free. Once exceeded is set, every later reservation fails and
// the live runner stops.
export class CallBudget {
  calls = 0;
  spentUsd = 0;
  exceeded: BudgetExceededError | null = null;

  constructor(
    readonly maxCalls: number,
    readonly maxUsd: number,
    // what one call could cost at most, for a model, in USD
    private readonly worstCaseUsd: (model: string) => number,
  ) {}

  // Records why the pass must stop and returns the error to throw.
  abort(reason: string): BudgetExceededError {
    this.exceeded ??= new BudgetExceededError(reason);
    return this.exceeded;
  }

  reserve(model: string): void {
    if (this.exceeded) throw this.exceeded;
    let worst: number;
    try {
      worst = this.worstCaseUsd(model);
    } catch (error) {
      throw this.abort(`cannot estimate the cost of a call to ${model}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (this.calls >= this.maxCalls) {
      this.exceeded = new BudgetExceededError(`call cap reached: ${this.calls} of ${this.maxCalls} calls made`);
    } else if (this.spentUsd + worst > this.maxUsd) {
      this.exceeded = new BudgetExceededError(
        `cost cap: ${this.spentUsd.toFixed(6)} USD spent, a further call could cost up to ${worst.toFixed(6)}, cap ${this.maxUsd}`,
      );
    }
    if (this.exceeded) throw this.exceeded;
    this.calls += 1;
  }

  spend(usd: number): void {
    this.spentUsd += usd;
    if (this.spentUsd > this.maxUsd && !this.exceeded) {
      this.exceeded = new BudgetExceededError(`cost cap passed: ${this.spentUsd.toFixed(6)} USD of ${this.maxUsd}`);
    }
  }
}

export type RecordingProvider = ExtractionProvider & { readonly calls: RecordedCall[] };

// Wraps a real provider: reserves budget, forwards the request, charges
// what the provider reports it billed, and keeps the answer or the
// classified error with the request's fingerprint. A call that was sent and
// got no answer (an error with no HTTP status and no usage) may have been
// billed, so it is charged as run.ts charges it: the input its count just
// measured plus the output cap. Charging happens outside the provider's
// try, so a pricing failure can't be mistaken for a provider error and
// recorded at zero cost; it aborts the pass.
export function recordingProvider(
  inner: ExtractionProvider,
  budget: CallBudget,
  costOf: (usage: ProviderUsage) => number,
  now: () => number = Date.now,
): RecordingProvider {
  const calls: RecordedCall[] = [];
  // what the count before the latest call measured (run.ts counts every call)
  let lastCount: number | null = null;

  function charge(usage: ProviderUsage): void {
    let usd: number;
    try {
      usd = costOf(usage);
    } catch (error) {
      throw budget.abort(`cannot price ${usage.model}: ${error instanceof Error ? error.message : String(error)}`);
    }
    budget.spend(usd);
  }

  return {
    name: inner.name,
    model: inner.model,
    calls,
    // the provider's own count; no call is made, so nothing is reserved
    async countInputTokens(request) {
      lastCount = await inner.countInputTokens(request);
      return lastCount;
    },
    async extract(request) {
      const fingerprint = fingerprintRequest(inner.name, inner.model, request);
      budget.reserve(inner.model);
      const started = now();
      let response: ProviderResponse;
      try {
        response = await inner.extract(request);
      } catch (error) {
        const classified: RecordedError =
          error instanceof ProviderError
            ? { kind: error.kind, status: error.status ?? null, message: error.message, usage: error.usage ?? null }
            : { kind: "client", status: null, message: error instanceof Error ? error.message : String(error), usage: null };
        calls.push({ fingerprint, latencyMs: now() - started, response: null, error: classified });
        // an unusable answer is billed like any other, and a call with no
        // answer at the most it could have cost: its count with the count's
        // margin (withCountMargin, as run.ts charges it) and the output cap
        if (classified.usage) charge(classified.usage);
        else if (classified.status === null) {
          if (lastCount === null) throw budget.abort("a call was sent with no count before it");
          charge({ model: inner.model, inputTokens: withCountMargin(lastCount), outputTokens: request.maxOutputTokens });
        }
        throw error;
      }
      const latencyMs = now() - started;
      charge(response);
      calls.push({ fingerprint, latencyMs, response: { ...response }, error: null });
      return response;
    },
  };
}

// A recording whose run ended on a timeout, a 5xx, a refusal or a
// truncated answer says more about that moment than about the model; the
// live recorder treats it as stale so it is recorded again.
const TRANSIENT_ENDINGS: readonly ProviderErrorKind[] = ["transport", "server", "refusal", "truncated"];

export function endedAbnormally(recording: Recording): boolean {
  return recording.calls.some((call) => call.error !== null && TRANSIENT_ENDINGS.includes(call.error.kind));
}

export function toRecording(
  fixture: string,
  provider: RecordingProvider,
  recordedAt: Date,
): Recording {
  const answered = provider.calls.filter((call) => call.response !== null);
  return {
    version: RECORDING_VERSION,
    fixture,
    provider: provider.name,
    requestedModel: provider.model,
    reportedModel: answered.length > 0 ? (answered[answered.length - 1].response as ProviderResponse).model : null,
    recordedAt: recordedAt.toISOString(),
    calls: provider.calls,
  };
}
