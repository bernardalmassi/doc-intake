// Each provider's model call and token count, each held to its timeout for
// the whole of it: sending the request, waiting for the headers and reading
// the body. The SDKs time a request only until its response headers arrive
// (the Anthropic SDK clears its timer as soon as fetch resolves, and then
// waits on response.json() with no timer; the OpenAI SDK races the body
// against what is left, as of 7.17). So each request here gets an
// AbortSignal that is aborted when its time is up, which stops the fetch
// and a body still being read, and the call rejects then, with a transport
// timeout, whatever the SDK is still waiting on (withinTimeout).
//
// Not "server-only", like classify.ts and requests.ts: it takes a client
// and reads no keys, so tests/unit/provider-timeouts.test.ts runs it with
// the real SDK clients over a fake fetch whose body never ends.
// anthropic.ts and openai.ts build the clients and call these.

import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import { classifyAnthropicError, classifyOpenAIError } from "./classify";
import { interpretAnthropicMessage, interpretOpenAIResponse, interpretTokenCount } from "./interpret";
import { anthropicCountParams, anthropicCreateParams, openAICountParams, openAICreateParams } from "./requests";
import { ProviderError, type ExtractionRequest, type ProviderName, type ProviderResponse } from "./types";

// Runs one request, handing it a signal to pass to the SDK, and settles
// within timeoutMs: when the time is up the signal is aborted and the call
// rejects with a transport ProviderError ("request timed out"), as a
// timeout before the headers does, so the orchestrator charges it as a call
// that got no answer and may fall back. An error the request throws before
// then goes to `classify`.
export async function withinTimeout<T>(
  provider: ProviderName,
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
  classify: (error: unknown) => ProviderError,
): Promise<T> {
  const controller = new AbortController();
  const timedOut = () => new ProviderError(provider, "transport", "request timed out");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(timedOut());
    }, timeoutMs);
  });
  const running = run(controller.signal);
  // whichever loses the race settles later; its outcome is not wanted
  running.catch(() => undefined);
  try {
    return await Promise.race([running, deadline]);
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    // the SDK's own error for our abort is still a timeout
    if (controller.signal.aborted) throw timedOut();
    throw classify(error);
  } finally {
    clearTimeout(timer);
  }
}

export async function anthropicCountTokens(
  client: Anthropic,
  model: string,
  request: ExtractionRequest,
  timeoutMs: number,
): Promise<number> {
  const counted = await withinTimeout(
    "anthropic",
    timeoutMs,
    (signal) => client.messages.countTokens(anthropicCountParams(model, request), { signal, timeout: timeoutMs }),
    classifyAnthropicError,
  );
  return interpretTokenCount("anthropic", counted.input_tokens);
}

export async function anthropicExtract(
  client: Anthropic,
  model: string,
  request: ExtractionRequest,
  timeoutMs: number,
): Promise<ProviderResponse> {
  const message = await withinTimeout(
    "anthropic",
    timeoutMs,
    (signal) => client.messages.create(anthropicCreateParams(model, request), { signal, timeout: timeoutMs }),
    classifyAnthropicError,
  );
  return interpretAnthropicMessage(message, request.maxOutputTokens);
}

export async function openAICountTokens(
  client: OpenAI,
  model: string,
  request: ExtractionRequest,
  timeoutMs: number,
): Promise<number> {
  const counted = await withinTimeout(
    "openai",
    timeoutMs,
    (signal) => client.responses.inputTokens.count(openAICountParams(model, request), { signal, timeout: timeoutMs }),
    classifyOpenAIError,
  );
  return interpretTokenCount("openai", counted.input_tokens);
}

export async function openAIExtract(
  client: OpenAI,
  model: string,
  request: ExtractionRequest,
  timeoutMs: number,
): Promise<ProviderResponse> {
  const response = await withinTimeout(
    "openai",
    timeoutMs,
    (signal) => client.responses.create(openAICreateParams(model, request), { signal, timeout: timeoutMs }),
    classifyOpenAIError,
  );
  return interpretOpenAIResponse(response, request.maxOutputTokens);
}
