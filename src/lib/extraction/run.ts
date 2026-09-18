// The model-call loop for one run. Takes providers as arguments so it can be
// tested with fakes; the Server Action supplies the real ones.
//
//   1. call the primary provider
//   2. on a timeout or 5xx, call the fallback provider instead: once per
//      run, and only before any provider has answered. If the fallback
//      fails too, the run's error names both failures
//   3. validate the answer against the schema and formats
//   4. if invalid, ask the provider that answered once more, with the
//      validation error; if that retry fails in any way, so does the run
//   5. still invalid: the run fails and the last raw answer is kept
//
// Never switching after an answer means every token a run counts comes from
// one model, the one close_extraction_run prices the whole run at. It also
// bounds a run at three calls (primary times out, fallback answers invalid,
// fallback retried); tests/unit/orchestrator.test.ts checks every
// combination. The database's bounds on a run, its attempts check and token
// clamp, allow four.
//
// Every answer's tokens are counted: valid ones, invalid ones that were
// retried, and unusable ones (a refusal, an answer cut off at the output
// cap), which arrive as a ProviderError carrying the call's usage, because
// every answer is billed. A call that gets no answer (a timeout, a 5xx)
// reports no usage and adds nothing. The cost itself is computed by the
// database at close from these counts and its price table.
//
// Each call, fallback, retry and the finish writes one log line of ids,
// counts and error kinds (src/lib/log.ts). Never a field value, the file
// name, the model's answer or an error message.

import { RUN_ERROR_MARKERS } from "../errors";
import { log, type Logger, type LogFields } from "../log";
import { redact } from "../redact";
import { MAX_OUTPUT_TOKENS, MAX_VALIDATION_RETRIES, type ProviderName } from "./config";
import { describeError, ProviderError, type ExtractionProvider, type ExtractionRequest } from "./providers/types";
import { buildJsonSchema, gateFields, retryPrompt, SYSTEM_PROMPT, userPrompt, validateExtraction, type GatedField } from "./schema";
import type { SupportedMimeType } from "./sniff";
import { databaseText } from "./text";

export type RunInput = {
  bytes: Uint8Array;
  mimeType: SupportedMimeType;
  // Never sent to a provider: any member can choose or rename it, so it is
  // attacker-controlled. Kept only so the caller's signature is unchanged.
  filename: string;
  primary: ExtractionProvider;
  fallback: ExtractionProvider | null;
  // ids put on every log line of this run; optional so callers that don't
  // have them yet still compile
  logContext?: Pick<LogFields, "run_id" | "document_id" | "tenant_id">;
};

type Usage = {
  provider: ProviderName | null;
  model: string | null;
  attempts: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
};

export type RunOutcome =
  | (Usage & { status: "succeeded"; fields: GatedField[]; documentStatus: "extracted" | "needs_review" })
  | (Usage & { status: "failed"; error: string; rawResponse: string | null });

// A call's answer, or what to record as the run's error.
type CallResult = { ok: true; text: string } | { ok: false; error: string };

// The run's error goes into a 2000-character column and is shown to admins.
// It is built from at most three pieces of outside text (a validation error,
// the primary's failure, the fallback's), each clipped to this, so it always
// fits and no piece crowds out the others. An HTML error page from a proxy
// is the usual reason a piece is long.
const MAX_ERROR_PIECE_LENGTH = 500;

function clip(text: string): string {
  return text.length > MAX_ERROR_PIECE_LENGTH ? `${text.slice(0, MAX_ERROR_PIECE_LENGTH - 3)}...` : text;
}

// what a return site supplies; finish adds the usage
type Ending = RunOutcome extends infer O ? (O extends Usage ? Omit<O, keyof Usage> : never) : never;

// what a log line may say about a failed call
type CallFailure = Pick<LogFields, "error_kind" | "error_name" | "http_status">;

