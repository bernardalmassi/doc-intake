// The words the organization page uses for roles, states and results.
// Database values (roles, status enums) never reach the screen as they are,
// and errors arrive as codes whose words are src/lib/errors.ts's.

import { EXTRACTION_LIMITS } from "@/lib/extraction/config";
import type { FormState } from "@/app/form-state";
import { userFacingError } from "@/lib/errors";
import { formatBytes, NBSP } from "./format";
import type { Role } from "./types";

export const ROLE_LABELS: Record<Role, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};

export function roleAbilities(role: Role): string {
  return role === "member"
    ? "You can upload and download documents. Admins run extraction and delete documents."
    : "You can upload, extract and delete documents.";
}

export function canManage(role: Role): boolean {
  return role === "owner" || role === "admin";
}

const STATUS_LABELS: Record<string, string> = {
  uploading: "Upload incomplete",
  pending: "Ready to extract",
  processing: "Extracting",
  extracted: "Extracted",
  needs_review: "Needs review",
  failed: "Extraction failed",
};

// A status the page doesn't know yet still reads as words, not as an enum.
export function statusLabel(status: string): string {
  const known = STATUS_LABELS[status];
  if (known) return known;
  const words = status.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// The Documents heading takes focus after a delete removes the item that
// had it, so keyboard users don't land at the top of the page.
export const DOCUMENTS_HEADING_ID = "documents-heading";

// ---------------------------------------------------------------- upload

export const UPLOAD_LIMIT_TEXT = `PDF, PNG or JPEG, up to 10${NBSP}MB and ${EXTRACTION_LIMITS.maxPagesPerDocument}${NBSP}pages`;

// What the browser refuses before anything is sent. Type and size are
// checkUploadFile's rules (the bucket's, mirrored in src/lib/errors.ts) and
// use its words; an empty file and several files at once are this form's own.
export type RejectReason = "type" | "size" | "empty" | "several" | "pages" | "unreadable";

export function describeRejection(
  reason: RejectReason,
  file: { name: string; size: number; pages?: number | null } | null,
): string {
  const name = file?.name ?? "That file";
  switch (reason) {
    case "type":
      return `${name} can't be uploaded. ${userFacingError("upload.file_type_not_allowed").message}`;
    case "size":
      return `${name} is ${formatBytes(file?.size ?? 0)}. ${userFacingError("upload.file_too_large").message}`;
    case "empty":
      return `${name} is empty.`;
    case "several":
      return "Drop one file at a time.";
    case "pages":
      return `${name} has ${file?.pages ?? "too many"} pages. ${userFacingError("document.too_many_pages").message}`;
    case "unreadable":
      return `${name} can't be uploaded. ${userFacingError("document.pages_unreadable").message}`;
  }
}

// The three calls an upload makes, in words. The same order as the
// UploadStep numbers.
export const UPLOAD_STEPS = ["Preparing", "Sending the file", "Checking it arrived"] as const;

// ------------------------------------------------------- extract results

// A sentence for the notice beside a document's buttons.
export type Explained = { text: string };

// What an Extract click came back with, as one short sentence.
export function describeExtractResult(state: FormState): (Explained & { ok: boolean }) | null {
  if (state.error) return { ok: false, text: userFacingError(state.error).message };
  if (state.message !== undefined) return { ok: true, text: "Extraction finished." };
  return null;
}
