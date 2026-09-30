// `npm run eval -- --count`: counts every request in token-counts.ts with
// Anthropic's token counting endpoint and writes evals/token-counts.json.
// Only the eval config's count mode loads a key (ANTHROPIC_API_KEY from
// .env.local), and only this module uses it.
//
// It must cost nothing. The count endpoint is free (Anthropic's token
// counting page, read 2026-09-27: "Token counting is free to use but
// subject to requests per minute rate limits"), and the client's fetch here
// refuses every request but a POST to that endpoint, so no model call can
// leave this module whatever the code above it does. The key is never
// printed or written.
//
// The two images are not in the repository (a 12-megapixel photo has no
// place in it); their paths come from EVAL_COUNT_IMAGES, comma separated,
// a JPEG and a PNG. The ones counted on 2026-09-27 were made on macOS from
// evals/documents/invoice-usd.pdf:
//   qlmanage -t -s 4032 -o . invoice-usd.pdf                 (3115x4032)
//   sips -c 4032 3024 invoice-usd.pdf.png --out page.png
//   sips -s format jpeg -s formatOptions 85 page.png --out phone-photo-3024x4032.jpg
//   sips --resampleHeight 1754 invoice-usd.pdf.png --out tmp.png
//   sips -c 1754 1240 tmp.png --out scan-150dpi-1240x1754.png
// Anthropic prices an image by its pixels, not its content (its vision
// guide), so any image of these sizes counts the same.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { createAnthropicClient } from "@/lib/extraction/providers/clients";
import { anthropicCountParams } from "@/lib/extraction/providers/requests";
import { detectMimeType } from "@/lib/extraction/sniff";
import {
  COUNT_ENDPOINT,
  countedModels,
  type CountedRequest,
  firstCallRequest,
  fingerprintFor,
  type ImageCase,
  repositoryRequests,
  TOKEN_COUNTS_PATH,
  TOKEN_COUNTS_VERSION,
  type TokenCounts,
} from "./token-counts";

// Only the count endpoint, only POST. Anything else throws before a byte
// leaves the process.
export const countOnlyFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = input instanceof Request ? input.url : String(input);
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (url !== COUNT_ENDPOINT || method !== "POST") {
    throw new Error(`the token counter only calls ${COUNT_ENDPOINT}; refused ${method} ${url}`);
  }
  return fetch(input, init);
};

// Width and height from a PNG's IHDR or a JPEG's first SOFn marker.
function imageSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return { width: view.getUint32(16), height: view.getUint32(20) };
  for (let at = 2; at + 9 < bytes.length; ) {
    if (bytes[at] !== 0xff) throw new Error("not a JPEG marker");
    const marker = bytes[at + 1];
    const length = view.getUint16(at + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: view.getUint16(at + 5), width: view.getUint16(at + 7) };
    }
    at += 2 + length;
  }
  throw new Error("no JPEG frame header");
}

function imageRequests(paths: string[]): { images: ImageCase[]; requests: CountedRequest[] } {
  const images: ImageCase[] = [];
  const requests: CountedRequest[] = [];
  for (const path of paths) {
    const bytes = new Uint8Array(readFileSync(path));
    const mimeType = detectMimeType(bytes);
    if (mimeType !== "image/jpeg" && mimeType !== "image/png") throw new Error(`${basename(path)} is not a JPEG or PNG`);
    const { width, height } = imageSize(bytes);
    const id = `image:${basename(path)}`;
    images.push({
      id,
      description:
        mimeType === "image/jpeg"
          ? `a full-resolution phone photo of a document page, ${width}x${height}`
          : `an A4 page scanned at 150 dpi, ${width}x${height}`,
      mimeType,
      width,
      height,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    requests.push({ id, kind: "image", pages: 1, request: firstCallRequest(bytes, mimeType) });
  }
  return { images, requests };
}

// The request as the endpoint gets it; the prompt's without its attachment.
function countParams(model: string, counted: CountedRequest): Anthropic.MessageCountTokensParams {
  const params = anthropicCountParams(model, counted.request);
  if (counted.kind !== "prompt") return params;
  const [first, ...rest] = params.messages;
  const content = Array.isArray(first.content) ? first.content.filter((block) => block.type === "text") : first.content;
  return { ...params, messages: [{ ...first, content }, ...rest] };
}

// What identifies the request apart from the model, which each count is
// already filed under.
function requestParts(model: string, counted: CountedRequest): TokenCounts["requests"][string]["parts"] {
  const { parts } = fingerprintFor(model, counted.request);
  return {
    file: parts.file,
    systemPrompt: parts.systemPrompt,
    userPrompt: parts.userPrompt,
    schema: parts.schema,
    maxOutputTokens: parts.maxOutputTokens,
    previousAttempt: parts.previousAttempt,
  };
}

export async function countAll(options: { apiKey: string; imagePaths: string[]; log: (line: string) => void }): Promise<TokenCounts> {
  if (options.imagePaths.length !== 2) throw new Error("EVAL_COUNT_IMAGES must name two images: the phone photo and the scan");
  const client = createAnthropicClient({ apiKey: options.apiKey, timeoutMs: 60_000, fetch: countOnlyFetch });
  const { images, requests: imageCounted } = imageRequests(options.imagePaths);
  const all = [...repositoryRequests(), ...imageCounted];

  const result: TokenCounts = {
    version: TOKEN_COUNTS_VERSION,
    countedAt: new Date().toISOString(),
    endpoint: COUNT_ENDPOINT,
    images,
    requests: {},
    counts: {},
  };
  for (const model of countedModels()) {
    result.counts[model] = {};
    for (const counted of all) {
      result.requests[counted.id] = { kind: counted.kind, pages: counted.pages, parts: requestParts(model, counted) };
      const answer = await client.messages.countTokens(countParams(model, counted));
      result.counts[model][counted.id] = answer.input_tokens;
      options.log(`${model} ${counted.id}: ${answer.input_tokens}`);
    }
  }
  writeFileSync(TOKEN_COUNTS_PATH, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}
