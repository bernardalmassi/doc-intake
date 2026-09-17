// The model-call loop for one run. Takes providers as arguments so it can be
// tested with fakes; the Server Action supplies the real ones.
//
//   1. call the primary provider
//   2. on a timeout or 5xx, call the fallback provider instead (once)
//   3. validate the answer against the schema and formats
//   4. if invalid, ask the same provider once more with the validation error
//   5. still invalid: the run fails and the last raw answer is kept
//
// Every call's tokens are counted, including failed and retried ones,
// because every call is billed. The cost itself is computed by the
// database at close from these counts and its price table.

import { MAX_OUTPUT_TOKENS, MAX_VALIDATION_RETRIES, type ProviderName } from "./config";
import { describeError, ProviderError, type ExtractionProvider, type ExtractionRequest } from "./providers/types";
import { buildJsonSchema, gateFields, retryPrompt, SYSTEM_PROMPT, userPrompt, validateExtraction, type GatedField } from "./schema";
import type { SupportedMimeType } from "./sniff";

export type RunInput = {
  bytes: Uint8Array;
  mimeType: SupportedMimeType;
  filename: string;
  primary: ExtractionProvider;
  fallback: ExtractionProvider | null;
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
  const finish = <T extends object>(rest: T) => ({ ...usage, latencyMs: Date.now() - startedAt, ...rest });

  const schema = buildJsonSchema();
  const base: ExtractionRequest = {
    bytes: input.bytes,
    mimeType: input.mimeType,
    filename: input.filename,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: userPrompt(input.filename),
    schema,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  };

  let provider = input.primary;
  let fallbackUsed = false;

  // One call, switching to the fallback provider once if the current one
  // times out or returns a 5xx. Records usage whatever happens.
  async function call(request: ExtractionRequest): Promise<string> {
    for (;;) {
      usage.attempts += 1;
      usage.provider = provider.name;
      usage.model = provider.model;
      try {
        const response = await provider.extract(request);
        usage.model = response.model;
        usage.inputTokens += response.inputTokens;
        usage.outputTokens += response.outputTokens;
        return response.text;
      } catch (error) {
        if (error instanceof ProviderError && error.fallbackEligible && input.fallback && !fallbackUsed) {
          fallbackUsed = true;
          provider = input.fallback;
          continue;
        }
        throw error;
      }
    }
  }

  let text: string;
  try {
    text = await call(base);
  } catch (error) {
    return finish({ status: "failed", error: describeError(error), rawResponse: null });
  }

  let result = validateExtraction(text);
  let retries = 0;
  while (!result.ok && retries < MAX_VALIDATION_RETRIES) {
    retries += 1;
    const invalidError = result.error;
    try {
      text = await call({
        ...base,
        previousAttempt: { rawResponse: text, retryPrompt: retryPrompt(invalidError) },
      });
    } catch (error) {
      return finish({
        status: "failed",
        error: `retry after invalid response (${invalidError}) failed: ${describeError(error)}`,
        rawResponse: text,
      });
    }
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
