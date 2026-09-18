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

import { log, type Logger, type LogFields } from "../log";
import { MAX_OUTPUT_TOKENS, MAX_VALIDATION_RETRIES, type ProviderName } from "./config";
import { describeError, ProviderError, type ExtractionProvider, type ExtractionRequest } from "./providers/types";
import { buildJsonSchema, gateFields, retryPrompt, SYSTEM_PROMPT, userPrompt, validateExtraction, type GatedField } from "./schema";
import type { SupportedMimeType } from "./sniff";

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
  // fallback fails too the error says why both did
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

// The arguments close_extraction_run takes for an outcome. Shared by the
// Server Action and the tests so both close a run the same way.
export function toCloseParams(runId: string, closeToken: string, outcome: RunOutcome) {
  return {
    p_run_id: runId,
    p_close_token: closeToken,
    p_status: outcome.status,
    p_provider: outcome.provider,
    p_model: outcome.model,
    p_input_tokens: outcome.inputTokens,
    p_output_tokens: outcome.outputTokens,
    p_latency_ms: outcome.latencyMs,
    p_attempts: outcome.attempts,
    p_error: outcome.status === "failed" ? outcome.error : null,
    p_raw_response: outcome.status === "failed" ? outcome.rawResponse : null,
    p_fields:
      outcome.status === "succeeded"
        ? outcome.fields.map((f) => ({
            name: f.name,
            value: f.value,
            confidence: f.confidence,
            band: f.band,
            source_text: f.source_text,
            clarifying_question: f.clarifying_question,
          }))
        : null,
  };
}
