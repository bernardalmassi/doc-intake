// The SDK clients the providers call through, with every setting that
// decides where a request goes, and what it carries, fixed in code. Both
// SDKs otherwise read their base URL from the environment
// (ANTHROPIC_BASE_URL, OPENAI_BASE_URL), so a variable set by mistake or by
// someone with access to the host's settings would send the API key and
// every document to a server of their choosing. The base URL here is always
// the provider's own; the Anthropic client takes no bearer token and the
// OpenAI client no organization or project from the environment either, so
// the only credential sent is the key passed in.
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

export function createAnthropicClient(options: ClientOptions): Anthropic {
  return new Anthropic({
    apiKey: options.apiKey,
    authToken: null,
    baseURL: ANTHROPIC_BASE_URL,
    timeout: options.timeoutMs,
    maxRetries: 0,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}

export function createOpenAIClient(options: ClientOptions): OpenAI {
  return new OpenAI({
    apiKey: options.apiKey,
    organization: null,
    project: null,
    baseURL: OPENAI_BASE_URL,
    timeout: options.timeoutMs,
    maxRetries: 0,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}
