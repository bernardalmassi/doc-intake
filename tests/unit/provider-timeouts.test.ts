// A provider call's timeout covers the whole call, reading the response
// body included (src/lib/extraction/providers/calls.ts), for both SDKs and
// for both the model call and the token count. The real clients
// (clients.ts) run over a fake fetch that answers with 200 and JSON
// headers at once and then a body that never ends, as a stalled
// connection or proxy would. Each call must reject at its timeout with a
// transport ProviderError (so the orchestrator charges it as a call that
// got no answer and may fall back), and must have aborted the request, so
// the body's read stops too. The Anthropic SDK times a request only until
// its headers arrive, so without calls.ts its call would wait on this body
// for as long as the connection stays open. Needs no network and no key.

import { describe, expect, it } from "vitest";
import { MAX_OUTPUT_TOKENS } from "@/lib/extraction/config";
import {
  anthropicCountTokens,
  anthropicExtract,
  openAICountTokens,
  openAIExtract,
  withinTimeout,
} from "@/lib/extraction/providers/calls";
import { createAnthropicClient, createOpenAIClient } from "@/lib/extraction/providers/clients";
import { ProviderError, type ExtractionRequest } from "@/lib/extraction/providers/types";
import { buildJsonSchema, SYSTEM_PROMPT, userPrompt } from "@/lib/extraction/schema";
import { pdfBytes } from "../helpers/fake-provider";

const TIMEOUT_MS = 150;

const request: ExtractionRequest = {
  bytes: pdfBytes("timeouts"),
  mimeType: "application/pdf",
  systemPrompt: SYSTEM_PROMPT,
  userPrompt: userPrompt(),
  schema: buildJsonSchema(),
  maxOutputTokens: MAX_OUTPUT_TOKENS,
};

// Headers at once, then the start of a JSON body and nothing more until the
// request is aborted, when the body fails as a real one would.
function stalledBody() {
  const aborted: boolean[] = [];
  const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    const signal = init?.signal;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"id":"x","type":"mess'));
        signal?.addEventListener("abort", () => {
          aborted.push(true);
          controller.error(new DOMException("The operation was aborted.", "AbortError"));
        });
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetch, aborted };
}

const CALLS = [
  ["Anthropic's model call", (fetch: typeof globalThis.fetch) =>
    anthropicExtract(createAnthropicClient({ apiKey: "k", timeoutMs: TIMEOUT_MS, fetch }), "claude-sonnet-5", request, TIMEOUT_MS)],
  ["Anthropic's token count", (fetch: typeof globalThis.fetch) =>
    anthropicCountTokens(createAnthropicClient({ apiKey: "k", timeoutMs: TIMEOUT_MS, fetch }), "claude-sonnet-5", request, TIMEOUT_MS)],
  ["OpenAI's model call", (fetch: typeof globalThis.fetch) =>
    openAIExtract(createOpenAIClient({ apiKey: "k", timeoutMs: TIMEOUT_MS, fetch }), "gpt-5-nano", request, TIMEOUT_MS)],
  ["OpenAI's token count", (fetch: typeof globalThis.fetch) =>
    openAICountTokens(createOpenAIClient({ apiKey: "k", timeoutMs: TIMEOUT_MS, fetch }), "gpt-5-nano", request, TIMEOUT_MS)],
] as const;

describe("a provider call's timeout", () => {
  it.each(CALLS)("covers %s's whole response, body included", async (_, call) => {
    const { fetch, aborted } = stalledBody();
    const started = Date.now();
    const error = await call(fetch).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    const took = Date.now() - started;
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ kind: "transport", status: undefined, message: "request timed out" });
    expect((error as ProviderError).fallbackEligible).toBe(true);
    expect(took).toBeGreaterThanOrEqual(TIMEOUT_MS - 20);
    expect(took).toBeLessThan(TIMEOUT_MS + 1000);
    // the request was aborted, so the body's read stopped
    expect(aborted.length).toBeGreaterThan(0);
  });

  it("settles on time even if the request ignores its signal", async () => {
    const never = new Promise<never>(() => undefined);
    const started = Date.now();
    await expect(
      withinTimeout("anthropic", TIMEOUT_MS, () => never, () => new ProviderError("anthropic", "client", "unused")),
    ).rejects.toMatchObject({ kind: "transport", message: "request timed out" });
    expect(Date.now() - started).toBeLessThan(TIMEOUT_MS + 1000);
  });

  it("passes an answer that comes in time through, and classifies an error that isn't the timeout", async () => {
    await expect(withinTimeout("openai", 1000, async () => 42, () => new ProviderError("openai", "client", "x"))).resolves.toBe(42);
    const refused = new ProviderError("openai", "client", "refused", 400);
    await expect(
      withinTimeout("openai", 1000, async () => {
        throw new Error("sdk error");
      }, () => refused),
    ).rejects.toBe(refused);
  });
});
