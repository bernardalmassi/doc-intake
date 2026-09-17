import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import type { ExtractionProvider, ExtractionRequest, ProviderResponse } from "./types";
import { ProviderError, toBase64 } from "./types";

// Messages API with a schema-constrained output (output_config.format).
// Reference: https://platform.claude.com/docs/en/build-with-claude/structured-outputs
// and https://platform.claude.com/docs/en/build-with-claude/pdf-support
// (both read on 2026-09-18). maxRetries is 0 on purpose: the orchestrator
// decides what to retry and when to fall back.
export function createAnthropicProvider(options: {
  apiKey: string;
  model: string;
  timeoutMs: number;
}): ExtractionProvider {
  const client = new Anthropic({
    apiKey: options.apiKey,
    timeout: options.timeoutMs,
    maxRetries: 0,
  });

  return {
    name: "anthropic",
    model: options.model,

    async extract(request: ExtractionRequest): Promise<ProviderResponse> {
      const data = toBase64(request.bytes);
      const attachment: Anthropic.ContentBlockParam =
        request.mimeType === "application/pdf"
          ? { type: "document", source: { type: "base64", media_type: "application/pdf", data } }
          : { type: "image", source: { type: "base64", media_type: request.mimeType, data } };

      const messages: Anthropic.MessageParam[] = [
        { role: "user", content: [attachment, { type: "text", text: request.userPrompt }] },
      ];
      if (request.previousAttempt) {
        messages.push(
          { role: "assistant", content: request.previousAttempt.rawResponse },
          { role: "user", content: request.previousAttempt.retryPrompt },
        );
      }

      let response: Anthropic.Message;
      try {
        response = await client.messages.create({
          model: options.model,
          max_tokens: request.maxOutputTokens,
          system: request.systemPrompt,
          messages,
          output_config: { format: { type: "json_schema", schema: request.schema } },
        });
      } catch (error) {
        throw classify(error);
      }

      if (response.stop_reason === "refusal") {
        throw new ProviderError("anthropic", "refusal", "the model declined to process this document");
      }
      if (response.stop_reason === "max_tokens") {
        throw new ProviderError(
          "anthropic",
          "truncated",
          `the answer exceeded the ${request.maxOutputTokens} output token cap`,
        );
      }

      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("");

      return {
        text,
        // cache reads and writes are not used, so input_tokens is the full count
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        model: response.model,
      };
    },
  };
}

function classify(error: unknown): ProviderError {
  // Most specific first. Timeouts are a connection error subclass.
  if (error instanceof Anthropic.APIConnectionError) {
    const timedOut = error instanceof Anthropic.APIConnectionTimeoutError;
    return new ProviderError("anthropic", "transport", timedOut ? "request timed out" : "connection failed");
  }
  if (error instanceof Anthropic.APIError) {
    const status = typeof error.status === "number" ? error.status : undefined;
    const kind = status !== undefined && status >= 500 ? "server" : "client";
    return new ProviderError("anthropic", kind, error.message, status);
  }
  return new ProviderError("anthropic", "client", error instanceof Error ? error.message : String(error));
}
