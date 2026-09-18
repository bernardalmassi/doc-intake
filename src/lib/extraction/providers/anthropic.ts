import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import { classifyAnthropicError } from "./classify";
import { interpretAnthropicMessage } from "./interpret";
import type { ExtractionProvider, ExtractionRequest, ProviderResponse } from "./types";
import { toBase64 } from "./types";
import { ANTHROPIC_THINKING } from "../config";

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
          thinking: ANTHROPIC_THINKING,
          system: request.systemPrompt,
          messages,
          output_config: { format: { type: "json_schema", schema: request.schema } },
        });
      } catch (error) {
        throw classifyAnthropicError(error);
      }

      return interpretAnthropicMessage(response, request.maxOutputTokens);
    },
  };
}
