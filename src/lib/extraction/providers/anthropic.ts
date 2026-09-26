import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import { TOKEN_COUNT_TIMEOUT_MS } from "../config";
import { classifyAnthropicError } from "./classify";
import { interpretAnthropicMessage, interpretTokenCount } from "./interpret";
import { anthropicCountParams, anthropicCreateParams } from "./requests";
import type { ExtractionProvider, ExtractionRequest, ProviderResponse } from "./types";

// Messages API with a schema-constrained output, and its token counting
// endpoint (the requests are built in requests.ts). maxRetries is 0 on
// purpose: the orchestrator decides what to retry and when to fall back.
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

    async countInputTokens(request: ExtractionRequest): Promise<number> {
      let counted: Anthropic.MessageTokensCount;
      try {
        counted = await client.messages.countTokens(anthropicCountParams(options.model, request), {
          timeout: TOKEN_COUNT_TIMEOUT_MS,
        });
      } catch (error) {
        throw classifyAnthropicError(error);
      }
      return interpretTokenCount("anthropic", counted.input_tokens);
    },

    async extract(request: ExtractionRequest): Promise<ProviderResponse> {
      let response: Anthropic.Message;
      try {
        response = await client.messages.create(anthropicCreateParams(options.model, request));
      } catch (error) {
        throw classifyAnthropicError(error);
      }

      return interpretAnthropicMessage(response, request.maxOutputTokens);
    },
  };
}
