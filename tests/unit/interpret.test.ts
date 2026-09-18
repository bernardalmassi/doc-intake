// Response interpretation (providers/interpret.ts): what each provider's
// successful HTTP response means for the run. The inputs are objects typed
// as the SDKs' own Anthropic.Message and OpenAI Response, so a change in
// either SDK's shape fails the type check here. No network, no keys.
//
//   - a normal answer gives its text, its token counts and the model that
//     served it
//   - a refusal, or an answer cut off at the output cap, throws a
//     ProviderError that does not fall back and carries the call's usage,
//     because the call was billed and the run must count it
//   - OpenAI: every incomplete reason, a refusal part in the output, and a
//     response with no usage (refused, since its cost would be unknown)
//
// The last test runs one through the orchestrator to show the usage
// reaches the run's totals.

import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { interpretAnthropicMessage, interpretOpenAIResponse } from "@/lib/extraction/providers/interpret";
import { ProviderError } from "@/lib/extraction/providers/types";
import { runExtraction } from "@/lib/extraction/run";
import { pdfBytes } from "../helpers/fake-provider";

const CAP = 2048;
const HAIKU = "claude-haiku-4-5-20251001";
const NANO_SNAPSHOT = "gpt-5-nano-2025-08-07";

// Runs `fn` and returns the ProviderError it throws.
function thrownBy(fn: () => unknown): ProviderError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ProviderError) return error;
    throw error;
  }
  throw new Error("expected a ProviderError");
}

function anthropicMessage(overrides: Partial<Anthropic.Message> = {}): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: HAIKU,
    // an answer can arrive in more than one text block
    content: [
      { type: "text", text: '{"title": ', citations: null },
      { type: "text", text: '"x"}', citations: null },
    ],
    stop_reason: "end_turn",
    stop_sequence: null,
    stop_details: null,
    container: null,
    usage: {
      input_tokens: 1234,
      output_tokens: 56,
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      inference_geo: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: "standard",
    },
    ...overrides,
  };
}

function outputMessage(
  content: OpenAI.Responses.ResponseOutputMessage["content"],
): OpenAI.Responses.ResponseOutputMessage {
  return { id: "msg_test", type: "message", role: "assistant", status: "completed", content };
}

function openAIResponse(overrides: Partial<OpenAI.Responses.Response> = {}): OpenAI.Responses.Response {
  return {
    id: "resp_test",
    object: "response",
    created_at: 1_760_000_000,
    model: NANO_SNAPSHOT,
    status: "completed",
    output: [outputMessage([{ type: "output_text", text: '{"title": "x"}', annotations: [] }])],
    output_text: '{"title": "x"}',
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    parallel_tool_calls: true,
    temperature: null,
    tool_choice: "auto",
    tools: [],
    top_p: null,
    usage: {
      input_tokens: 2345,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens: 789,
      output_tokens_details: { reasoning_tokens: 512 },
      total_tokens: 3134,
    },
    ...overrides,
  };
}

describe("Anthropic messages", () => {
  it("a message that stops with end_turn is an answer", () => {
    const result = interpretAnthropicMessage(anthropicMessage({ stop_reason: "end_turn" }), CAP);
    expect(result).toEqual({ text: '{"title": "x"}', inputTokens: 1234, outputTokens: 56, model: HAIKU });
  });

  it("an answer cut off at the context window throws truncated, with the billed usage", () => {
    const error = thrownBy(() =>
      interpretAnthropicMessage(anthropicMessage({ stop_reason: "model_context_window_exceeded" }), CAP),
    );
    expect(error).toMatchObject({ provider: "anthropic", kind: "truncated" });
    expect(error.fallbackEligible).toBe(false);
    expect(error.usage).toEqual({ inputTokens: 1234, outputTokens: 56, model: HAIKU });
  });

  // No stop sequences and no tools are ever sent, so any other ending is
  // unexpected and fails closed rather than being parsed as complete.
  it.each(["stop_sequence", "tool_use", "pause_turn", null] as const)(
    "a message that stops with %s fails closed, with the billed usage",
    (stopReason) => {
      const error = thrownBy(() => interpretAnthropicMessage(anthropicMessage({ stop_reason: stopReason }), CAP));
      expect(error).toMatchObject({ provider: "anthropic", kind: "client" });
      expect(error.message).toContain("stopped unexpectedly");
      expect(error.fallbackEligible).toBe(false);
      expect(error.usage).toEqual({ inputTokens: 1234, outputTokens: 56, model: HAIKU });
    },
  );

  it("a refusal throws, does not fall back, and carries the billed usage", () => {
    const error = thrownBy(() =>
      interpretAnthropicMessage(
        anthropicMessage({
          stop_reason: "refusal",
          stop_details: { type: "refusal", category: null, explanation: null },
          content: [],
        }),
        CAP,
      ),
    );
    expect(error).toMatchObject({ provider: "anthropic", kind: "refusal", status: undefined });
    expect(error.fallbackEligible).toBe(false);
    expect(error.usage).toEqual({ inputTokens: 1234, outputTokens: 56, model: HAIKU });
  });

  it("an answer cut off at the output cap throws truncated, with the billed usage", () => {
    const error = thrownBy(() =>
      interpretAnthropicMessage(
        anthropicMessage({ stop_reason: "max_tokens", usage: { ...anthropicMessage().usage, output_tokens: CAP } }),
        CAP,
      ),
    );
    expect(error).toMatchObject({ provider: "anthropic", kind: "truncated" });
    expect(error.message).toBe(`the answer exceeded the ${CAP} output token cap`);
    expect(error.fallbackEligible).toBe(false);
    expect(error.usage).toEqual({ inputTokens: 1234, outputTokens: CAP, model: HAIKU });
  });
});

