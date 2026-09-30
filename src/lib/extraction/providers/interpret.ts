// What a provider's successful HTTP response means for the run: the answer's
// text, token counts and served model, or a ProviderError when the answer
// can't be used. A refusal or an answer cut off at the output cap was still
// billed, so that error carries the call's usage and the orchestrator counts
// it. Neither falls back to the other provider.
//
// Only a normal finish is an answer: end_turn for Anthropic, completed for
// OpenAI. Anything else fails closed, because a schema-constrained answer
// with no tools has no other legitimate way to end, and a stop nobody
// anticipated (a future stop reason included) should not be parsed as if it
// were complete.
//
// It lives apart from anthropic.ts and openai.ts, like classify.ts, because
// those import "server-only" and so can't be loaded by tests. This module
// reads no keys and only uses the SDKs' types; tests/unit/interpret.test.ts
// feeds it objects typed as the SDKs' own Message and Response.

import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import { ProviderError, type ProviderName, type ProviderResponse, type ProviderUsage } from "./types";

// A token counting endpoint's answer: the count, if it is one. Anything else
// fails the count, so no call is sent on a number nobody measured.
export function interpretTokenCount(provider: ProviderName, count: unknown): number {
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
    throw new ProviderError(provider, "client", "the token count endpoint returned no usable count");
  }
  return count;
}

export function interpretAnthropicMessage(message: Anthropic.Message, maxOutputTokens: number): ProviderResponse {
  const usage: ProviderUsage = {
    // cache reads and writes are not used, so input_tokens is the full count
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
    model: message.model,
  };

  if (message.stop_reason === "refusal") {
    throw new ProviderError("anthropic", "refusal", "the model declined to process this document", undefined, usage);
  }
  if (message.stop_reason === "max_tokens") {
    throw new ProviderError(
      "anthropic",
      "truncated",
      `the answer exceeded the ${maxOutputTokens} output token cap`,
      undefined,
      usage,
    );
  }
  if (message.stop_reason === "model_context_window_exceeded") {
    throw new ProviderError("anthropic", "truncated", "the answer was cut off at the model's context window", undefined, usage);
  }
  if (message.stop_reason !== "end_turn") {
    throw new ProviderError(
      "anthropic",
      "client",
      `the answer stopped unexpectedly (${message.stop_reason ?? "no stop reason"})`,
      undefined,
      usage,
    );
  }

  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
  return { text, ...usage };
}

export function interpretOpenAIResponse(response: OpenAI.Responses.Response, maxOutputTokens: number): ProviderResponse {
  const usage: ProviderUsage | undefined = response.usage && {
    inputTokens: response.usage.input_tokens,
    // includes reasoning tokens, which are billed as output
    outputTokens: response.usage.output_tokens,
    model: response.model,
  };

  if (response.status === "incomplete") {
    const reason = response.incomplete_details?.reason;
    if (reason === "max_output_tokens") {
      throw new ProviderError(
        "openai",
        "truncated",
        `the answer exceeded the ${maxOutputTokens} output token cap`,
        undefined,
        usage,
      );
    }
    throw new ProviderError(
      "openai",
      "refusal",
      `the response was incomplete (${reason ?? "unknown reason"})`,
      undefined,
      usage,
    );
  }

  if (response.status !== "completed") {
    // "failed" is the provider failing; queued, in_progress or cancelled
    // can't be the result of a request that waited for its answer
    throw new ProviderError(
      "openai",
      response.status === "failed" ? "server" : "client",
      `the response did not complete (${response.status ?? "no status"})`,
      undefined,
      usage,
    );
  }

  const refusal = response.output
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content)
    .find((part) => part.type === "refusal");
  if (refusal) {
    throw new ProviderError("openai", "refusal", "the model declined to process this document", undefined, usage);
  }

  if (!usage) {
    throw new ProviderError("openai", "client", "the response carried no usage, so its cost is unknown");
  }

  return { text: response.output_text, ...usage };
}
