import "server-only";

import OpenAI from "openai";
import type { ResponseInput } from "openai/resources/responses/responses";
import { OPENAI_REASONING_EFFORT } from "../config";
import { ATTACHMENT_FILENAME } from "../schema";
import { classifyOpenAIError } from "./classify";
import { interpretOpenAIResponse } from "./interpret";
import type { ExtractionProvider, ExtractionRequest, ProviderResponse } from "./types";
import { toBase64 } from "./types";

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
          ? ({ type: "input_file", filename: ATTACHMENT_FILENAME, file_data: dataUrl } as const)
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
        throw classifyOpenAIError(error);
      }

      return interpretOpenAIResponse(response, request.maxOutputTokens);
    },
  };
}
