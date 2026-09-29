import "server-only";

import { TOKEN_COUNT_TIMEOUT_MS } from "../config";
import { openAICountTokens, openAIExtract } from "./calls";
import { createOpenAIClient } from "./clients";
import type { ExtractionProvider, ExtractionRequest, ProviderResponse } from "./types";

// Responses API with a strict JSON schema, and its input token count (the
// requests are built in requests.ts), through a client whose base URL is
// fixed in code (clients.ts). Each call and count is held to its timeout
// for the whole of it, body included (calls.ts).
export function createOpenAIProvider(options: {
  apiKey: string;
  model: string;
  timeoutMs: number;
}): ExtractionProvider {
  const client = createOpenAIClient({ apiKey: options.apiKey, timeoutMs: options.timeoutMs });

  return {
    name: "openai",
    model: options.model,

    countInputTokens(request: ExtractionRequest): Promise<number> {
      return openAICountTokens(client, options.model, request, TOKEN_COUNT_TIMEOUT_MS);
    },

    extract(request: ExtractionRequest): Promise<ProviderResponse> {
      return openAIExtract(client, options.model, request, options.timeoutMs);
    },
  };
}
