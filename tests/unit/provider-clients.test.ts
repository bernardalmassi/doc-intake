// Where the providers' SDK clients send requests
// (src/lib/extraction/providers/clients.ts), with no network: the real
// clients over a fake fetch, with the environment set the way someone who
// wanted the API key and the documents would set it. The base URL is the
// provider's own whatever ANTHROPIC_BASE_URL or OPENAI_BASE_URL say, and
// the only credential sent is the key passed in: no bearer token from
// ANTHROPIC_AUTH_TOKEN, no organization or project from OpenAI's variables.
// A client built without the pin does follow the variable, which is what
// the pin stops. And only clients.ts constructs a client in src/.
//
// Needs no database and no key.

import Anthropic from "@anthropic-ai/sdk";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MODELS, MAX_OUTPUT_TOKENS } from "@/lib/extraction/config";
import {
  ANTHROPIC_BASE_URL,
  createAnthropicClient,
  createOpenAIClient,
  OPENAI_BASE_URL,
} from "@/lib/extraction/providers/clients";
import { anthropicCountParams, anthropicCreateParams, openAICountParams, openAICreateParams } from "@/lib/extraction/providers/requests";
import type { ExtractionRequest } from "@/lib/extraction/providers/types";
import { buildJsonSchema, SYSTEM_PROMPT, userPrompt } from "@/lib/extraction/schema";
import { pdfBytes } from "../helpers/fake-provider";

const root = fileURLToPath(new URL("../..", import.meta.url));
const KEY = "test-not-a-key";

type Sent = { url: URL; headers: Headers };

function recorder(reply: (url: URL) => unknown) {
  const sent: Sent[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    sent.push({ url, headers: new Headers(init?.headers) });
    return new Response(JSON.stringify(reply(url)), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { sent, fetch };
}

const request: ExtractionRequest = {
  bytes: pdfBytes("clients"),
  mimeType: "application/pdf",
  systemPrompt: SYSTEM_PROMPT,
  userPrompt: userPrompt(),
  schema: buildJsonSchema(),
  maxOutputTokens: MAX_OUTPUT_TOKENS,
};

const anthropicReply = (url: URL) =>
  url.pathname.endsWith("/count_tokens")
    ? { input_tokens: 10 }
    : {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: DEFAULT_MODELS.anthropic,
        content: [{ type: "text", text: "{}" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      };

const openAIReply = (url: URL) =>
  url.pathname.endsWith("/input_tokens")
    ? { object: "response.input_tokens", input_tokens: 10 }
    : {
        id: "resp_1",
        object: "response",
        created_at: 0,
        status: "completed",
        model: "gpt-5-nano-2025-08-07",
        output: [],
        usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
      };

beforeEach(() => {
  // what a poisoned environment would hold
  vi.stubEnv("ANTHROPIC_BASE_URL", "https://collector.invalid/anthropic");
  vi.stubEnv("OPENAI_BASE_URL", "https://collector.invalid/openai/v1");
  vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "someone-elses-token");
  vi.stubEnv("OPENAI_ORG_ID", "org-someone-else");
  vi.stubEnv("OPENAI_PROJECT_ID", "proj_someone_else");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the providers' clients", () => {
  it("send Anthropic's count and call to api.anthropic.com, with the key passed in and nothing else", async () => {
    const { sent, fetch } = recorder(anthropicReply);
    const client = createAnthropicClient({ apiKey: KEY, timeoutMs: 1000, fetch });
    await client.messages.countTokens(anthropicCountParams(DEFAULT_MODELS.anthropic, request));
    await client.messages.create(anthropicCreateParams(DEFAULT_MODELS.anthropic, request));

    expect(sent).toHaveLength(2);
    for (const { url, headers } of sent) {
      expect(url.origin).toBe(new URL(ANTHROPIC_BASE_URL).origin);
      expect(headers.get("x-api-key")).toBe(KEY);
      expect(headers.get("authorization")).toBeNull();
    }
  });

  it("send OpenAI's count and call to api.openai.com, with the key passed in and no organization or project", async () => {
    const { sent, fetch } = recorder(openAIReply);
    const client = createOpenAIClient({ apiKey: KEY, timeoutMs: 1000, fetch });
    await client.responses.inputTokens.count(openAICountParams(DEFAULT_MODELS.openai, request));
    await client.responses.create(openAICreateParams(DEFAULT_MODELS.openai, request));

    expect(sent).toHaveLength(2);
    for (const { url, headers } of sent) {
      expect(url.origin).toBe(new URL(OPENAI_BASE_URL).origin);
      expect(url.pathname.startsWith("/v1/")).toBe(true);
      expect(headers.get("authorization")).toBe(`Bearer ${KEY}`);
      expect(headers.get("openai-organization")).toBeNull();
      expect(headers.get("openai-project")).toBeNull();
    }
  });

  it("would follow the environment without the pin: the variables are live in this test", async () => {
    const anthropic = recorder(anthropicReply);
    await new Anthropic({ apiKey: KEY, maxRetries: 0, fetch: anthropic.fetch }).messages.countTokens(
      anthropicCountParams(DEFAULT_MODELS.anthropic, request),
    );
    expect(anthropic.sent[0].url.host).toBe("collector.invalid");

    const openai = recorder(openAIReply);
    await new OpenAI({ apiKey: KEY, maxRetries: 0, fetch: openai.fetch }).responses.inputTokens.count(
      openAICountParams(DEFAULT_MODELS.openai, request),
    );
    expect(openai.sent[0].url.host).toBe("collector.invalid");
  });

  it("are the only ones src/ constructs", () => {
    const files = (function walk(dir: string): string[] {
      return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return walk(path);
        return /\.tsx?$/.test(entry.name) ? [path] : [];
      });
    })(join(root, "src"));
    const constructing = files
      .filter((path) => /\bnew\s+(Anthropic|OpenAI)\s*\(/.test(readFileSync(path, "utf8")))
      .map((path) => relative(root, path));
    expect(constructing).toEqual(["src/lib/extraction/providers/clients.ts"]);
  });
});
