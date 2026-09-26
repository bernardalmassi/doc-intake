import "server-only";

import type Anthropic from "@anthropic-ai/sdk";
import { TOKEN_COUNT_TIMEOUT_MS } from "../config";
import { classifyAnthropicError } from "./classify";
import { createAnthropicClient } from "./clients";
import { interpretAnthropicMessage, interpretTokenCount } from "./interpret";
import { anthropicCountParams, anthropicCreateParams } from "./requests";
import type { ExtractionProvider, ExtractionRequest, ProviderResponse } from "./types";

// Messages API with a schema-constrained output, and its token counting
// endpoint (the requests are built in requests.ts), through a client whose
// base URL is fixed in code (clients.ts).
export function createAnthropicProvider(options: {
  apiKey: string;
  model: string;
  timeoutMs: number;
}): ExtractionProvider {
  const client = createAnthropicClient({ apiKey: options.apiKey, timeoutMs: options.timeoutMs });

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