describe("OpenAI responses", () => {
  it("a completed response is an answer; output tokens include reasoning", () => {
    const result = interpretOpenAIResponse(openAIResponse(), CAP);
    expect(result).toEqual({ text: '{"title": "x"}', inputTokens: 2345, outputTokens: 789, model: NANO_SNAPSHOT });
  });

  it("an answer cut off at the output cap throws truncated, with the billed usage", () => {
    const error = thrownBy(() =>
      interpretOpenAIResponse(
        openAIResponse({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }),
        CAP,
      ),
    );
    expect(error).toMatchObject({ provider: "openai", kind: "truncated" });
    expect(error.message).toBe(`the answer exceeded the ${CAP} output token cap`);
    expect(error.fallbackEligible).toBe(false);
    expect(error.usage).toEqual({ inputTokens: 2345, outputTokens: 789, model: NANO_SNAPSHOT });
  });

  it.each([
    [{ reason: "content_filter" as const }, "content_filter"],
    [{ reason: "max_messages" as const }, "max_messages"],
    [{ reason: "steered" as const }, "steered"],
    [{}, "unknown reason"],
    [null, "unknown reason"],
  ])("an incomplete response (%o) throws, naming the reason, with the billed usage", (details, named) => {
    const error = thrownBy(() =>
      interpretOpenAIResponse(openAIResponse({ status: "incomplete", incomplete_details: details }), CAP),
    );
    expect(error).toMatchObject({ provider: "openai", kind: "refusal" });
    expect(error.message).toBe(`the response was incomplete (${named})`);
    expect(error.fallbackEligible).toBe(false);
    expect(error.usage).toEqual({ inputTokens: 2345, outputTokens: 789, model: NANO_SNAPSHOT });
  });

  it("a refusal in the output throws, does not fall back, and carries the billed usage", () => {
    const error = thrownBy(() =>
      interpretOpenAIResponse(
        openAIResponse({
          output: [outputMessage([{ type: "refusal", refusal: "I can't help with that." }])],
          output_text: "",
        }),
        CAP,
      ),
    );
    expect(error).toMatchObject({ provider: "openai", kind: "refusal" });
    expect(error.message).toBe("the model declined to process this document");
    expect(error.fallbackEligible).toBe(false);
    expect(error.usage).toEqual({ inputTokens: 2345, outputTokens: 789, model: NANO_SNAPSHOT });
  });

  it.each([
    ["failed", "server"],
    ["cancelled", "client"],
    ["queued", "client"],
    ["in_progress", "client"],
  ] as const)("a %s response fails closed as %s, with the billed usage", (status, kind) => {
    const error = thrownBy(() => interpretOpenAIResponse(openAIResponse({ status }), CAP));
    expect(error).toMatchObject({ provider: "openai", kind });
    expect(error.message).toContain(`did not complete (${status})`);
    expect(error.usage).toBeDefined();
  });

  it("a response with no usage is refused, since its cost would be unknown", () => {
    const error = thrownBy(() => interpretOpenAIResponse(openAIResponse({ usage: undefined }), CAP));
    expect(error).toMatchObject({ provider: "openai", kind: "client" });
    expect(error.message).toBe("the response carried no usage, so its cost is unknown");
    expect(error.fallbackEligible).toBe(false);
    expect(error.usage).toBeUndefined();
  });

  it("an unusable response with no usage throws without usage rather than inventing it", () => {
    const error = thrownBy(() =>
      interpretOpenAIResponse(
        openAIResponse({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: undefined }),
        CAP,
      ),
    );
    expect(error.kind).toBe("truncated");
    expect(error.usage).toBeUndefined();
  });
});

describe("through the orchestrator", () => {
  it("a truncated answer's billed tokens reach the run's totals", async () => {
    const truncated = anthropicMessage({
      stop_reason: "max_tokens",
      usage: { ...anthropicMessage().usage, input_tokens: 48_000, output_tokens: CAP },
    });
    const outcome = await runExtraction({
      bytes: pdfBytes("interpret"),
      mimeType: "application/pdf",
      filename: "interpret.pdf",
      primary: {
        name: "anthropic",
        model: HAIKU,
        async extract(request) {
          return interpretAnthropicMessage(truncated, request.maxOutputTokens);
        },
      },
      fallback: null,
    });

    expect(outcome).toMatchObject({
      status: "failed",
      provider: "anthropic",
      model: HAIKU,
      attempts: 1,
      inputTokens: 48_000,
      outputTokens: CAP,
    });
    if (outcome.status === "failed") {
      expect(outcome.error).toBe(`anthropic truncated: the answer exceeded the ${CAP} output token cap`);
    }
  });
});