export async function runExtraction(input: RunInput): Promise<RunOutcome> {
  const startedAt = Date.now();
  const usage: Usage = {
    provider: null,
    model: null,
    attempts: 0,
    inputTokens: 0,
    outputTokens: 0,
    latencyMs: 0,
  };
  const runLog = log.with(input.logContext ?? {});
  // the last call's failure, for the finish line; null once a call succeeds
  let lastFailure: CallFailure | null = null;
  const finish = (ending: Ending): RunOutcome => {
    const outcome: RunOutcome = { ...usage, latencyMs: Date.now() - startedAt, ...ending };
    logFinished(runLog, outcome, fallbackUsed, lastFailure);
    return outcome;
  };

  const schema = buildJsonSchema();
  const base: ExtractionRequest = {
    bytes: input.bytes,
    mimeType: input.mimeType,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: userPrompt(),
    schema,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  };

  let provider = input.primary;
  let fallbackUsed = false;
  // set once a provider has answered, usable or not; from then on the run
  // stays with it
  let answered = false;
  // kept once the run has switched away from the primary, so that if the
  // fallback fails too the error says why both did; cleared once an answer
  // arrives, so a later failed retry isn't reported as a double failure
  let primaryFailure: string | null = null;

  // One call, switching to the fallback provider if the current one times
  // out or returns a 5xx and no provider has answered yet. Records usage
  // whatever happens.
  async function call(request: ExtractionRequest): Promise<CallResult> {
    for (;;) {
      usage.attempts += 1;
      usage.provider = provider.name;
      // once a provider has answered, keep the model it said served the
      // tokens counted so far
      if (!answered) usage.model = provider.model;
      const callStartedAt = Date.now();
      try {
        const response = await provider.extract(request);
        answered = true;
        primaryFailure = null;
        usage.model = response.model;
        usage.inputTokens += response.inputTokens;
        usage.outputTokens += response.outputTokens;
        lastFailure = null;
        runLog.info("extraction.call_succeeded", {
          provider: provider.name,
          model: response.model,
          attempt: usage.attempts,
          input_tokens: response.inputTokens,
          output_tokens: response.outputTokens,
          latency_ms: Date.now() - callStartedAt,
        });
        return { ok: true, text: response.text };
      } catch (error) {
        // an unusable answer (a refusal, a truncated answer) was billed too
        const billed = error instanceof ProviderError ? error.usage : undefined;
        if (billed) {
          answered = true;
          usage.model = billed.model;
          usage.inputTokens += billed.inputTokens;
          usage.outputTokens += billed.outputTokens;
        }
        lastFailure = callFailure(error);
        runLog.warn("extraction.call_failed", {
          provider: provider.name,
          model: billed?.model ?? provider.model,
          attempt: usage.attempts,
          latency_ms: Date.now() - callStartedAt,
          ...(billed ? { input_tokens: billed.inputTokens, output_tokens: billed.outputTokens } : {}),
          ...lastFailure,
        });
        const failure = clip(describeError(error));
        if (!answered && error instanceof ProviderError && error.fallbackEligible) {
          if (input.fallback && !fallbackUsed) {
            runLog.warn("extraction.fallback", { from_provider: provider.name, to_provider: input.fallback.name, ...lastFailure });
            fallbackUsed = true;
            primaryFailure = failure;
            provider = input.fallback;
            continue;
          }
          if (!input.fallback) return { ok: false, error: `${failure}; no fallback provider is configured` };
        }
        return { ok: false, error: primaryFailure ? `${primaryFailure}; fallback ${failure}` : failure };
      }
    }
  }

  const first = await call(base);
  if (!first.ok) return finish({ status: "failed", error: first.error, rawResponse: null });
  let text = first.text;

  let result = validateExtraction(text);
  let retries = 0;
  while (!result.ok && retries < MAX_VALIDATION_RETRIES) {
    retries += 1;
    const invalidError = result.error;
    // the validation error can quote the model's answer, so not in the log
    runLog.warn("extraction.validation_retry", { provider: provider.name, retry: retries, error_kind: "validation" });
    const retried = await call({
      ...base,
      previousAttempt: { rawResponse: text, retryPrompt: retryPrompt(invalidError) },
    });
    if (!retried.ok) {
      return finish({
        status: "failed",
        error: `retry after invalid response (${clip(invalidError)}) failed: ${retried.error}`,
        rawResponse: text,
      });
    }
    text = retried.text;
    result = validateExtraction(text);
  }

  if (!result.ok) {
    return finish({
      status: "failed",
      error: `response failed validation after ${retries} retry: ${result.error}`.slice(0, 2000),
      rawResponse: text,
    });
  }

  const gated = gateFields(result.fields);
  return finish({ status: "succeeded", fields: gated.fields, documentStatus: gated.documentStatus });
}

function callFailure(error: unknown): CallFailure {
  if (error instanceof ProviderError) return { error_kind: error.kind, http_status: error.status ?? null };
  return { error_kind: "unexpected", error_name: error instanceof Error ? error.name : null };
}

