// The one interface both providers implement. Holds no secrets itself, so
// the orchestrator can be unit tested with fakes.

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

  constructor(provider: ProviderName, kind: ProviderErrorKind, message: string, status?: number) {
    super(message);
    this.name = "ProviderError";
    this.provider = provider;
    this.kind = kind;
    this.status = status;
  }

  get fallbackEligible(): boolean {
    return this.kind === "transport" || this.kind === "server";
  }
}

// Error text that gets stored in extraction_runs.error. Kept short and
// scrubbed of anything that looks like a key, although the SDKs don't echo
// keys back.
export function describeError(error: unknown): string {
  const raw =
    error instanceof ProviderError
      ? `${error.provider} ${error.kind}${error.status ? ` ${error.status}` : ""}: ${error.message}`
      : error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
  return raw.replace(/\b(sk|key)-[A-Za-z0-9_-]{8,}/g, "[redacted]").slice(0, 2000);
}

export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}
