// The words the organization page uses for roles and states. Database
// values (roles, status enums) never reach the screen as they are.

import { fileKind, formatBytes, NBSP } from "./format";
import type { FormState } from "@/app/auth/actions";
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

// ----------------------------------------------------- runs and actions

// A sentence, and optionally the raw text it was made from, shown
// secondary and labelled.
export type Explained = { text: string; detail?: string };

// The Server Action didn't answer at all: offline, or the connection
// dropped. Used as the error of a call that threw.
export const CONNECTION_ERROR = "The server couldn't be reached. Check your connection and try again.";

// Why a run failed, from the error the database stored for it. The stored
// text is written for engineers (see src/lib/extraction/run.ts and
// extract-action.ts); this is the sentence a stranger reads.
export function describeRunError(raw: string | null): string {
  if (!raw) return "No reason was recorded.";
  const text = raw.replace(/^Extraction failed: /, "");

  if (text.startsWith("could not download the file")) return "The file couldn't be read from storage.";

  const mismatch = /^file content \(([^)]+)\) does not match its declared type \(([^)]+)\)/.exec(text);
  if (mismatch) {
    const detected = mismatch[1] === "unrecognized" ? null : fileKind(mismatch[1]);
    const declared = fileKind(mismatch[2]);
    if (!declared) return "The file isn't a PDF, PNG or JPEG.";
    return detected
      ? `The file says it's a ${declared}, but its contents are a ${detected}.`
      : `The file says it's a ${declared}, but its contents aren't a PDF, PNG or JPEG.`;
  }

  const abandoned = /^abandoned: still running after (\d+) minutes/.exec(text);
  if (abandoned) return `It stopped responding and was cancelled after ${abandoned[1]} minutes.`;

  if (text.startsWith("response failed validation")) {
    return "The model's answer wasn't in the expected format, even after a retry.";
  }
  if (text.startsWith("retry after invalid response")) {
    return "The model's answer wasn't in the expected format, and the retry failed.";
  }

  const provider = /^(anthropic|openai) (transport|server|client|refusal|truncated)(?: (\d{3}))?:/.exec(text);
  if (provider) {
    const status = provider[3];
    switch (provider[2]) {
      case "transport":
        return "The extraction service couldn't be reached or didn't answer in time.";
      case "server":
        return "The extraction service had an internal error.";
      case "refusal":
        return "The model declined to read this document.";
      case "truncated":
        return "The model's answer was cut off before it finished.";
      case "client":
        if (status === "429") return "The extraction service was too busy.";
        if (status === "401" || status === "403") return "The extraction service isn't set up correctly.";
        return "The extraction service rejected the request.";
    }
  }

  return "Something unexpected went wrong.";
}

// What to do about a failed run, when trying again won't help.
export function runErrorAdvice(raw: string | null): string | null {
  if (raw && /does not match its declared type/.test(raw)) {
    return "Upload the file again as a real PDF, PNG or JPEG.";
  }
  return null;
}

export function describeDeleteError(error: string): Explained {
  if (error === CONNECTION_ERROR) return { text: error };
  if (error === "Missing document." || error === "Document not found.") {
    return { text: "This document no longer exists. Refresh the page." };
  }
  if (error === "Only admins can delete documents.") return { text: error };
  if (error === "The file couldn't be removed. Only admins can delete documents.") {
    return { text: "The file couldn't be deleted. Only admins can delete documents." };
  }
  if (error.startsWith("Couldn't remove the file: ")) {
    return { text: "The file couldn't be deleted. Try again.", detail: error.slice("Couldn't remove the file: ".length) };
  }
  return { text: "The document couldn't be deleted. Try again.", detail: error };
}

export function describeDownloadError(error: string): Explained {
  if (/not found/i.test(error)) {
    return { text: "The file couldn't be found. It may have been deleted; refresh the page.", detail: error };
  }
  return { text: "The download couldn't start. Try again.", detail: error };
}

// ------------------------------------------------------- extract results

// "1.000000" (as Postgres formats the ceiling) -> "$1.00"
function formatLimit(amount: string): string {
  const value = Number(amount);
  return Number.isFinite(value) ? `$${value.toFixed(2)}` : `${amount} USD`;
}

// What an Extract click came back with, as one short sentence. The known
// shapes are the ones extract-action.ts returns; anything else keeps its
// text as the technical detail.
export function describeExtractResult(state: FormState): (Explained & { ok: boolean }) | null {
  if (state.error) return { ok: false, ...describeExtractError(state.error) };
  if (state.message !== undefined) return { ok: true, text: "Extraction finished." };
  return null;
}

function describeExtractError(error: string): Explained {
  if (error === CONNECTION_ERROR) return { text: error };
  if (error === "Missing document." || error === "Document not found.") {
    return { text: "This document no longer exists. Refresh the page." };
  }
  if (error === "Only admins can run extraction.") return { text: "Only admins can extract documents." };

  const paused = "Extraction is paused: ";
  if (error.startsWith(paused)) {
    const amount = /\(([\d.]+) USD\)/.exec(error)?.[1];
    const limit = amount ? ` of ${formatLimit(amount)}` : "";
    const detail = error.slice(paused.length);
    if (error.includes("across all organizations")) {
      return {
        text: `Extraction is paused for everyone until next month: the monthly spending limit${limit} across all organizations has been reached.`,
        detail,
      };
    }
    return {
      text: `Extraction is paused for this organization until next month: it has reached its monthly spending limit${limit}.`,
      detail,
    };
  }

  const limited = "Extraction is rate limited: ";
  if (error.startsWith(limited)) {
    const count = /limit of (\d+)/.exec(error)?.[1];
    return {
      text: count
        ? `This organization has run ${count} extractions in the last hour, the most allowed. Try again later.`
        : "This organization has run too many extractions in the last hour. Try again later.",
      detail: error.slice(limited.length),
    };
  }

  const blocked = "Can't extract right now: ";
  if (error.startsWith(blocked)) {
    if (error.includes("has no file yet")) {
      return { text: "This document's file never finished uploading, so there is nothing to extract." };
    }
    if (error.includes("already running")) {
      return {
        text: "An extraction is already running for this document. Refresh the page in a minute to see the results.",
      };
    }
    return { text: "This document can't be extracted right now.", detail: error.slice(blocked.length) };
  }

  const failed = "Extraction failed: ";
  if (error.startsWith(failed)) {
    const raw = error.slice(failed.length);
    const next = runErrorAdvice(raw) ?? "Nothing was changed, and you can try again.";
    return { text: `Extraction failed. ${describeRunError(raw)} ${next}`, detail: raw };
  }

  const unrecorded = "The run could not be recorded: ";
  if (error.startsWith(unrecorded)) {
    return {
      text: "The extraction ran, but its result couldn't be saved. Refresh the page and try again.",
      detail: error.slice(unrecorded.length),
    };
  }

  return { text: "Extraction couldn't be started. Try again.", detail: error };
}
