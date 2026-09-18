// The one interface both providers implement. Holds no secrets itself, so
// the orchestrator can be unit tested with fakes.

import { redact } from "../../redact";
import type { ProviderName } from "../config";
import type { SupportedMimeType } from "../sniff";

export type { ProviderName };

export type ExtractionRequest = {
  bytes: Uint8Array;
  mimeType: SupportedMimeType;
  filename: string;
  systemPrompt: string;
  userPrompt: string;
  // JSON schema the provider must constrain its output to
  schema: Record<string, unknown>;
  maxOutputTokens: number;
  // present on the validation retry: the previous answer and what was
  // wrong with it, so the model can correct it
  previousAttempt?: { rawResponse: string; retryPrompt: string };
};

export type ProviderResponse = {
  text: string;
  inputTokens: number;
  outputTokens: number;
  // the model id the provider reports having used
  model: string;
};

// What a call consumed. Carried by a ProviderError when the provider
// answered and billed the call but the answer can't be used (a refusal, an
// answer cut off at the output cap), so the run still counts it.
export type ProviderUsage = Pick<ProviderResponse, "inputTokens" | "outputTokens" | "model">;

export interface ExtractionProvider {
  readonly name: ProviderName;
  readonly model: string;
  extract(request: ExtractionRequest): Promise<ProviderResponse>;
}

// transport: no HTTP response (timeout, connection reset). server: a 5xx.
// Both are grounds for the fallback provider. Everything else is not.
export type ProviderErrorKind = "transport" | "server" | "client" | "refusal" | "truncated";

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly provider: ProviderName;
  readonly status: number | undefined;
  readonly usage: ProviderUsage | undefined;

  constructor(provider: ProviderName, kind: ProviderErrorKind, message: string, status?: number, usage?: ProviderUsage) {
    super(message);
    this.name = "ProviderError";
    this.provider = provider;
    this.kind = kind;
    this.status = status;
    this.usage = usage;
  }

  get fallbackEligible(): boolean {
    return this.kind === "transport" || this.kind === "server";
  }
}

// Error text that gets stored in extraction_runs.error, which every member
// of the tenant can read. Scrubbed by the same rules as log lines
// (src/lib/redact.ts: registered API keys, key and token shapes, URL query
// strings, data: URLs), although the SDKs don't echo keys back, then capped.
// Never throws: it runs inside catch blocks.
export function describeError(error: unknown): string {
  let raw: string;
  try {
    raw =
      error instanceof ProviderError
        ? `${error.provider} ${error.kind}${error.status ? ` ${error.status}` : ""}: ${error.message}`
        : error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error);
  } catch {
    raw = "an error that could not be described";
  }
  return redact(raw).slice(0, 2000);
}

export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}
