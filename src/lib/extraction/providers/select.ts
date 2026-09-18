import "server-only";

import { log } from "../../log";
import { registerSecret } from "../../redact";
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
// clients, and never returned, logged or put in an error message. Each is
// registered with the redactor as it is read, so its exact value is
// scrubbed from every log line and stored error from then on.
function build(name: ProviderName): ExtractionProvider | null {
  const apiKey = process.env[KEY_ENV_VARS[name]];
  if (!apiKey) return null;
  registerSecret(apiKey);
  const options = { apiKey, model: DEFAULT_MODELS[name], timeoutMs: PROVIDER_TIMEOUT_MS };
  return name === "anthropic" ? createAnthropicProvider(options) : createOpenAIProvider(options);
}

export function selectProviders(): ProviderPair {
  const configured = process.env[PROVIDER_ENV_VAR];
  if (configured !== undefined && !isProviderName(configured)) {
    // not the value itself: it is whatever someone typed into the env
    log.error("extraction.not_configured", { error_code: "invalid_provider_setting" });
    throw new Error(`${PROVIDER_ENV_VAR} must be "anthropic" or "openai"`);
  }
  const primaryName: ProviderName = configured ?? DEFAULT_PROVIDER;
  const fallbackName: ProviderName = primaryName === "anthropic" ? "openai" : "anthropic";

  const primary = build(primaryName);
  if (!primary) {
    log.error("extraction.not_configured", { primary_provider: primaryName, error_code: "primary_key_missing" });
    throw new Error(`extraction is not configured: ${KEY_ENV_VARS[primaryName]} is not set`);
  }
  const fallback = build(fallbackName);
  // which providers have a key, never the key
  log.info("extraction.providers_selected", {
    primary_provider: primary.name,
    fallback_provider: fallback?.name ?? null,
  });
  return { primary, fallback };
}
