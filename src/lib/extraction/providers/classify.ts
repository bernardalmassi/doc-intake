// Turns whatever an SDK call threw into a ProviderError, which decides
// whether the orchestrator may switch to the fallback provider: a timeout or
// a failed connection (no HTTP response) is "transport", a 5xx is "server",
// both fall back; any other status (400, 401, 403, 404, 429, ...) is
// "client" and does not.
//
// It lives apart from anthropic.ts and openai.ts because those import
// "server-only" and so can't be loaded by tests. This module reads no keys
// and holds no secrets; it only uses the SDKs' error classes, so
// tests/unit/provider-errors.test.ts can feed it errors thrown by real SDK
// clients running against a fake fetch.

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { ProviderError } from "./types";

export function classifyAnthropicError(error: unknown): ProviderError {
  // Most specific first. Timeouts are a connection error subclass.
  if (error instanceof Anthropic.APIConnectionError) {
    const timedOut = error instanceof Anthropic.APIConnectionTimeoutError;
    return new ProviderError("anthropic", "transport", timedOut ? "request timed out" : "connection failed");
  }
  if (error instanceof Anthropic.APIError) {
    const status = typeof error.status === "number" ? error.status : undefined;
    const kind = status !== undefined && status >= 500 ? "server" : "client";
    return new ProviderError("anthropic", kind, error.message, status);
  }
  return new ProviderError("anthropic", "client", error instanceof Error ? error.message : String(error));
}

export function classifyOpenAIError(error: unknown): ProviderError {
  if (error instanceof OpenAI.APIConnectionError) {
    const timedOut = error instanceof OpenAI.APIConnectionTimeoutError;
    return new ProviderError("openai", "transport", timedOut ? "request timed out" : "connection failed");
  }
  if (error instanceof OpenAI.APIError) {
    const status = typeof error.status === "number" ? error.status : undefined;
    const kind = status !== undefined && status >= 500 ? "server" : "client";
    return new ProviderError("openai", kind, error.message, status);
  }
  return new ProviderError("openai", "client", error instanceof Error ? error.message : String(error));
}
