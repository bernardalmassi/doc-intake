// The SDK clients the providers call through, with every setting that
// decides where a request goes, and what it carries, fixed in code. Both
// SDKs otherwise read their base URL from the environment
// (ANTHROPIC_BASE_URL, OPENAI_BASE_URL), so a variable set by mistake or by
// someone with access to the host's settings would send the API key and
// every document to a server of their choosing. The base URL here is always
// the provider's own; the Anthropic client takes no bearer token and the
// OpenAI client no organization or project from the environment either.
//
// Each SDK also reads, when a client is built, *_CUSTOM_HEADERS, whose
// headers it adds to every request after its own, so they could replace the
// key, the API version or the organization, or add a beta, and *_LOG, which
// at "debug" writes every request, documents included, to the console. The
// clients here are built with those two variables withheld from the SDK
// (withheldFromSdk), and with logging off and a logger that writes nothing,
// so a request goes out as if they were unset, carrying only the key passed
// in, and nothing reaches the console from the SDK.
//
// maxRetries is 0 on purpose: the orchestrator decides what to retry and
// when to fall back.
//
// Not "server-only", like classify.ts: it reads no keys (the key is an
// argument) so tests/unit/provider-clients.test.ts can build the real
// clients over a fake fetch and check where they send requests. Only
// anthropic.ts and openai.ts construct clients (the same test checks).

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

export const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
export const OPENAI_BASE_URL = "https://api.openai.com/v1";

type ClientOptions = {
  apiKey: string;
  timeoutMs: number;
  // tests only: a fake in place of the network
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
};

// The variables each SDK reads only when a client is built, and which no
// client here may take from the environment.
export const WITHHELD_FROM_SDK = {
  anthropic: ["ANTHROPIC_CUSTOM_HEADERS", "ANTHROPIC_LOG"],
  openai: ["OPENAI_CUSTOM_HEADERS", "OPENAI_LOG"],
} as const;

const silent = { error: () => undefined, warn: () => undefined, info: () => undefined, debug: () => undefined };

// Builds a client with `names` absent from the environment, and puts them
// back as they were. Synchronous, so no other code runs in between.
function withheldFromSdk<T>(names: readonly string[], build: () => T): T {
  const saved = names.map((name) => [name, process.env[name]] as const);
  for (const name of names) delete process.env[name];
  try {
    return build();
  } finally {
    for (const [name, value] of saved) if (value !== undefined) process.env[name] = value;
  }
}

export function createAnthropicClient(options: ClientOptions): Anthropic {
  return withheldFromSdk(
    WITHHELD_FROM_SDK.anthropic,
    () =>
      new Anthropic({
        apiKey: options.apiKey,
        authToken: null,
        baseURL: ANTHROPIC_BASE_URL,
        timeout: options.timeoutMs,
        maxRetries: 0,
        logLevel: "off",
        logger: silent,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      }),
  );
}

export function createOpenAIClient(options: ClientOptions): OpenAI {
  return withheldFromSdk(
    WITHHELD_FROM_SDK.openai,
    () =>
      new OpenAI({
        apiKey: options.apiKey,
        organization: null,
        project: null,
        baseURL: OPENAI_BASE_URL,
        timeout: options.timeoutMs,
        maxRetries: 0,
        logLevel: "off",
        logger: silent,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      }),
  );
}
