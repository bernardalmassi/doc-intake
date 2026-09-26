import "server-only";

import type OpenAI from "openai";
import { TOKEN_COUNT_TIMEOUT_MS } from "../config";
import { classifyOpenAIError } from "./classify";
import { createOpenAIClient } from "./clients";
import { interpretOpenAIResponse, interpretTokenCount } from "./interpret";
import { openAICountParams, openAICreateParams } from "./requests";
import type { ExtractionProvider, ExtractionRequest, ProviderResponse } from "./types";

// Responses API with a strict JSON schema, and its input token count (the
// requests are built in requests.ts), through a client whose base URL is
// fixed in code (clients.ts).
export function createOpenAIProvider(options: {
  apiKey: string;
  model: string;
  timeoutMs: number;
}): ExtractionProvider {
  const client = createOpenAIClient({ apiKey: options.apiKey, timeoutMs: options.timeoutMs });

  return {
    name: "openai",
    model: options.model,

    async countInputTokens(request: ExtractionRequest): Promise<number> {
      let counted: OpenAI.Responses.InputTokenCountResponse;
      try {
        counted = await client.responses.inputTokens.count(openAICountParams(options.model, request), {
          timeout: TOKEN_COUNT_TIMEOUT_MS,
        });
      } catch (error) {
        throw classifyOpenAIError(error);
      }
      return interpretTokenCount("openai", counted.input_tokens);
    },

    async extract(request: ExtractionRequest): Promise<ProviderResponse> {
      let response: OpenAI.Responses.Response;
      try {
        response = await client.responses.create(openAICreateParams(options.model, request));
      } catch (error) {
        throw classifyOpenAIError(error);
      }

      return interpretOpenAIResponse(response, request.maxOutputTokens);
    },
  };
}
