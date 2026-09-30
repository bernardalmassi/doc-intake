// The words the organization page uses for roles and results. Database
// values (roles, status enums) never reach the screen as they are: a role
// is said as what it allows, a status as one of the states in
// state-glyph.tsx, and errors arrive as codes whose words are
// src/lib/errors.ts's.

import { EXTRACTION_LIMITS } from "@/lib/extraction/config";
import type { FormState } from "@/app/form-state";
import { type ErrorCode, userFacingError } from "@/lib/errors";
import { formatBytes, NBSP } from "./format";
import type { Role } from "./types";

// What the reader's role lets them do here, said instead of the role's
// name: "Owner" reads oddly on an organization of one, and the name says
// nothing about what the page will let you do. Printed after "You can".
// Owners and admins can do the same things on this page.
export function roleAbilities(role: Role): string {
  return role === "member"
    ? "Upload and download documents, and read what was extracted from them. An admin extracts and deletes them."
    : "Upload, extract, download and delete documents, and read what was extracted from them.";
}

export function canManage(role: Role): boolean {
  return role === "owner" || role === "admin";
}

// The Documents heading takes focus after a delete removes the item that
// had it, so keyboard users don't land at the top of the page.
export const DOCUMENTS_HEADING_ID = "documents-heading";

// ---------------------------------------------------------------- upload

export const UPLOAD_LIMIT_TEXT = `PDF, PNG or JPEG, up to 10${NBSP}MB and ${EXTRACTION_LIMITS.maxPagesPerDocument}${NBSP}pages`;

// What the browser refuses before anything is sent. Type and size are
// checkUploadFile's rules (the bucket's, mirrored in src/lib/errors.ts) and
// use its words; an empty file and several files at once are this form's own.
export type RejectReason = "type" | "size" | "empty" | "several" | "pages" | "unreadable" | "no_pages";

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
    case "no_pages":
      return `${name} can't be uploaded. ${userFacingError("document.no_pages").message}`;
  }
}

// The three calls an upload makes, in words. The same order as the
// UploadStep numbers.
export const UPLOAD_STEPS = ["Preparing", "Sending the file", "Checking it arrived"] as const;

// ------------------------------------------------------- extract results

// Why a failed run failed, for its document's line and its row in the run
// history: the catalog's sentence for its code. Except the catalog's
// unknown, "Something went wrong. Please try again.", which alone doesn't
// say what went wrong, and a failed run that stored no error at all: for
// those the page says what failed, and that it can't say why (the stored
// text, if any, never reaches the page).
export const UNKNOWN_RUN_FAILURE = "The extraction failed, and this page can't say why.";

export function runFailureSentence(code: ErrorCode | null): string {
  if (code === null || code === "unknown") return `${UNKNOWN_RUN_FAILURE} Please try again.`;
  return userFacingError(code).message;
}

// ---------------------------------------------------------------- delete

// The question an armed Delete asks. A document whose extraction is queued
// or running may still be charged for it: deleting the document doesn't
// stop a worker that has already sent its file to a model.
export function deleteQuestion(extractionUnderWay: boolean): string {
  const question = "Delete this document and everything extracted from it? This can't be undone.";
  return extractionUnderWay ? `${question} An extraction under way may still be charged.` : question;
}

// A sentence for the notice beside a document's buttons.
export type Explained = { text: string };

// What an Extract click came back with, as one short sentence: a refusal.
// Extract only queues a run, so an accepted click says nothing here; the
// line reads the run from the data that comes back with it.
export function describeExtractResult(state: FormState): (Explained & { ok: boolean }) | null {
  if (state.error) return { ok: false, text: userFacingError(state.error).message };
  return null;
}
