// The input token counts the per-call bound is calibrated from
// (EXTRACTION_LIMITS.promptInputTokens, inputTokensPerPage and
// retryInputTokens in src/lib/extraction/config.ts, and the same columns of
// public.extraction_limits, 20260925000005), and the requests they were
// measured on. Shared by the counter (evals/count.ts, `npm run eval --
// --count`) and tests/unit/input-bound.test.ts. No network and no secrets.
//
// What is counted, on every Anthropic model EXTRACTION_ANTHROPIC_MODEL may
// select, with exactly the input a call sends (requests.ts):
//   prompt      the system prompt, the schema and the user prompt, with no
//               attachment: the base every call pays
//   fixture     each eval fixture's PDF, as the first call sends it
//   retry       each fixture again as the validation retry sends it: the
//               first call's input, the model's recorded answer, and the
//               retry prompt carrying the longest validation error the
//               validator writes
//   image       a full-resolution phone photo and an A4 page scanned at
//               150 dpi, one page each (evals/count.ts says how they were
//               made; they are not committed, their hashes are)
// OpenAI's input token count is not called: its documentation states no
// price, and these counts must cost nothing. What OpenAI billed for each
// fixture is in its recordings, and the test checks those against the
// bound too.
//
// The figures are the observed maximum plus 25% (deriveFigures): the base
// is the largest prompt count, a page the largest (count - prompt) / pages
// over the fixtures and the images, the retry allowance the largest
// (retry - first call) over the fixtures.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MAX_OUTPUT_TOKENS, selectableAnthropicModels } from "@/lib/extraction/config";
import type { ExtractionRequest } from "@/lib/extraction/providers/types";
import { buildJsonSchema, FIELD_NAMES, retryPrompt, SYSTEM_PROMPT, userPrompt, validateExtraction } from "@/lib/extraction/schema";
import type { SupportedMimeType } from "@/lib/extraction/sniff";
import { FIXTURES, type Fixture } from "./fixtures";
import { committedPdf, loadRecording } from "./harness";
import { type FingerprintPart, fingerprintRequest, type RequestFingerprint } from "./recording";

export const TOKEN_COUNTS_VERSION = 1;
export const TOKEN_COUNTS_PATH = fileURLToPath(new URL("./token-counts.json", import.meta.url));
export const COUNT_ENDPOINT = "https://api.anthropic.com/v1/messages/count_tokens";

// what each figure is set to: the observed maximum plus 25%
export const CALIBRATION_HEADROOM = 1.25;

export const RECOUNT_HINT = "recount with npm run eval -- --count (Anthropic's free count endpoint only)";

// The models counted: every Anthropic model the app may be configured to
// use, so the bound holds whichever is selected.
export function countedModels(): string[] {
  return selectableAnthropicModels();
}

// The longest error validateExtraction writes for an answer shaped like a
// real one: an extra key, and every field an empty object, so each field is
// missing all four of its keys and has no confidence. What the retry prompt
// carries is never longer than this for an answer of that shape.
export const LONGEST_VALIDATION_ERROR: string = (() => {
  const answer = Object.fromEntries([...FIELD_NAMES.map((name) => [name, {}]), ["unexpected", {}]]);
  const result = validateExtraction(JSON.stringify(answer));
  if (result.ok) throw new Error("an answer of empty fields passed validation");
  return result.error;
})();

// The first call's request for a file, as runExtraction builds it.
export function firstCallRequest(bytes: Uint8Array, mimeType: SupportedMimeType): ExtractionRequest {
  return {
    bytes,
    mimeType,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: userPrompt(),
    schema: buildJsonSchema(),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  };
}

// The validation retry after `rawResponse`, as runExtraction builds it.
export function retryRequest(first: ExtractionRequest, rawResponse: string): ExtractionRequest {
  return { ...first, previousAttempt: { rawResponse, retryPrompt: retryPrompt(LONGEST_VALIDATION_ERROR) } };
}

export type CountKind = "prompt" | "fixture" | "retry" | "image";

export type CountedRequest = {
  id: string;
  kind: CountKind;
  // the pages the bound allows for it (the prompt: 0)
  pages: number;
  request: ExtractionRequest;
};

// An image counted as a one-page upload, described by what identifies it.
export type ImageCase = {
  id: string;
  description: string;
  mimeType: "image/jpeg" | "image/png";
  width: number;
  height: number;
  bytes: number;
  sha256: string;
};

