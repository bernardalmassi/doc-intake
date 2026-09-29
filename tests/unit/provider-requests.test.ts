// What each provider is sent (src/lib/extraction/providers/requests.ts),
// through the real SDKs over a fake fetch, with no network: the token count
// that run.ts makes before every call carries exactly the input the call
// then sends, and only the call carries the output cap and what it is
// billed at: the standard service tier, and for Claude global inference
// routing (none for a model that refuses the parameter), the rates the
// price table assumes. So the count measures what the call is billed for,
// at the table's prices. Also: a count that isn't a non-negative whole
// number fails, so no call is sent on it.
//
// Needs no database and no key; the clients point at .invalid hosts.

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_SERVICE_TIER,
  anthropicInferenceGeo,
  DEFAULT_MODELS,
  MAX_OUTPUT_TOKENS,
  OPENAI_SERVICE_TIER,
  PRICING,
} from "@/lib/extraction/config";
import { interpretTokenCount } from "@/lib/extraction/providers/interpret";
import {
  anthropicCountParams,
  anthropicCreateParams,
  openAICountParams,
  openAICreateParams,
} from "@/lib/extraction/providers/requests";
import { ProviderError, type ExtractionRequest } from "@/lib/extraction/providers/types";
import { buildJsonSchema, retryPrompt, SYSTEM_PROMPT, userPrompt } from "@/lib/extraction/schema";
import { pdfBytes } from "../helpers/fake-provider";

type Sent = { url: string; body: Record<string, unknown> };

// Records each request's URL and JSON body and answers with `reply`.
function recorder(reply: (url: string) => unknown) {
  const sent: Sent[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    sent.push({ url, body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(reply(url)), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { sent, fetch };
}

const first: ExtractionRequest = {
  bytes: pdfBytes("requests"),
  mimeType: "application/pdf",
  systemPrompt: SYSTEM_PROMPT,
  userPrompt: userPrompt(),
  schema: buildJsonSchema(),
  maxOutputTokens: MAX_OUTPUT_TOKENS,
};
const retry: ExtractionRequest = { ...first, previousAttempt: { rawResponse: "{ nope", retryPrompt: retryPrompt("not valid JSON") } };
const image: ExtractionRequest = { ...first, bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mimeType: "image/png" };

describe("the count and the call carry the same input", () => {
  it.each([
    ["a PDF", first],
    ["the retry, with the previous answer", retry],
    ["an image", image],
  ])("Anthropic, %s", async (_, request) => {
    const { sent, fetch } = recorder((url) =>
      url.endsWith("/count_tokens")
        ? { input_tokens: 6708 }
        : {
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: DEFAULT_MODELS.anthropic,
            content: [{ type: "text", text: "{}" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 6708, output_tokens: 10 },
          },
    );
    const client = new Anthropic({ apiKey: "test-not-a-key", baseURL: "https://api.anthropic.invalid", maxRetries: 0, fetch, logLevel: "off" });
    const counted = await client.messages.countTokens(anthropicCountParams(DEFAULT_MODELS.anthropic, request));
    await client.messages.create(anthropicCreateParams(DEFAULT_MODELS.anthropic, request));

    expect(counted.input_tokens).toBe(6708);
    expect(sent.map((s) => new URL(s.url).pathname)).toEqual(["/v1/messages/count_tokens", "/v1/messages"]);
    const [count, call] = sent.map((s) => s.body);
    const { max_tokens, service_tier, inference_geo, ...input } = call;
    expect(max_tokens).toBe(MAX_OUTPUT_TOKENS);
    // the standard tier and global routing, what the price table assumes
    expect(service_tier).toBe("standard_only");
    expect(inference_geo).toBe("global");
    expect(count).toEqual(input);
    expect(Object.keys(count).sort()).toEqual(["messages", "model", "output_config", "system", "thinking"]);
  });

  it.each([
    ["a PDF", first],
    ["the retry, with the previous answer", retry],
    ["an image", image],
  ])("OpenAI, %s", async (_, request) => {
    const { sent, fetch } = recorder((url) =>
      url.endsWith("/input_tokens")
        ? { object: "response.input_tokens", input_tokens: 2655 }
        : {
            id: "resp_1",
            object: "response",
            created_at: 0,
            status: "completed",
            model: "gpt-5-nano-2025-08-07",
            output: [],
            output_text: "{}",
            usage: { input_tokens: 2655, output_tokens: 10, total_tokens: 2665 },
          },
    );
    const client = new OpenAI({ apiKey: "test-not-a-key", baseURL: "https://api.openai.invalid/v1", maxRetries: 0, fetch, logLevel: "off" });
    const counted = await client.responses.inputTokens.count(openAICountParams(DEFAULT_MODELS.openai, request));
    await client.responses.create(openAICreateParams(DEFAULT_MODELS.openai, request));

    expect(counted.input_tokens).toBe(2655);
    expect(sent.map((s) => new URL(s.url).pathname)).toEqual(["/v1/responses/input_tokens", "/v1/responses"]);
    const [count, call] = sent.map((s) => s.body);
    const { max_output_tokens, service_tier, ...input } = call;
    expect(max_output_tokens).toBe(MAX_OUTPUT_TOKENS);
    // the standard tier; the region is the pinned base URL's (clients.ts)
    expect(service_tier).toBe("default");
    expect(count).toEqual(input);
    expect(Object.keys(count).sort()).toEqual(["input", "instructions", "model", "reasoning", "text"]);
  });
});

describe("what a call is billed at (V10)", () => {
  it("is decided for every model on file: the standard tier, and a geography for every Claude model", () => {
    expect(ANTHROPIC_SERVICE_TIER).toBe("standard_only");
    expect(OPENAI_SERVICE_TIER).toBe("default");
    for (const [model, price] of Object.entries(PRICING)) {
      if (price.provider !== "anthropic") continue;
      expect(() => anthropicInferenceGeo(model), model).not.toThrow();
    }
    expect(() => anthropicInferenceGeo("claude-unpriced-9")).toThrow(/no inference_geo decided/);
  });

  it("sends global routing to Sonnet 5 and no geography to Haiku 4.5, which refuses the parameter", () => {
    expect(anthropicCreateParams("claude-sonnet-5", first)).toMatchObject({ service_tier: "standard_only", inference_geo: "global" });
    const haiku = anthropicCreateParams("claude-haiku-4-5-20251001", first);
    expect(haiku.service_tier).toBe("standard_only");
    expect("inference_geo" in haiku).toBe(false);
    expect(openAICreateParams("gpt-5-nano", first).service_tier).toBe("default");
    // the counts carry neither
    expect("service_tier" in anthropicCountParams("claude-sonnet-5", first)).toBe(false);
    expect("service_tier" in openAICountParams("gpt-5-nano", first)).toBe(false);
  });
});

describe("a token count's answer", () => {
  it("is used only if it is a non-negative whole number", () => {
    expect(interpretTokenCount("anthropic", 0)).toBe(0);
    expect(interpretTokenCount("openai", 304_500)).toBe(304_500);
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "7500", null, undefined, 2 ** 60]) {
      expect(() => interpretTokenCount("anthropic", bad), String(bad)).toThrow(ProviderError);
    }
    try {
      interpretTokenCount("openai", "7500");
    } catch (error) {
      // not fallback-eligible: the provider answered, with something unusable
      expect(error).toMatchObject({ provider: "openai", kind: "client", status: undefined });
      expect((error as ProviderError).fallbackEligible).toBe(false);
    }
  });
});
