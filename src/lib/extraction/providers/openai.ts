import "server-only";

import OpenAI from "openai";
import type { ResponseInput } from "openai/resources/responses/responses";
import { OPENAI_REASONING_EFFORT } from "../config";
import type { ExtractionProvider, ExtractionRequest, ProviderResponse } from "./types";
import { ProviderError, toBase64 } from "./types";

// Responses API with a strict JSON schema (text.format). Reference:
// https://developers.openai.com/api/docs/guides/structured-outputs and
// https://developers.openai.com/api/docs/guides/pdf-files (both read on
// 2026-09-18). maxRetries is 0 on purpose: the orchestrator decides what to
// retry and when to fall back.
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

    async extract(request: ExtractionRequest): Promise<ProviderResponse> {
      const dataUrl = `data:${request.mimeType};base64,${toBase64(request.bytes)}`;
      const attachment =
        request.mimeType === "application/pdf"
          ? ({ type: "input_file", filename: request.filename, file_data: dataUrl } as const)
          : ({ type: "input_image", image_url: dataUrl, detail: "auto" } as const);

      const input: ResponseInput = [
        { role: "user", content: [attachment, { type: "input_text", text: request.userPrompt }] },
      ];
      if (request.previousAttempt) {
        input.push(
          { role: "assistant", content: request.previousAttempt.rawResponse },
          { role: "user", content: request.previousAttempt.retryPrompt },
        );
      }

      let response: OpenAI.Responses.Response;
      try {
        response = await client.responses.create({
          model: options.model,
          instructions: request.systemPrompt,
          input,
          max_output_tokens: request.maxOutputTokens,
          reasoning: { effort: OPENAI_REASONING_EFFORT },
          text: {
            format: {
              type: "json_schema",
              name: "document_fields",
              strict: true,
              schema: request.schema,
            },
          },
        });
      } catch (error) {
        throw classify(error);
      }

      if (response.status === "incomplete") {
        const reason = response.incomplete_details?.reason;
        if (reason === "max_output_tokens") {
          throw new ProviderError(
            "openai",
            "truncated",
            `the answer exceeded the ${request.maxOutputTokens} output token cap`,
          );
        }
        throw new ProviderError("openai", "refusal", `the response was incomplete (${reason ?? "unknown reason"})`);
      }

      const refusal = response.output
        .filter((item) => item.type === "message")
        .flatMap((item) => item.content)
        .find((part) => part.type === "refusal");
      if (refusal) {
        throw new ProviderError("openai", "refusal", "the model declined to process this document");
      }

      if (!response.usage) {
        throw new ProviderError("openai", "client", "the response carried no usage, so its cost is unknown");
      }

      return {
        text: response.output_text,
        inputTokens: response.usage.input_tokens,
        // includes reasoning tokens, which are billed as output
        outputTokens: response.usage.output_tokens,
        model: response.model,
      };
    },
  };
}

function classify(error: unknown): ProviderError {
  if (error instanceof OpenAI.APIConnectionError) {
    const timedOut = error instanceof OpenAI.APIConnectionTimeoutError;
    return new ProviderError("openai", "transport", timedOut ? "request timed out" : "connection failed");
  }
  if (error instanceof OpenAI.APIError) {
    const status = typeof error.status === "number" ? error.status : undefined;
    const kind = status !== undefined && status >= 500 ? "server" : "client";
    return new ProviderError("openai", kind, error.message, status);
  }
  return new ProviderError("openai", "client", error instanceof Error ? error.message : String(error));
}
