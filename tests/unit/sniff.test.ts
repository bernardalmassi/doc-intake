// The magic-byte check in sniff.ts: the bucket only checks the declared
// Content-Type, so nothing reaches a model unless the bytes themselves start
// with a supported signature. Needs no database.

import { describe, expect, it } from "vitest";
import { detectMimeType } from "@/lib/extraction/sniff";
import { pdfBytes } from "../helpers/fake-provider";

describe("configuration", () => {
  it("magic bytes decide the type, not the declared one", () => {
    expect(detectMimeType(pdfBytes("x"))).toBe("application/pdf");
    expect(detectMimeType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe("image/png");
    expect(detectMimeType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(detectMimeType(new TextEncoder().encode("hello"))).toBeNull();
    expect(detectMimeType(new Uint8Array([]))).toBeNull();
  });
});
