// Where the providers' SDK clients send requests
// (src/lib/extraction/providers/clients.ts), with no network: the real
// clients over a fake fetch, with the environment set the way someone who
// wanted the API key and the documents would set it. The base URL is the
// provider's own whatever ANTHROPIC_BASE_URL or OPENAI_BASE_URL say, and
// the only credential sent is the key passed in: no bearer token from
// ANTHROPIC_AUTH_TOKEN, no organization or project from OpenAI's variables,
// and nothing from ANTHROPIC_CUSTOM_HEADERS or OPENAI_CUSTOM_HEADERS, which
// would add or replace any header; and ANTHROPIC_LOG or OPENAI_LOG at
// "debug" puts nothing on the console. A client built without the pin does
// follow each variable, which is what the pin stops. And only clients.ts
// constructs a client in src/.
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
  WITHHELD_FROM_SDK,
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

describe("the SDKs' own variables for headers and logging (V8)", () => {
  // headers that would replace the key, the API version or the organization,
  // add a beta, or add anything at all; and debug logging, which writes
  // whole requests, documents included
  const PLANTED = {
    ANTHROPIC_CUSTOM_HEADERS: "x-api-key: planted-key\nanthropic-version: 2099-01-01\nanthropic-beta: planted-beta\nX-Planted: anthropic",
    OPENAI_CUSTOM_HEADERS: "Authorization: Bearer planted-key\nOpenAI-Organization: org-planted\nX-Planted: openai",
    ANTHROPIC_LOG: "debug",
    OPENAI_LOG: "debug",
  };

  beforeEach(() => {
    for (const [name, value] of Object.entries(PLANTED)) vi.stubEnv(name, value);
  });

  function consoleSpies() {
    return (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reach neither a request nor the console through clients.ts, and are left in the environment as they were", async () => {
    const spies = consoleSpies();
    const anthropic = recorder(anthropicReply);
    const a = createAnthropicClient({ apiKey: KEY, timeoutMs: 1000, fetch: anthropic.fetch });
    await a.messages.countTokens(anthropicCountParams(DEFAULT_MODELS.anthropic, request));
    await a.messages.create(anthropicCreateParams(DEFAULT_MODELS.anthropic, request));
    const openai = recorder(openAIReply);
    const o = createOpenAIClient({ apiKey: KEY, timeoutMs: 1000, fetch: openai.fetch });
    await o.responses.inputTokens.count(openAICountParams(DEFAULT_MODELS.openai, request));
    await o.responses.create(openAICreateParams(DEFAULT_MODELS.openai, request));

    expect(anthropic.sent).toHaveLength(2);
    expect(openai.sent).toHaveLength(2);
    for (const { headers } of anthropic.sent) {
      expect(headers.get("x-api-key")).toBe(KEY);
      expect(headers.get("anthropic-version")).toBe("2023-06-01");
      expect(headers.get("anthropic-beta")).toBeNull();
      expect(headers.get("x-planted")).toBeNull();
    }
    for (const { headers } of openai.sent) {
      expect(headers.get("authorization")).toBe(`Bearer ${KEY}`);
      expect(headers.get("openai-organization")).toBeNull();
      expect(headers.get("x-planted")).toBeNull();
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    for (const [name, value] of Object.entries(PLANTED)) expect(process.env[name]).toBe(value);
    expect([...WITHHELD_FROM_SDK.anthropic, ...WITHHELD_FROM_SDK.openai].sort()).toEqual(Object.keys(PLANTED).sort());
  });

  it("would reach both without it: the variables are live in this test", async () => {
    const spies = consoleSpies();
    const anthropic = recorder(anthropicReply);
    await new Anthropic({ apiKey: KEY, baseURL: ANTHROPIC_BASE_URL, maxRetries: 0, fetch: anthropic.fetch }).messages.countTokens(
      anthropicCountParams(DEFAULT_MODELS.anthropic, request),
    );
    expect(anthropic.sent[0].headers.get("x-api-key")).toBe("planted-key");
    expect(anthropic.sent[0].headers.get("x-planted")).toBe("anthropic");

    const openai = recorder(openAIReply);
    await new OpenAI({ apiKey: KEY, baseURL: OPENAI_BASE_URL, maxRetries: 0, fetch: openai.fetch }).responses.inputTokens.count(
      openAICountParams(DEFAULT_MODELS.openai, request),
    );
    expect(openai.sent[0].headers.get("authorization")).toBe("Bearer planted-key");
    expect(openai.sent[0].headers.get("x-planted")).toBe("openai");
    // debug logging wrote to the console
    expect(spies.some((spy) => spy.mock.calls.length > 0)).toBe(true);
  });
});
