// What each provider is sent for a request: the model call, and the token
// count that goes before it (run.ts). Both are built from one set of
// fields, so the count measures exactly the input the call will send; the
// call adds only its output cap and what it is billed at: the standard
// service tier, and for Claude global inference routing, the rates the
// price table assumes (config.ts). Neither count endpoint takes those.
//
// It lives apart from anthropic.ts and openai.ts, like classify.ts, because
// those import "server-only" and so can't be loaded by tests. This module
// reads no keys and holds no secrets; tests/unit/provider-requests.test.ts
// compares the two requests field by field.

import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import type { ResponseInput } from "openai/resources/responses/responses";
import {
  ANTHROPIC_SERVICE_TIER,
  ANTHROPIC_THINKING,
  anthropicInferenceGeo,
  OPENAI_REASONING_EFFORT,
  OPENAI_SERVICE_TIER,
} from "../config";
import { ATTACHMENT_FILENAME } from "../schema";
import type { ExtractionRequest } from "./types";
import { toBase64 } from "./types";

// Messages API with a schema-constrained output (output_config.format).
// Reference: https://platform.claude.com/docs/en/build-with-claude/structured-outputs,
// https://platform.claude.com/docs/en/build-with-claude/pdf-support (both
// read on 2026-09-18) and
// https://platform.claude.com/docs/en/build-with-claude/token-counting
// (read on 2026-09-26: the count endpoint takes the same inputs, base64
// PDFs included, and is free).
function anthropicInput(model: string, request: ExtractionRequest) {
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
  return {
    model,
    thinking: ANTHROPIC_THINKING,
    system: request.systemPrompt,
    messages,
    output_config: { format: { type: "json_schema" as const, schema: request.schema } },
  };
}

export function anthropicCreateParams(model: string, request: ExtractionRequest): Anthropic.MessageCreateParamsNonStreaming {
  const geo = anthropicInferenceGeo(model);
  return {
    ...anthropicInput(model, request),
    max_tokens: request.maxOutputTokens,
    service_tier: ANTHROPIC_SERVICE_TIER,
    ...(geo === null ? {} : { inference_geo: geo }),
  };
}

export function anthropicCountParams(model: string, request: ExtractionRequest): Anthropic.MessageCountTokensParams {
  return anthropicInput(model, request);
}

// Responses API with a strict JSON schema (text.format). Reference:
// https://developers.openai.com/api/docs/guides/structured-outputs and
// https://developers.openai.com/api/docs/guides/pdf-files (both read on
// 2026-09-18), and https://developers.openai.com/api/docs/guides/token-counting
// (read on 2026-09-26: responses.inputTokens.count takes the same inputs,
// files included, and returns the exact count).
function openAIInput(model: string, request: ExtractionRequest) {
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
  return {
    model,
    instructions: request.systemPrompt,
    input,
    reasoning: { effort: OPENAI_REASONING_EFFORT },
    text: {
      format: {
        type: "json_schema" as const,
        name: "document_fields",
        strict: true,
        schema: request.schema,
      },
    },
  };
}

export function openAICreateParams(model: string, request: ExtractionRequest): OpenAI.Responses.ResponseCreateParamsNonStreaming {
  return { ...openAIInput(model, request), max_output_tokens: request.maxOutputTokens, service_tier: OPENAI_SERVICE_TIER };
}

export function openAICountParams(model: string, request: ExtractionRequest): OpenAI.Responses.InputTokenCountParams {
  return openAIInput(model, request);
}
