// The model-call loop for one run. Takes providers as arguments so it can be
// tested with fakes; the queue worker (extraction/delivery.ts) supplies the
// real ones.
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
// No call is sent until its input has been measured with the provider's
// token counting endpoint and fits inputTokensPerCall for the document's
// pages (config.ts), the per-call input the run's estimate assumes while it
// is in flight (private.abandoned_estimate). A first call over it sends
// nothing and fails the run as too dense, at 0 USD. A count that fails
// sends nothing either: on the primary's first call a timeout or 5xx
// switches to the fallback like a failed call, and a fallback that can't
// be measured, or measures over the bound, isn't used. A retry over the
// bound isn't sent, and the run fails with the invalid answer.
//
// Never switching after an answer bounds a run at three calls (primary
// gets no answer, fallback answers invalid, fallback retried);
// tests/unit/orchestrator.test.ts checks every combination. The database's
// bounds on a run, its attempts check and token clamp, allow four.
//
// Every answer's tokens are counted: valid ones, invalid ones that were
// retried, and unusable ones (a refusal, an answer cut off at the output
// cap), which arrive as a ProviderError carrying the call's usage, because
// every answer is billed. A call that was sent and got no answer back (a
// timeout, a dropped connection, anything thrown without an HTTP status)
// may still have been processed and billed, so it counts at the most it
// could have cost: its measured input and the output cap, at the model it
// was sent to. A call the provider refused with an HTTP status (a 4xx, a
// 5xx) was not processed and adds nothing.
//
// finish_extraction_run prices a run at one model. When every token comes
// from one model, that is the model. When a run has tokens from two (a
// primary that got no answer, then the fallback), all of them are priced at
// whichever of the two makes them cost the most, and the run is marked as
// estimated, as it is whenever a call was counted at its maximum. The cost
// itself is computed by the database at close from these counts and its
// price table.
//
// Each call, fallback, retry and the finish writes one log line of ids,
// counts and error kinds (src/lib/log.ts). Never a field value, the file
// name, the model's answer or an error message.

import { RUN_ERROR_MARKERS } from "../errors";
import { log, type Logger, type LogFields } from "../log";
import { redact } from "../redact";
import {
  dearestModelFor,
  inputTokensPerCall,
  MAX_OUTPUT_TOKENS,
  MAX_VALIDATION_RETRIES,
  priceForModel,
  PRICING,
  type ProviderName,
} from "./config";
import { describeError, ProviderError, type ExtractionProvider, type ExtractionRequest } from "./providers/types";
import { buildJsonSchema, gateFields, retryPrompt, SYSTEM_PROMPT, userPrompt, validateExtraction, type GatedField } from "./schema";
import type { SupportedMimeType } from "./sniff";
import { databaseText } from "./text";

