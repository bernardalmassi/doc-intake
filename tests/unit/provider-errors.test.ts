// Provider error classification (providers/classify.ts) against the real
// SDKs, with no network. Each test builds a real Anthropic or OpenAI client
// whose fetch is a fake that never answers, can't connect, or returns a
// chosen HTTP status, so what reaches the classifier is exactly what the SDK
// throws in production:
//
//   - the SDK's own timeout, and a failed connection: "transport", which
//     falls back to the other provider
//   - 500, 502, 503 and Anthropic's 529 (overloaded): "server", which falls
//     back
//   - 400, 401, 403, 404 and 429: "client", which does not
//
// The last block runs the orchestrator with a provider built on a real SDK
// client, to show that a real timeout (not a fake one) is what triggers the
// fallback, and that when both providers really fail the run names both.
//
// The clients are built the way the providers build theirs (maxRetries 0, an
// explicit timeout, here 50 ms), with a key that isn't one and a base URL
// under .invalid, a name that can never resolve, so no request could leave
// the machine even if the fake fetch were somehow bypassed.
//
// Why a 429 does not fall back: it means our account is over its rate limit
// or, for OpenAI, out of quota (insufficient_quota is a 429). That is ours to
// wait out or fix, not the provider being down. Falling back would quietly
// shift every run onto the other provider, and its bill, until someone
// noticed; failing puts the provider's message in front of the admin
// instead. A provider that is itself overloaded answers with a 5xx
// (Anthropic's 529), and that does fall back.

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { DEFAULT_MODELS, type ProviderName } from "@/lib/extraction/config";
import { classifyAnthropicError, classifyOpenAIError } from "@/lib/extraction/providers/classify";
import { describeError, type ExtractionProvider, type ProviderError } from "@/lib/extraction/providers/types";
import { runExtraction } from "@/lib/extraction/run";
import { answer, fakeProvider, pdfBytes, validJson } from "../helpers/fake-provider";

// the shape both SDKs accept for their `fetch` option
type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const NOT_A_KEY = "test-not-a-key";
const TIMEOUT_MS = 50;

type FakeFetch = { fetch: Fetch; requests: { url: string; init: RequestInit | undefined }[] };

// Records every request, then lets `respond` decide what happens to it.
function fakeFetch(respond: (init: RequestInit | undefined) => Promise<Response>): FakeFetch {
  const requests: FakeFetch["requests"] = [];
  const fetch: Fetch = (input, init) => {
    requests.push({ url: input instanceof Request ? input.url : String(input), init });
    return respond(init);
  };
  return { fetch, requests };
}

// Never answers. Rejects only when the request is aborted, which here can
// only be the SDK's own timeout, the way fetch does.
function hangs(): FakeFetch {
  return fakeFetch(
    (init) =>
      new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error("the SDK gave fetch no abort signal"));
          return;
        }
        signal.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")), {
          once: true,
        });
      }),
  );
}

// What Node's fetch throws when nothing is listening.
function cantConnect(): FakeFetch {
  return fakeFetch(async () => {
    throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:443") });
  });
}

