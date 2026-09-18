// What a provider's successful HTTP response means for the run: the answer's
// text, token counts and served model, or a ProviderError when the answer
// can't be used. A refusal or an answer cut off at the output cap was still
// billed, so that error carries the call's usage and the orchestrator counts
// it. Neither falls back to the other provider.
//
// It lives apart from anthropic.ts and openai.ts, like classify.ts, because
// those import "server-only" and so can't be loaded by tests. This module
// reads no keys and only uses the SDKs' types; tests/unit/interpret.test.ts
// feeds it objects typed as the SDKs' own Message and Response.

import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import { ProviderError, type ProviderResponse, type ProviderUsage } from "./types";

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