// One line per run: usage, the band counts and the document's new status on
// success, the last failure's kind otherwise. Counts, not fields.
function logFinished(logger: Logger, outcome: RunOutcome, fallbackUsed: boolean, failure: CallFailure | null): void {
  const common: LogFields = {
    run_status: outcome.status,
    provider: outcome.provider,
    model: outcome.model,
    attempts: outcome.attempts,
    input_tokens: outcome.inputTokens,
    output_tokens: outcome.outputTokens,
    latency_ms: outcome.latencyMs,
    fallback_used: fallbackUsed,
  };
  if (outcome.status === "succeeded") {
    const bands = { high: 0, medium: 0, low: 0 };
    for (const field of outcome.fields) bands[field.band] += 1;
    logger.info("extraction.run_finished", {
      ...common,
      field_count: outcome.fields.length,
      high_count: bands.high,
      medium_count: bands.medium,
      low_count: bands.low,
      document_status: outcome.documentStatus,
    });
  } else {
    // a failed run whose last call succeeded failed validation
    logger.warn("extraction.run_finished", { ...common, ...(failure ?? { error_kind: "validation" }) });
  }
}

// The checks on extraction_runs and extracted_fields
// (supabase/migrations/20260918000001). A close that breaks one, or that
// sends a U+0000 or an unpaired surrogate (Postgres refuses both in text and
// jsonb), is refused whole: the run stays running, unmetered, until the
// reaper fails it with no cost.
const CLOSE_TEXT_LIMITS = { error: 2000, rawResponse: 100_000, value: 4000, sourceText: 4000, question: 1000 } as const;

function closeText(text: string | null, max?: number): string | null {
  return text === null ? null : databaseText(text, max);
}

function failureText(error: string): string {
  const scrubbed = databaseText(redact(error));
  return scrubbed.trim().length > 0 ? scrubbed : "unknown error";
}

// The arguments close_extraction_run takes for an outcome. Shared by the
// Server Action and the tests so both close a run the same way. Validation
// already cleaned what the model wrote; every string is made NUL-free, well
// formed and within its column here again, whatever produced it (an error
// message, a raw answer that failed validation), so the close can't be
// refused over text.
export function toCloseParams(runId: string, closeToken: string, outcome: RunOutcome) {
  const limits = CLOSE_TEXT_LIMITS;
  return {
    p_run_id: runId,
    p_close_token: closeToken,
    p_status: outcome.status,
    p_provider: outcome.provider,
    p_model: closeText(outcome.model),
    p_input_tokens: outcome.inputTokens,
    p_output_tokens: outcome.outputTokens,
    p_latency_ms: outcome.latencyMs,
    p_attempts: outcome.attempts,
    // scrubbed here too, not only in describeError, because a caller can
    // build an error from other text (the Server Action's download error);
    // never blank, which the RPC refuses for a failed run (it trims)
    p_error: outcome.status === "failed" ? closeText(failureText(outcome.error), limits.error) : null,
    p_raw_response: outcome.status === "failed" ? closeText(outcome.rawResponse, limits.rawResponse) : null,
    p_fields:
      outcome.status === "succeeded"
        ? outcome.fields.map((f) => ({
            name: f.name,
            value: closeText(f.value, limits.value),
            confidence: f.confidence,
            band: f.band,
            source_text: closeText(f.source_text, limits.sourceText),
            clarifying_question: closeText(f.clarifying_question, limits.question),
          }))
        : null,
  };
}

// What to close a run with when close_extraction_run refused to record its
// outcome: a model it has no price for, a check this code doesn't know, a
// dropped connection. A refused close changes nothing, so the run is still
// open and its token still valid; closing it as failed with no fields puts
// the document back to how it was instead of leaving it in processing
// until the stale-run reaper frees it. First with the run's usage, so its
// spend is recorded; then, if the run had any, without a model or token
// counts, which the close accepts for any run. A failed run keeps its own
// error; a successful one's fields are lost, and its error says so with the
// SQLSTATE of the refusal (never its message), for classifyRunError.
export function failedCloseAttempts(outcome: RunOutcome, sqlState: string | null): RunOutcome[] {
  const error =
    outcome.status === "failed"
      ? outcome.error
      : `${RUN_ERROR_MARKERS.resultNotRecorded}: ${sqlState ?? "no answer from the database"}`;
  const usage: Usage = {
    provider: outcome.provider,
    model: outcome.model,
    attempts: outcome.attempts,
    inputTokens: outcome.inputTokens,
    outputTokens: outcome.outputTokens,
    latencyMs: outcome.latencyMs,
  };
  const withUsage: RunOutcome = { ...usage, status: "failed", error, rawResponse: null };
  if (usage.model === null && usage.inputTokens === 0 && usage.outputTokens === 0) return [withUsage];
  return [withUsage, { ...withUsage, provider: null, model: null, inputTokens: 0, outputTokens: 0 }];
}