function answersWith(status: number, body: unknown): FakeFetch {
  return fakeFetch(
    async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
}

// Error bodies in each API's documented shape. Only the status matters to
// the classifier; the bodies make the SDKs' messages realistic.
const ANTHROPIC_ERROR_TYPES: Record<number, string> = {
  400: "invalid_request_error",
  401: "authentication_error",
  403: "permission_error",
  404: "not_found_error",
  429: "rate_limit_error",
  529: "overloaded_error",
};

function anthropicErrorBody(status: number) {
  const type = ANTHROPIC_ERROR_TYPES[status] ?? "api_error";
  return { type: "error", error: { type, message: `test ${type}` } };
}

function openAIErrorBody(status: number) {
  return { error: { message: status === 502 ? "Bad gateway" : `test error ${status}`, type: "test_error", param: null, code: null } };
}

function anthropicClient(fetch: Fetch) {
  return new Anthropic({
    apiKey: NOT_A_KEY,
    baseURL: "https://api.anthropic.invalid",
    maxRetries: 0,
    timeout: TIMEOUT_MS,
    fetch,
    logLevel: "off",
  });
}

function openAIClient(fetch: Fetch) {
  return new OpenAI({
    apiKey: NOT_A_KEY,
    baseURL: "https://api.openai.invalid/v1",
    maxRetries: 0,
    timeout: TIMEOUT_MS,
    fetch,
    logLevel: "off",
  });
}

// One call through the real SDK, the same endpoint the provider uses.
// Returns what it threw; every fake fetch here makes it throw.
async function thrownBy(provider: ProviderName, fetch: Fetch, maxOutputTokens = 16): Promise<unknown> {
  try {
    if (provider === "anthropic") {
      await anthropicClient(fetch).messages.create({
        model: DEFAULT_MODELS.anthropic,
        max_tokens: maxOutputTokens,
        messages: [{ role: "user", content: "hello" }],
      });
    } else {
      await openAIClient(fetch).responses.create({
        model: DEFAULT_MODELS.openai,
        input: "hello",
        max_output_tokens: maxOutputTokens,
      });
    }
  } catch (error) {
    return error;
  }
  throw new Error(`the ${provider} call was expected to fail`);
}

function summary(error: ProviderError) {
  return {
    provider: error.provider,
    kind: error.kind,
    status: error.status,
    fallbackEligible: error.fallbackEligible,
  };
}

const SDKS = [
  {
    provider: "anthropic" as const,
    classify: classifyAnthropicError,
    errorBody: anthropicErrorBody,
    baseURL: "https://api.anthropic.invalid/",
    TimeoutError: Anthropic.APIConnectionTimeoutError,
    ConnectionError: Anthropic.APIConnectionError,
    ServerError: Anthropic.InternalServerError,
    clientErrors: {
      400: Anthropic.BadRequestError,
      401: Anthropic.AuthenticationError,
      403: Anthropic.PermissionDeniedError,
      404: Anthropic.NotFoundError,
      429: Anthropic.RateLimitError,
    },
  },
  {
    provider: "openai" as const,
    classify: classifyOpenAIError,
    errorBody: openAIErrorBody,
    baseURL: "https://api.openai.invalid/v1/",
    TimeoutError: OpenAI.APIConnectionTimeoutError,
    ConnectionError: OpenAI.APIConnectionError,
    ServerError: OpenAI.InternalServerError,
    clientErrors: {
      400: OpenAI.BadRequestError,
      401: OpenAI.AuthenticationError,
      403: OpenAI.PermissionDeniedError,
      404: OpenAI.NotFoundError,
      429: OpenAI.RateLimitError,
    },
  },
];

describe.each(SDKS.map((sdk) => [sdk.provider, sdk] as const))("%s SDK errors", (_, sdk) => {
  it("the SDK's own timeout is transport, and falls back", async () => {
    const fake = hangs();
    const thrown = await thrownBy(sdk.provider, fake.fetch);

    expect(thrown).toBeInstanceOf(sdk.TimeoutError);
    // one request, to the fake, aborted by the SDK's timer, not retried
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0].url.startsWith(sdk.baseURL)).toBe(true);
    expect(fake.requests[0].init?.signal?.aborted).toBe(true);

    const classified = sdk.classify(thrown);
    expect(summary(classified)).toEqual({ provider: sdk.provider, kind: "transport", status: undefined, fallbackEligible: true });
    expect(classified.message).toBe("request timed out");
  });

  it("a failed connection is transport, and falls back", async () => {
    const fake = cantConnect();
    const thrown = await thrownBy(sdk.provider, fake.fetch);

    expect(thrown).toBeInstanceOf(sdk.ConnectionError);
    expect(thrown).not.toBeInstanceOf(sdk.TimeoutError);
    expect(fake.requests).toHaveLength(1);

    const classified = sdk.classify(thrown);
    expect(summary(classified)).toEqual({ provider: sdk.provider, kind: "transport", status: undefined, fallbackEligible: true });
    expect(classified.message).toBe("connection failed");
  });

  it.each([500, 502, 503, 529])("a %i is server, and falls back", async (status) => {
    const fake = answersWith(status, sdk.errorBody(status));
    const thrown = await thrownBy(sdk.provider, fake.fetch);

    expect(thrown).toBeInstanceOf(sdk.ServerError);
    expect(fake.requests).toHaveLength(1);

    const classified = sdk.classify(thrown);
    expect(summary(classified)).toEqual({ provider: sdk.provider, kind: "server", status, fallbackEligible: true });
    expect(describeError(classified)).toMatch(new RegExp(`^${sdk.provider} server ${status}: ${status} `));
    expect(describeError(classified)).not.toContain(NOT_A_KEY);
  });

  it.each([400, 401, 403, 404, 429] as const)("a %i is client, and does not fall back", async (status) => {
    const fake = answersWith(status, sdk.errorBody(status));
    const thrown = await thrownBy(sdk.provider, fake.fetch);

    expect(thrown).toBeInstanceOf(sdk.clientErrors[status]);
    expect(fake.requests).toHaveLength(1);

    const classified = sdk.classify(thrown);
    expect(summary(classified)).toEqual({ provider: sdk.provider, kind: "client", status, fallbackEligible: false });
    expect(describeError(classified)).not.toContain(NOT_A_KEY);
  });

  it("anything that isn't an SDK error is client, and does not fall back", () => {
    const bug = sdk.classify(new TypeError("Cannot read properties of undefined"));
    expect(summary(bug)).toEqual({ provider: sdk.provider, kind: "client", status: undefined, fallbackEligible: false });
    expect(bug.message).toBe("Cannot read properties of undefined");
    expect(sdk.classify("a thrown string").kind).toBe("client");
  });
});

