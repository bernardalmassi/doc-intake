import "server-only";

import {
  DEFAULT_MODELS,
  DEFAULT_PROVIDER,
  PROVIDER_ENV_VAR,
  PROVIDER_TIMEOUT_MS,
  type ProviderName,
} from "../config";
import { createAnthropicProvider } from "./anthropic";
import { createOpenAIProvider } from "./openai";
import type { ExtractionProvider } from "./types";

export type ProviderPair = {
  primary: ExtractionProvider;
  // the other provider, if its key is configured
  fallback: ExtractionProvider | null;
};

const KEY_ENV_VARS: Record<ProviderName, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

function isProviderName(value: string | undefined): value is ProviderName {
  return value === "anthropic" || value === "openai";
}

// Keys are read here and nowhere else, passed straight into the SDK
// clients, and never returned, logged or put in an error message.
function build(name: ProviderName): ExtractionProvider | null {
  const apiKey = process.env[KEY_ENV_VARS[name]];
  if (!apiKey) return null;
  const options = { apiKey, model: DEFAULT_MODELS[name], timeoutMs: PROVIDER_TIMEOUT_MS };
  return name === "anthropic" ? createAnthropicProvider(options) : createOpenAIProvider(options);
}

export function selectProviders(): ProviderPair {
  const configured = process.env[PROVIDER_ENV_VAR];
  if (configured !== undefined && !isProviderName(configured)) {
    throw new Error(`${PROVIDER_ENV_VAR} must be "anthropic" or "openai"`);
  }
  const primaryName: ProviderName = configured ?? DEFAULT_PROVIDER;
  const fallbackName: ProviderName = primaryName === "anthropic" ? "openai" : "anthropic";

  const primary = build(primaryName);
  if (!primary) {
    throw new Error(`extraction is not configured: ${KEY_ENV_VARS[primaryName]} is not set`);
  }
  return { primary, fallback: build(fallbackName) };
}