export type RunInput = {
  bytes: Uint8Array;
  mimeType: SupportedMimeType;
  // Never sent to a provider: any member can choose or rename it, so it is
  // attacker-controlled. The worker doesn't pass one; tests do, to prove it
  // goes nowhere.
  filename?: string;
  // the document's pages, as the worker counted them in its preflight:
  // every call's input must fit inputTokensPerCall(pages)
  pages: number;
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
  // the cost the database will compute from these counts is an estimate,
  // never less than the real one: a call counted at its maximum, or tokens
  // from two models priced at the dearer's rates. The ledger records it as
  // kind 'estimate' (finish_extraction_run's p_cost_estimated).
  costEstimated: boolean;
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
  // the provider last called and the model it was asked for, recorded if
  // no call billed anything
  let attempted: { provider: ProviderName | null; model: string | null } = { provider: null, model: null };
  let attempts = 0;
  // the tokens each model billed: under the id the provider reported, or,
  // for a call that got no answer, the id it was sent to
  const billed = new Map<string, { provider: ProviderName; inputTokens: number; outputTokens: number }>();
  // a call counted at its maximum
  let countedAtMost = false;
  const bill = (provider: ProviderName, model: string, inputTokens: number, outputTokens: number) => {
    const entry = billed.get(model) ?? { provider, inputTokens: 0, outputTokens: 0 };
    entry.inputTokens += inputTokens;
    entry.outputTokens += outputTokens;
    billed.set(model, entry);
  };
  const runLog = log.with(input.logContext ?? {});
  // the last call's failure, for the finish line; null once a call succeeds
  let lastFailure: CallFailure | null = null;
  const finish = (ending: Ending): RunOutcome => {
    const recorded = recordedUsage(billed, attempted);
    const outcome: RunOutcome = {
      ...recorded,
      attempts,
      costEstimated: recorded.costEstimated || countedAtMost,
      latencyMs: Date.now() - startedAt,
      ...ending,
    };
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
  // what the estimate assumes one call reads
  const inputLimit = inputTokensPerCall(input.pages);

  // Measures a call's input with the current provider's token counting
  // endpoint. A number that fits the limit, or why the call can't be sent.
  async function measure(
    request: ExtractionRequest,
  ): Promise<{ ok: true; tokens: number } | { ok: false; error: unknown } | { ok: false; over: number }> {
    let measured: number;
    try {
      measured = await provider.countInputTokens(request);
    } catch (error) {
      lastFailure = callFailure(error);
      runLog.warn("extraction.count_failed", { provider: provider.name, model: provider.model, ...lastFailure });
      return { ok: false, error };
    }
    if (measured > inputLimit) {
      lastFailure = { error_kind: "over_limit" };
      runLog.warn("extraction.call_not_sent", {
        provider: provider.name,
        model: provider.model,
        input_tokens: measured,
        input_limit: inputLimit,
        error_code: "extraction.too_dense",
      });
      return { ok: false, over: measured };
    }
    runLog.info("extraction.input_counted", {
      provider: provider.name,
      model: provider.model,
      input_tokens: measured,
      input_limit: inputLimit,
    });
    return { ok: true, tokens: measured };
  }

  // One call, switching to the fallback provider if the current one times
  // out or returns a 5xx and no provider has answered yet, measured before
  // it is sent (measure). Records usage whatever happens.
  async function call(request: ExtractionRequest): Promise<CallResult> {
    for (;;) {
      const measured = await measure(request);
      if (!measured.ok) {
        // nothing was sent, so nothing was billed
        const why =
          "over" in measured
            ? `its input (${measured.over} tokens) is over the ${inputLimit} a call may read for ${pagesLabel(input.pages)}`
            : `its input could not be measured (${clip(describeError(measured.error))})`;
        if (primaryFailure) {
          // the fallback, after the primary's first call failed
          return { ok: false, error: `${primaryFailure}${RUN_ERROR_MARKERS.fallbackNotUsed}${why}` };
        }
        if ("over" in measured) {
          // the retry goes back with the previous answer, so it can be over
          // the limit when the first call wasn't; the run then fails with
          // the invalid answer (the caller says the retry failed)
          return { ok: false, error: answered ? `the retry was not sent: ${why}` : `${RUN_ERROR_MARKERS.tooDense}${why}` };
        }
        const failure = clip(describeError(measured.error));
        if (!answered && measured.error instanceof ProviderError && measured.error.fallbackEligible) {
          if (input.fallback && !fallbackUsed) {
            runLog.warn("extraction.fallback", { from_provider: provider.name, to_provider: input.fallback.name, ...lastFailure });
            fallbackUsed = true;
            primaryFailure = failure;
            provider = input.fallback;
            continue;
          }
          if (!input.fallback) {
            return { ok: false, error: `${RUN_ERROR_MARKERS.inputNotMeasured}${failure}; no fallback provider is configured` };
          }
        }
        return { ok: false, error: `${RUN_ERROR_MARKERS.inputNotMeasured}${failure}` };
      }

      attempts += 1;
      attempted = { provider: provider.name, model: provider.model };
      const callStartedAt = Date.now();
      try {
        const response = await provider.extract(request);
        answered = true;
        primaryFailure = null;
        bill(provider.name, response.model, response.inputTokens, response.outputTokens);
        lastFailure = null;
        runLog.info("extraction.call_succeeded", {
          provider: provider.name,
          model: response.model,
          attempt: attempts,
          input_tokens: response.inputTokens,
          output_tokens: response.outputTokens,
          latency_ms: Date.now() - callStartedAt,
        });
        return { ok: true, text: response.text };
      } catch (error) {
        // an unusable answer (a refusal, a truncated answer) was billed too
        let charged = error instanceof ProviderError ? error.usage : undefined;
        if (charged) {
          answered = true;
        } else if (!(error instanceof ProviderError && error.status !== undefined)) {
          // Sent, and no answer came back: the provider may have processed
          // it and billed it, so it counts at the most it could have cost.
          // An HTTP status means the provider refused it instead.
          charged = { model: provider.model, inputTokens: measured.tokens, outputTokens: request.maxOutputTokens };
          countedAtMost = true;
        }
        if (charged) bill(provider.name, charged.model, charged.inputTokens, charged.outputTokens);
        lastFailure = callFailure(error);
        runLog.warn("extraction.call_failed", {
          provider: provider.name,
          model: charged?.model ?? provider.model,
          attempt: attempts,
          latency_ms: Date.now() - callStartedAt,
          ...(charged ? { input_tokens: charged.inputTokens, output_tokens: charged.outputTokens } : {}),
          ...(charged && !answered ? { cost_estimated: true } : {}),
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

// What finish_extraction_run is sent for the tokens the run billed: the
// one model that billed them, or, with tokens from more than one, all of
// them at whichever priced model makes them cost the most (the dearest on
// file if one of them has no price here), marked as an estimate. With none,
// the provider last called and the model it was asked for, at 0 tokens.
function recordedUsage(
  billed: ReadonlyMap<string, { provider: ProviderName; inputTokens: number; outputTokens: number }>,
  attempted: { provider: ProviderName | null; model: string | null },
): Pick<Usage, "provider" | "model" | "inputTokens" | "outputTokens" | "costEstimated"> {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const entry of billed.values()) {
    inputTokens += entry.inputTokens;
    outputTokens += entry.outputTokens;
  }
  const models = [...billed.entries()];
  if (models.length === 0) return { ...attempted, inputTokens: 0, outputTokens: 0, costEstimated: false };
  if (models.length === 1) {
    const [[model, entry]] = models;
    return { provider: entry.provider, model, inputTokens, outputTokens, costEstimated: false };
  }
  let dearest: { model: string; provider: ProviderName; cost: number } | null = null;
  for (const [model] of models) {
    let price;
    try {
      price = priceForModel(model);
    } catch {
      const fallback = dearestModelFor(inputTokens, outputTokens);
      return { provider: PRICING[fallback].provider, model: fallback, inputTokens, outputTokens, costEstimated: true };
    }
    const cost = inputTokens * price.inputUsdPerMillion + outputTokens * price.outputUsdPerMillion;
    if (dearest === null || cost > dearest.cost) dearest = { model, provider: price.provider, cost };
  }
  return { provider: dearest!.provider, model: dearest!.model, inputTokens, outputTokens, costEstimated: true };
}

function pagesLabel(pages: number): string {
  return pages === 1 ? "1 page" : `${pages} pages`;
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
    cost_estimated: outcome.costEstimated,
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

// The outcome as the database takes it: the text-bearing arguments of
// finish_extraction_run (toFinishParams below). Shared by the worker and the
// tests so both record a run the same way. Validation
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

// The arguments finish_extraction_run takes (20260925000002): the close's,
// with the claim token in place of the close token, and whether the cost is
// an estimate (the second of failedCloseAttempts), which the ledger records
// as kind 'estimate'.
export function toFinishParams(runId: string, claimToken: string, outcome: RunOutcome, costEstimated: boolean) {
  const close = toCloseParams(runId, claimToken, outcome);
  return {
    p_run_id: runId,
    p_claim_token: claimToken,
    p_status: close.p_status,
    p_provider: close.p_provider,
    p_model: close.p_model,
    p_input_tokens: close.p_input_tokens,
    p_output_tokens: close.p_output_tokens,
    p_latency_ms: close.p_latency_ms,
    p_attempts: close.p_attempts,
    p_cost_estimated: costEstimated,
    p_error: close.p_error,
    p_raw_response: close.p_raw_response,
    p_fields: close.p_fields,
  };
}

// What to finish a run with when finish_extraction_run refused to record its
// outcome: a model it has no price for, a check this code doesn't know, a
// dropped connection. A refused close changes nothing, so the run is still
// open and its token still valid; closing it as failed with no fields puts
// the document back to how it was instead of leaving it in processing
// until the stale-run reaper frees it.
//
// First with the run's own usage, so its spend is recorded at its price.
// If that is refused too (the usual reason: the provider reported a model
// id with no price on file), the same token counts at the dearest price on
// file (dearestModelFor in config.ts), with the error marked so the page
// shows the cost as an estimate. A run that called a provider is never
// closed without its usage: dropping it would record no cost for tokens
// that were paid for, and the spend ceilings would never see them. If the
// estimate is refused as well, the run stays open until the reaper.
//
// A failed run keeps its own error; a successful one's fields are lost, and
// its error says so with the SQLSTATE of the refusal (never its message),
// for classifyRunError.
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
    costEstimated: outcome.costEstimated,
  };
  const withUsage: RunOutcome = { ...usage, status: "failed", error, rawResponse: null };
  if (usage.model === null && usage.inputTokens === 0 && usage.outputTokens === 0) return [withUsage];

  const dearest = dearestModelFor(usage.inputTokens, usage.outputTokens);
  const estimated: RunOutcome = {
    ...withUsage,
    provider: PRICING[dearest].provider,
    model: dearest,
    costEstimated: true,
    error: `${RUN_ERROR_MARKERS.costEstimated} the dearest price on file (${identifier(sqlState, "no answer")}; served by ${identifier(usage.model, "no model")}): ${error}`,
  };
  return [withUsage, estimated];
}

// A SQLSTATE or a model id as the estimate's error quotes it: only the
// characters either can contain, so nothing else reaches the stored text
// and no parenthesis can end the marker early.
function identifier(value: string | null, absent: string): string {
  if (value === null) return absent;
  return /^[A-Za-z0-9._:-]{1,100}$/.test(value) ? value : "unrecognised";
}