describe("through the orchestrator, with real SDK errors", () => {
  // Stands in for providers/anthropic.ts and openai.ts, which import
  // "server-only" and can't be loaded here: a real SDK call whose error goes
  // through the real classifier, which is the part of a provider that
  // decides whether the run falls back.
  function sdkBacked(provider: ProviderName, fetch: Fetch): ExtractionProvider {
    const classify = provider === "anthropic" ? classifyAnthropicError : classifyOpenAIError;
    return {
      name: provider,
      model: DEFAULT_MODELS[provider],
      async countInputTokens() {
        return 1000;
      },
      async extract(request) {
        throw classify(await thrownBy(provider, fetch, request.maxOutputTokens));
      },
    };
  }

  const input = { bytes: pdfBytes("sdk"), mimeType: "application/pdf" as const, filename: "sdk.pdf", pages: 1 };

  it("a real SDK timeout on the primary is answered by the fallback", async () => {
    const primaryFetch = hangs();
    const fallback = fakeProvider("openai", "gpt-5-nano", [answer(validJson(), "gpt-5-nano-2025-08-07", 700, 60)]);
    const outcome = await runExtraction({ ...input, primary: sdkBacked("anthropic", primaryFetch.fetch), fallback });

    expect(primaryFetch.requests).toHaveLength(1);
    expect(fallback.requests).toHaveLength(1);
    expect(outcome).toMatchObject({ status: "succeeded", provider: "openai", attempts: 2, inputTokens: 700 });
  });

  it("a real 529 on the primary is answered by the fallback", async () => {
    const primaryFetch = answersWith(529, anthropicErrorBody(529));
    const fallback = fakeProvider("openai", "gpt-5-nano", [answer(validJson(), "gpt-5-nano-2025-08-07", 700, 60)]);
    const outcome = await runExtraction({ ...input, primary: sdkBacked("anthropic", primaryFetch.fetch), fallback });

    expect(outcome).toMatchObject({ status: "succeeded", provider: "openai", attempts: 2 });
  });

  it("a real 429 on the primary fails the run without trying the fallback", async () => {
    const primaryFetch = answersWith(429, anthropicErrorBody(429));
    const fallback = fakeProvider("openai", "gpt-5-nano", [answer(validJson(), "gpt-5-nano-2025-08-07")]);
    const outcome = await runExtraction({ ...input, primary: sdkBacked("anthropic", primaryFetch.fetch), fallback });

    expect(fallback.requests).toHaveLength(0);
    expect(outcome).toMatchObject({ status: "failed", provider: "anthropic", attempts: 1 });
    if (outcome.status === "failed") expect(outcome.error).toMatch(/^anthropic client 429: 429 /);
  });

  it("when both providers really fail, the run's error names both", async () => {
    const primaryFetch = hangs();
    const fallbackFetch = answersWith(502, openAIErrorBody(502));
    const outcome = await runExtraction({
      ...input,
      primary: sdkBacked("anthropic", primaryFetch.fetch),
      fallback: sdkBacked("openai", fallbackFetch.fetch),
    });

    expect(primaryFetch.requests).toHaveLength(1);
    expect(fallbackFetch.requests).toHaveLength(1);
    expect(outcome).toMatchObject({ status: "failed", provider: "openai", attempts: 2, inputTokens: 0, rawResponse: null });
    if (outcome.status === "failed") {
      expect(outcome.error).toBe("anthropic transport: request timed out; fallback openai server 502: 502 Bad gateway");
    }
  });
});