// The model's answer the retry resends: what Claude answered the fixture
// when it was recorded.
function recordedAnswer(fixture: Fixture): string {
  const recording = loadRecording(fixture, "anthropic");
  const answer = recording.calls.find((call) => call.response !== null)?.response?.text;
  if (answer === undefined) throw new Error(`${fixture.id}'s Anthropic recording has no answer to retry with`);
  return answer;
}

// Every request counted from the repository: the prompt, each fixture and
// each fixture's retry. The images come from outside it (count.ts).
export function repositoryRequests(): CountedRequest[] {
  const empty = firstCallRequest(new Uint8Array(0), "application/pdf");
  const requests: CountedRequest[] = [{ id: "prompt", kind: "prompt", pages: 0, request: empty }];
  for (const fixture of FIXTURES) {
    const first = firstCallRequest(committedPdf(fixture), "application/pdf");
    const pages = fixture.pages.length;
    requests.push({ id: `fixture:${fixture.id}`, kind: "fixture", pages, request: first });
    requests.push({ id: `retry:${fixture.id}`, kind: "retry", pages, request: retryRequest(first, recordedAnswer(fixture)) });
  }
  return requests;
}

export type TokenCounts = {
  version: typeof TOKEN_COUNTS_VERSION;
  countedAt: string;
  endpoint: string;
  images: ImageCase[];
  // per request id: its kind, its pages and its fingerprint's parts but the
  // provider's, which names the model (as the recordings fingerprint a
  // request; an image's file part is made from its hash)
  requests: Record<string, { kind: CountKind; pages: number; parts: Record<Exclude<FingerprintPart, "provider">, string> }>;
  // per model, per request id: input_tokens as the endpoint answered
  counts: Record<string, Record<string, number>>;
};

export function fingerprintFor(model: string, request: ExtractionRequest): RequestFingerprint {
  return fingerprintRequest("anthropic", model, request);
}

export function loadTokenCounts(path: string = TOKEN_COUNTS_PATH): TokenCounts {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as TokenCounts;
  if (parsed.version !== TOKEN_COUNTS_VERSION) throw new Error(`${path} is not a version ${TOKEN_COUNTS_VERSION} count file`);
  return parsed;
}

export type Observed = {
  // the largest prompt count, and the model it was counted on
  prompt: { tokens: number; model: string };
  // the largest (count - that model's prompt) / pages, and where
  perPage: { tokens: number; model: string; id: string };
  // the largest (retry - first call), and where
  retry: { tokens: number; model: string; id: string };
};

export type Figures = { promptInputTokens: number; inputTokensPerPage: number; retryInputTokens: number };

export function observedMaxima(counts: TokenCounts): Observed {
  let prompt: Observed["prompt"] | null = null;
  let perPage: Observed["perPage"] | null = null;
  let retry: Observed["retry"] | null = null;
  for (const [model, byId] of Object.entries(counts.counts)) {
    const base = byId.prompt;
    if (base === undefined) throw new Error(`no prompt count for ${model}`);
    if (prompt === null || base > prompt.tokens) prompt = { tokens: base, model };
    for (const [id, tokens] of Object.entries(byId)) {
      const described = counts.requests[id];
      if (!described) throw new Error(`count for an undescribed request ${id}`);
      if (described.kind === "fixture" || described.kind === "image") {
        const page = Math.ceil((tokens - base) / described.pages);
        if (perPage === null || page > perPage.tokens) perPage = { tokens: page, model, id };
      }
      if (described.kind === "retry") {
        const first = byId[`fixture:${id.slice("retry:".length)}`];
        if (first === undefined) throw new Error(`no first call counted for ${id} on ${model}`);
        if (retry === null || tokens - first > retry.tokens) retry = { tokens: tokens - first, model, id };
      }
    }
  }
  if (!prompt || !perPage || !retry) throw new Error("the counts have no prompt, page or retry to derive from");
  return { prompt, perPage, retry };
}

export function deriveFigures(observed: Observed): Figures {
  return {
    promptInputTokens: Math.ceil(observed.prompt.tokens * CALIBRATION_HEADROOM),
    inputTokensPerPage: Math.ceil(observed.perPage.tokens * CALIBRATION_HEADROOM),
    retryInputTokens: Math.ceil(observed.retry.tokens * CALIBRATION_HEADROOM),
  };
}
