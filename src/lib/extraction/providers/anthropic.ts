import "server-only";

import { TOKEN_COUNT_TIMEOUT_MS } from "../config";
import { anthropicCountTokens, anthropicExtract } from "./calls";
import { createAnthropicClient } from "./clients";
import type { ExtractionProvider, ExtractionRequest, ProviderResponse } from "./types";

// Messages API with a schema-constrained output, and its token counting
// endpoint (the requests are built in requests.ts), through a client whose
// base URL is fixed in code (clients.ts). Each call and count is held to its
// timeout for the whole of it, body included (calls.ts).
export function createAnthropicProvider(options: {
  apiKey: string;
  model: string;
  timeoutMs: number;
}): ExtractionProvider {
  const client = createAnthropicClient({ apiKey: options.apiKey, timeoutMs: options.timeoutMs });

  return {
    name: "anthropic",
    model: options.model,

    countInputTokens(request: ExtractionRequest): Promise<number> {
      return anthropicCountTokens(client, options.model, request, TOKEN_COUNT_TIMEOUT_MS);
    },

    extract(request: ExtractionRequest): Promise<ProviderResponse> {
      return anthropicExtract(client, options.model, request, options.timeoutMs);
    },
  };
}
