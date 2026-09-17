// The bucket checks the declared Content-Type, not the bytes. Nothing goes
// to a model unless the bytes start with the signature of the type the row
// says they are.

export type SupportedMimeType = "application/pdf" | "image/png" | "image/jpeg";

export const SUPPORTED_MIME_TYPES: readonly SupportedMimeType[] = [
  "application/pdf",
  "image/png",
  "image/jpeg",
];

const SIGNATURES: [SupportedMimeType, number[]][] = [
  ["application/pdf", [0x25, 0x50, 0x44, 0x46, 0x2d]], // %PDF-
  ["image/png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  ["image/jpeg", [0xff, 0xd8, 0xff]],
];

export function detectMimeType(bytes: Uint8Array): SupportedMimeType | null {
  for (const [type, signature] of SIGNATURES) {
    if (bytes.length < signature.length) continue;
    if (signature.every((byte, i) => bytes[i] === byte)) return type;
  }
  return null;
}

export function isSupportedMimeType(value: string | null): value is SupportedMimeType {
  return value !== null && (SUPPORTED_MIME_TYPES as readonly string[]).includes(value);
}
