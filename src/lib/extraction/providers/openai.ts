import "server-only";

import OpenAI from "openai";
import { TOKEN_COUNT_TIMEOUT_MS } from "../config";
import { classifyOpenAIError } from "./classify";
import { interpretOpenAIResponse, interpretTokenCount } from "./interpret";
import { openAICountParams, openAICreateParams } from "./requests";
import type { ExtractionProvider, ExtractionRequest, ProviderResponse } from "./types";

// Responses API with a strict JSON schema, and its input token count (the
// requests are built in requests.ts). maxRetries is 0 on purpose: the
// orchestrator decides what to retry and when to fall back.
export function createOpenAIProvider(options: {
  apiKey: string;
  model: string;
  timeoutMs: number;
}): ExtractionProvider {
  const client = new OpenAI({
    apiKey: options.apiKey,
    timeout: options.timeoutMs,
    maxRetries: 0,
  });

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
