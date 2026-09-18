// The words the organization page uses for roles and states. Database
// values (roles, status enums) never reach the screen as they are.

import { formatBytes, NBSP } from "./format";
import type { UploadFailure } from "./operations";
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

export const UPLOAD_LIMIT_TEXT = `PDF, PNG or JPEG, up to 10${NBSP}MB`;

// What the browser checks before anything is sent. The bucket enforces the
// same limits; checking first means an obviously wrong file never leaves an
// unfinished entry behind.
export type RejectReason = "type" | "size" | "empty" | "several";

export function describeRejection(reason: RejectReason, file: { name: string; size: number } | null): string {
  const name = file?.name ?? "That file";
  switch (reason) {
    case "type":
      return `${name} isn't a PDF, PNG or JPEG, so it can't be uploaded.`;
    case "size":
      return `${name} is ${formatBytes(file?.size ?? 0)}. Files can be up to 10${NBSP}MB.`;
    case "empty":
      return `${name} is empty.`;
    case "several":
      return "Drop one file at a time.";
  }
}

// The three calls an upload makes, in words. The same order as the
// UploadStep numbers.
export const UPLOAD_STEPS = ["Preparing", "Sending the file", "Checking it arrived"] as const;

// Why an upload stopped, in a sentence a stranger understands. The call's
// own message stays available as a technical detail.
export function describeUploadFailure(failure: UploadFailure): string {
  const { step, message, status, code, network } = failure;
  if (step === 1) {
    if (network) return "The server couldn't be reached. Check your connection and try again.";
    if (message === "You can't upload to this organization.") {
      return "You can't upload to this organization. You may no longer be a member.";
    }
    if (message.startsWith("Filename")) {
      return "The file's name is too long or contains characters that can't be stored. Rename the file and try again.";
    }
    return "The upload couldn't be started.";
  }
  if (step === 2) {
    if (status === 413 || code === "EntityTooLarge" || /maximum allowed size|too large/i.test(message)) {
      return `The file is larger than the 10${NBSP}MB limit.`;
    }
    if (status === 415 || code === "InvalidMimeType" || /mime type/i.test(message)) {
      return "Only PDF, PNG and JPEG files can be uploaded.";
    }
    if (status === 401 || status === 403 || /row-level security|unauthori[sz]ed|access denied/i.test(message)) {
      return "You no longer have permission to upload to this organization.";
    }
    if (network || status === undefined) {
      return "The connection dropped while the file was being sent. Check your connection and try again.";
    }
    if (status >= 500) return "The file storage service had a problem. Try again in a moment.";
    return "The file couldn't be sent.";
  }
  if (network) {
    return "The connection dropped before the upload was confirmed. Check your connection and try again.";
  }
  if (/no file has been uploaded/i.test(message)) return "The file didn't arrive in storage.";
  if (/no longer a member/i.test(message)) return "You're no longer a member of this organization.";
  if (/not waiting for an upload/i.test(message)) {
    return "This upload had already been finished. Refresh the page to see it.";
  }
  return "The upload couldn't be confirmed.";
}

// Whether sending the same file again could work. It can't when the file
// itself or the user's access is the problem; then the form offers another
// file instead of a retry.
export function isRetryable(failure: UploadFailure): boolean {
  const { step, message, status, code, network } = failure;
  if (network) return true;
  if (step === 1) return !(message === "You can't upload to this organization." || message.startsWith("Filename"));
  if (step === 2) {
    if (status === 413 || status === 415 || status === 401 || status === 403) return false;
    if (code === "EntityTooLarge" || code === "InvalidMimeType") return false;
    if (/maximum allowed size|too large|mime type|row-level security|unauthori[sz]ed|access denied/i.test(message)) {
      return false;
    }
    return true;
  }
  return !/no longer a member|not waiting for an upload/i.test(message);
}

// The raw detail behind a failed upload, for the "Technical details"
// disclosure.
export function uploadFailureDetail(failure: UploadFailure): string {
  const extras = [
    failure.status !== undefined ? `HTTP ${failure.status}` : null,
    failure.code ? `code ${failure.code}` : null,
  ].filter(Boolean);
  const step = UPLOAD_STEPS[failure.step - 1].toLowerCase();
  return `Step ${failure.step} of 3 (${step}): ${failure.message}${extras.length ? ` (${extras.join(", ")})` : ""}`;
}
