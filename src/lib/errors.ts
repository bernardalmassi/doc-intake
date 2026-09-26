// Every failure a user can hit, as one stable code and one plain-English
// message.
//
// The app talks to four systems that each fail in their own vocabulary:
// Postgres through PostgREST (SQLSTATEs such as 42501, plus the phrases our
// migrations raise), Supabase Auth (codes such as weak_password), Supabase
// Storage (status codes and service codes) and the model providers
// (ProviderError kinds, which end up as text in extraction_runs.error).
// None of that text is fit for a user. Database messages name tables and
// constraints, provider messages name vendors and quote request details, a
// stored run error is written for engineers, and any of them can change
// with a dependency upgrade. So the classifiers here return only a code, and
// the only text a user is meant to see is the fixed message for that code.
// An input nobody anticipated becomes "unknown"; its text is never echoed,
// and an input that throws when read (a hostile getter) is "unknown" too.
//
// Every Server Action returns a code from here, and every page renders
// userFacingError(code).message; a stored run error reaches the page only
// as classifyRunError's code.
//
// Classification goes by code first (SQLSTATE, Auth code, Storage code,
// ProviderError kind), then by what was being attempted, because the same
// SQLSTATE means different things in different calls (55000 is "files
// remain" in delete_tenant and "already running" in enqueue_extraction_run).
// Message text is read in these places only, each a refinement of a code
// that would otherwise be less specific, never a way to choose one freely:
//
//   - database: where one SQLSTATE covers two outcomes, the exact phrase a
//     migration raises (tests/unit/errors.test.ts proves each phrase is
//     still raised by the live function, and that every raise in
//     supabase/migrations has a code)
//   - stored run errors and ProviderError messages: prefixes and shapes
//     written by this repo's own code (run.ts, the provider modules, the
//     Extract action), each checked against its source
//   - Supabase Auth validation_failed: GoTrue's wording for an over-long
//     password or a bad email, which no source here can confirm
//   - thrown errors: the exact messages browsers and Node give a fetch that
//     failed on the network
//
// ERRORS.md is the table of every failure path, its code and its message;
// the same test keeps it in step with this module.
//
// Nothing here imports server-only code, so Client Components can use it.
// Codes are safe to send from a Server Action, log, or put in a URL: a
// value from outside is checked with isErrorCode before it is looked up.

import type { WeakPasswordReasons } from "@supabase/supabase-js";
import { ANTHROPIC_MODEL_ENV_VAR, DEFAULT_MODELS, EXTRACTION_LIMITS, PROVIDER_ENV_VAR, type ProviderName } from "@/lib/extraction/config";
import type { ProviderErrorKind } from "@/lib/extraction/providers/types";
import { isSupportedMimeType, SUPPORTED_MIME_TYPES, type SupportedMimeType } from "@/lib/extraction/sniff";
import { MAX_PASSWORD_BYTES, MIN_PASSWORD_LENGTH } from "@/lib/password";

// Rules the database enforces --------------------------------------------
//
// Mirrored so a form can refuse bad input before a round trip, and so the
// messages below can quote them. The database stays authoritative, and the
// test compares each value with the migration that defines it.

// tenants.slug check constraint (20260917000001)
export const SLUG_PATTERN = /^[a-z0-9-]{3,48}$/;
// documents_filename_check (20260917000009)
export const MAX_FILENAME_LENGTH = 255;
// the documents bucket (20260917000009)
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const UPLOAD_MIME_TYPES: readonly SupportedMimeType[] = SUPPORTED_MIME_TYPES;

const STALE_MINUTES = EXTRACTION_LIMITS.staleRunMinutes;

// Catalog ----------------------------------------------------------------

export type ErrorInfo = {
  // What happened and what to do next, in one or two sentences.
  message: string;
  // True when repeating the same action unchanged can succeed, possibly
  // after the wait the message names. False when something has to change
  // first: the input, someone's role, the data, the server's configuration,
  // or the calendar month. Every retryable message says "try again" and no
  // other message does (the test checks both directions).
  retryable: boolean;
};

const CATALOG = {
  unknown: { message: "Something went wrong. Please try again.", retryable: true },

  "network.unavailable": {
    message: "We couldn't reach the server. Check your internet connection and try again.",
    retryable: true,
  },
  "service.unavailable": {
    message: "The service is temporarily unavailable. Please try again in a minute.",
    retryable: true,
  },
  "input.invalid": {
    message: "Some of the information you entered isn't valid. Correct it and submit the form again.",
    retryable: false,
  },

  // Signing up, in and out, and the session
  "auth.not_signed_in": { message: "You're not signed in. Sign in to continue.", retryable: false },
  "auth.session_expired": { message: "Your session has expired. Sign in again to continue.", retryable: false },
  "auth.credentials_required": { message: "Enter your email address and password.", retryable: false },
  "auth.invalid_credentials": { message: "The email address or password is incorrect.", retryable: false },
  "auth.email_invalid": { message: "That email address isn't valid. Check it for typos.", retryable: false },
  "auth.email_taken": {
    message: "An account with this email address already exists. Sign in instead.",
    retryable: false,
  },
  "auth.email_not_confirmed": {
    message: "Your email address isn't confirmed yet. Open the confirmation link we emailed you, then sign in.",
    retryable: false,
  },
  "auth.email_not_allowed": {
    message: "We can't send email to that address. Sign up with a different email address.",
    retryable: false,
  },
  "auth.password_too_short": {
    message: `Your password must be at least ${MIN_PASSWORD_LENGTH} characters long.`,
    retryable: false,
  },
  "auth.password_too_long": {
    message: `Your password is too long. Use at most ${MAX_PASSWORD_BYTES} characters; accented letters and emoji count as two or more.`,
    retryable: false,
  },
  "auth.password_missing_characters": {
    message:
      "Your password doesn't use the required kinds of characters. Mix lowercase and uppercase letters, digits and symbols.",
    retryable: false,
  },
  "auth.password_breached": {
    message: "This password has appeared in a known data breach. Choose a different one.",
    retryable: false,
  },
  "auth.password_weak": {
    message: `This password isn't strong enough. Use at least ${MIN_PASSWORD_LENGTH} characters with a mix of letters, digits and symbols, and don't reuse a password from another site.`,
    retryable: false,
  },
  "auth.rate_limited": {
    message: "Too many attempts in a short time. Wait a few minutes, then try again.",
    retryable: true,
  },
  "auth.email_rate_limited": {
    message: "We can't send another email right now. Wait a while, then try again.",
    retryable: true,
  },
  "auth.signup_disabled": { message: "New accounts can't be created right now.", retryable: false },
  "auth.sign_in_disabled": { message: "Signing in with an email address is turned off right now.", retryable: false },
  "auth.account_suspended": { message: "This account has been suspended.", retryable: false },
  "auth.confirmation_link_invalid": {
    message:
      "This confirmation link is invalid, has expired, or was opened in a different browser from the one you signed up in. Sign in, or sign up again to get a new link.",
    retryable: false,
  },

  // Organizations and accounts
  "tenant.not_found": {
    message: "We couldn't find that organization, or you don't have access to it.",
    retryable: false,
  },
  "tenant.name_required": { message: "Enter a name for the organization.", retryable: false },
  "tenant.slug_invalid": {
    message: "The web address must be 3 to 48 characters long and use only lowercase letters, digits and hyphens.",
    retryable: false,
  },
  "tenant.slug_taken": { message: "That web address is already in use. Choose a different one.", retryable: false },
  "tenant.update_not_allowed": {
    message: "Only an admin can change this organization's name or web address.",
    retryable: false,
  },
  "tenant.delete_not_owner": { message: "Only an owner can delete this organization.", retryable: false },
  "tenant.delete_has_files": {
    message: "This organization still has documents with files. Delete them first, then delete the organization.",
    retryable: false,
  },
  // every run in flight has a deadline the queue's sweep enforces: the
  // stale limit, plus a minute for the sweep's next tick
  "tenant.delete_extraction_running": {
    message: `An extraction is still running in this organization. Try again when it finishes; one that is stuck is ended within ${STALE_MINUTES + 1} minutes.`,
    retryable: true,
  },
  "account.delete_owns_organization": {
    message:
      "You still own an organization. Delete it, or make another member an owner and have them remove you, before deleting your account.",
    retryable: false,
  },

  // Members and roles
  "membership.not_allowed": {
    message: "You don't have permission to make this change to the organization's members.",
    retryable: false,
  },
  "membership.own_role": {
    message: "You can't change your own role. Ask another admin or owner to do it.",
    retryable: false,
  },
  "membership.owner_only": {
    message: "Only an owner can make someone an owner, or change or remove an owner.",
    retryable: false,
  },
  "membership.last_owner": {
    message:
      "An organization must always have at least one owner. Make someone else an owner first, or delete the organization.",
    retryable: false,
  },
  "membership.already_member": {
    message: "That person is already a member of this organization.",
    retryable: false,
  },
  "membership.user_not_found": { message: "There is no account for that person.", retryable: false },

  // Documents
  "document.not_found": {
    message: "This document doesn't exist, or you don't have access to it.",
    retryable: false,
  },
  "document.filename_invalid": {
    message: `File names must be 1 to ${MAX_FILENAME_LENGTH} characters, not only spaces, with no line breaks, tabs or other control characters.`,
    retryable: false,
  },
  "document.rename_not_allowed": {
    message: "Only the person who uploaded a document, or an admin, can rename it.",
    retryable: false,
  },
  "document.delete_not_allowed": { message: "Only an admin can delete documents.", retryable: false },
  "document.file_still_present": {
    message: "The document's file couldn't be removed, so the document was kept. Please try again.",
    retryable: true,
  },
  // checkPageCount: at upload in the browser, and again by the Extract
  // action before a run is opened (SECURITY.md, "Stale runs")
  "document.too_many_pages": {
    message: `Documents can have at most ${EXTRACTION_LIMITS.maxPagesPerDocument} pages. Split this one into parts of ${EXTRACTION_LIMITS.maxPagesPerDocument} pages or fewer and upload them separately.`,
    retryable: false,
  },
  "document.pages_unreadable": {
    message:
      "We couldn't count this PDF's pages, so it can't be extracted. Save it again as a standard PDF (for example with Print to PDF) and upload that.",
    retryable: false,
  },

  // Uploading and downloading
  "upload.no_file": { message: "Choose a file to upload.", retryable: false },
  "upload.file_type_not_allowed": { message: "Only PDF, PNG and JPEG files can be uploaded.", retryable: false },
  "upload.file_too_large": {
    message: `Files must be ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB or smaller.`,
    retryable: false,
  },
  "upload.not_allowed": {
    message:
      "This upload was refused. You may no longer be a member of this organization, or the upload was cancelled.",
    retryable: false,
  },
  "upload.already_uploaded": {
    message: "This file has already been uploaded. Refresh the page to see it.",
    retryable: false,
  },
  "upload.file_missing": { message: "The file didn't finish uploading. Please try again.", retryable: true },
  "upload.incomplete": {
    message: "This upload never finished, so there is no file to open. Upload the file again; an admin can remove this entry.",
    retryable: false,
  },
  "download.not_found": {
    message: "This file isn't available. It may have been deleted, or you may no longer have access to it.",
    retryable: false,
  },

  // Extraction: starting a run
  "extraction.not_allowed": {
    message: "This document doesn't exist, or you aren't an admin of its organization. Only admins can run extraction.",
    retryable: false,
  },
  "extraction.no_file": {
    message: "This document has no file yet. Finish uploading it before extracting.",
    retryable: false,
  },
  "extraction.already_running": {
    message: `An extraction is already running for this document. Try again when it finishes; one that is stuck is released after ${STALE_MINUTES} minutes.`,
    retryable: true,
  },
  // The ceilings count every run in flight at its estimate
  // (check_extraction_limits, 20260925000002), so one can be reached while
  // an extraction is running and clear again when it finishes.
  "extraction.tenant_budget_reached": {
    message:
      "Your organization has reached this month's extraction budget, counting extractions in progress. Try again when those finish; if none are running, extraction resumes next month (UTC).",
    retryable: true,
  },
  "extraction.global_budget_reached": {
    message:
      "Extraction is paused for everyone: this month's overall budget is reached, counting extractions in progress. Try again when those finish; if none are running, it resumes next month (UTC).",
    retryable: true,
  },
  "extraction.rate_limited": {
    message: `Your organization has reached its limit of ${EXTRACTION_LIMITS.hourlyRunLimit} extractions per hour. Try again later.`,
    retryable: true,
  },

  // Extraction: what a run can end with
  "extraction.not_configured": {
    message: "Extraction isn't set up on this server. Ask whoever runs this service to configure it.",
    retryable: false,
  },
  "extraction.download_failed": {
    message: "The file couldn't be read for extraction. Please try again.",
    retryable: true,
  },
  // the worker recounts a file's pages before any model call, and refuses
  // one whose count isn't the one Extract was requested with
  "extraction.page_count_mismatch": {
    message:
      "We couldn't confirm this document's page count, so it wasn't sent for extraction. Please try again.",
    retryable: true,
  },
  "extraction.file_type_mismatch": {
    message:
      "This file's contents don't match its file type, so it wasn't sent for extraction. Upload it again as a genuine PDF, PNG or JPEG file.",
    retryable: false,
  },
  "extraction.provider_timeout": {
    message: "The extraction service took too long to respond. Try again in a few minutes.",
    retryable: true,
  },
  "extraction.provider_unavailable": {
    message: "The extraction service is unavailable or busy right now. Try again in a few minutes.",
    retryable: true,
  },
  "extraction.all_providers_failed": {
    message: "Both extraction services we use failed on this document. Try again in a few minutes.",
    retryable: true,
  },
  "extraction.provider_rejected": {
    message: "The extraction service couldn't process this document. It may be damaged, password-protected or too long.",
    retryable: false,
  },
  "extraction.refused": {
    message: "The extraction service declined to process this document. Review it yourself instead.",
    retryable: false,
  },
  "extraction.truncated": {
    message: "This document has more content than one extraction can return. Review it yourself instead.",
    retryable: false,
  },
  "extraction.answer_incomplete": {
    message: "The extraction service stopped before finishing its answer. Please try again.",
    retryable: true,
  },
  // A second attempt is made only if it fits the per-call limit, so the
  // message doesn't promise one.
  "extraction.invalid_answer": {
    message:
      "The extraction service's answer failed our checks, so nothing was saved from it. You can try again or review the document yourself.",
    retryable: true,
  },
  // run.ts measures every call before sending it; a document whose first
  // call reads more than the per-call limit for its pages is never sent
  "extraction.too_dense": {
    message:
      "This document is too dense to extract within our limits: its pages hold more than one extraction may read, so it wasn't sent and nothing was charged. Split it into smaller files and extract those.",
    retryable: false,
  },
  "extraction.abandoned": {
    message: "This extraction stopped before it finished and was cancelled. Please try again.",
    retryable: true,
  },
  "extraction.expired": {
    message: `This extraction didn't start within ${STALE_MINUTES} minutes, so it was cancelled at no cost. Please try again.`,
    retryable: true,
  },
  "extraction.result_not_saved": {
    message: "The extraction ran, but its result couldn't be saved. Please try again.",
    retryable: true,
  },
  "extraction.record_failed": {
    message: `The extraction ran, but its result couldn't be saved. You can try again in about ${STALE_MINUTES} minutes.`,
    retryable: true,
  },
} satisfies Record<string, ErrorInfo>;

export type ErrorCode = keyof typeof CATALOG;

for (const info of Object.values(CATALOG)) Object.freeze(info);
export const ERROR_CATALOG: Readonly<Record<ErrorCode, Readonly<ErrorInfo>>> = Object.freeze(CATALOG);
export const ERROR_CODES = Object.freeze(Object.keys(CATALOG) as ErrorCode[]);

export type UserFacingError = { code: ErrorCode } & ErrorInfo;

// Own keys only, so "constructor" or "__proto__" from a URL isn't a code.
export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(CATALOG, value);
}

export function userFacingError(code: ErrorCode): UserFacingError {
  const known: ErrorCode = isErrorCode(code) ? code : "unknown";
  return { code: known, ...CATALOG[known] };
}

// Phrases ---------------------------------------------------------------
//
// The exact text the migrations raise, used only where one SQLSTATE covers
// two outcomes. Matched as a prefix of the message, which is how Postgres
// and PostgREST deliver a raised exception. Exported so the test can prove
// each one still exists in supabase/migrations.

export const DATABASE_PHRASES = {
  // create_tenant raises it without an errcode (P0001); the others as 42501
  authenticationRequired: "authentication required",
  // enqueue_extraction_run, 55000
  documentHasNoFile: "the document has no file yet",
  extractionAlreadyRunning: "an extraction is already running for this document",
  // check_extraction_limits (called by enqueue_extraction_run), 53400
  tenantCeilingReached: "this organization has reached its monthly extraction spend ceiling",
  globalCeilingReached: "the monthly extraction spend ceiling across all organizations has been reached",
  // delete_tenant, 55000
  tenantExtractionInProgress: "an extraction is in progress for this tenant",
  tenantFilesRemain: "remove the tenant's files from storage before deleting it",
  // complete_document_upload, 55000
  notWaitingForUpload: "document is not waiting for an upload",
  noFileUploaded: "no file has been uploaded for this document",
} as const;

// Check constraints a user can trip. Postgres names an unnamed column check
// <table>_<column>_check, and quotes the name in its 23514 message.
export const CHECK_CONSTRAINTS = {
  tenantSlug: "tenants_slug_check",
  tenantName: "tenants_name_check",
  documentFilename: "documents_filename_check",
} as const;

// The pieces of a failed run's error, as extraction_runs.error stores it.
// downloadFailed to pageCountMismatch start errors written by the worker's
// preflight (src/lib/extraction/delivery.ts); the next five are the
// orchestrator's (src/lib/extraction/run.ts);
// notConfigured, providerNotSelected and modelNotSelected come from selectProviders; abandoned
// and expired from reap_extraction_run (20260925000002), which the reapers
// and the queue's sweep call; and resultNotRecorded from
// failedCloseAttempts in run.ts, for a run whose close was refused. The test checks
// each against its source, and drives the real orchestrator with fake
// providers to classify what it actually stores.
export const RUN_ERROR_MARKERS = {
  downloadFailed: "could not download the file",
  typeMismatch: "file content (",
  // the worker's preflight (extraction/delivery.ts), after the type check
  pagesUnreadable: "pages unreadable: ",
  tooManyPages: "too many pages: ",
  pageCountMismatch: "page count mismatch: ",
  invalidAfterRetry: "response failed validation after",
  retryFailed: "retry after invalid response (",
  retryFailedSeparator: ") failed: ",
  // "<primary's error>; fallback <fallback's error>": the fallback's first
  // call failed too
  fallbackFailed: "; fallback ",
  // appended when a timeout or 5xx had no fallback to switch to
  noFallback: "; no fallback provider is configured",
  // run.ts measures every call's input before sending it. A first call over
  // the per-call limit: "too dense: its input (<n> tokens) is over ...".
  tooDense: "too dense: ",
  // a count that failed, so no call was sent: "input not measured: <the
  // count's error, as describeError renders it>"
  inputNotMeasured: "input not measured: ",
  // "<primary's error>; the fallback provider was not used: <why>": the
  // fallback's input couldn't be measured, or was over the limit
  fallbackNotUsed: "; the fallback provider was not used: ",
  notConfigured: "extraction is not configured",
  providerNotSelected: `${PROVIDER_ENV_VAR} must be`,
  modelNotSelected: `${ANTHROPIC_MODEL_ENV_VAR} must be`,
  // a run ended while it may have called a model, charged the estimate:
  // "abandoned: still running after 10 minutes; ...", "abandoned: claimed
  // but not finished within 300 seconds", ...
  abandoned: "abandoned: ",
  // a run ended before any delivery claimed it, at no cost
  expired: "expired: ",
  // failedCloseAttempts (run.ts), when the database refused to record a
  // successful run and the worker finished it as failed instead
  resultNotRecorded: "the result could not be recorded",
  // A run charged an estimate rather than its recorded usage: by
  // failedCloseAttempts (run.ts) when the close with the run's own model was
  // refused too, "<this> the dearest price on file (<SQLSTATE>; served by
  // <model id>): <the run's error>"; and by the stale-run reaper
  // (20260918000003, and reap_extraction_run since 20260925000002),
  // "<this> <model> prices (abandoned; ...): abandoned: ...". Not a failure
  // of its own; what follows it decides the code.
  costEstimated: "cost estimated at",
} as const;

// How a ProviderError's message starts, where its kind and status alone
// don't say enough. timeout is classify.ts's (a timeout, as opposed to a
// connection that failed outright); the other two are interpret.ts's, for
// an answer that ended some way other than a normal finish.
export const PROVIDER_MESSAGES = {
  timeout: "request timed out",
  unexpectedStop: "the answer stopped unexpectedly",
  notCompleted: "the response did not complete",
} as const;

// Local checks -----------------------------------------------------------

export function checkCredentials(email: string, password: string, mode: "sign_up" | "sign_in"): ErrorCode | null {
  if (email.trim().length === 0 || password.length === 0) return "auth.credentials_required";
  // Sign-in never applies the sign-up rules: an account may predate them,
  // and refusing early would say nothing Supabase doesn't.
  if (mode === "sign_in") return null;
  if (password.length < MIN_PASSWORD_LENGTH) return "auth.password_too_short";
  if (new TextEncoder().encode(password).length > MAX_PASSWORD_BYTES) return "auth.password_too_long";
  return null;
}

export function checkTenantInput(name: string, slug: string): ErrorCode | null {
  if (name.trim().length === 0) return "tenant.name_required";
  if (!SLUG_PATTERN.test(slug)) return "tenant.slug_invalid";
  return null;
}

export function checkFilename(filename: string): ErrorCode | null {
  // Postgres length() counts code points; a JS string's length counts UTF-16
  // units, which would reject a name of 255 emoji that Postgres accepts.
  let length = 0;
  for (const character of filename) {
    length += 1;
    const point = character.codePointAt(0) ?? 0;
    // C0 controls, DEL and C1 controls: what [[:cntrl:]] covers
    if (point < 0x20 || (point >= 0x7f && point <= 0x9f)) return "document.filename_invalid";
  }
  if (length < 1 || length > MAX_FILENAME_LENGTH) return "document.filename_invalid";
  if (filename.trim().length === 0) return "document.filename_invalid";
  return null;
}

export function checkUploadFile(file: { type: string; size: number } | null | undefined): ErrorCode | null {
  if (!file) return "upload.no_file";
  if (!isSupportedMimeType(file.type)) return "upload.file_type_not_allowed";
  if (file.size > MAX_UPLOAD_BYTES) return "upload.file_too_large";
  return null;
}

// A document may have at most EXTRACTION_LIMITS.maxPagesPerDocument pages,
// and a PDF's pages must be countable (src/lib/extraction/page-count.ts),
// so that no run can read more than the stale-run reaper's estimate
// assumes. Images are one page. `pages` is the count, null when it couldn't
// be read.
export function checkPageCount(pages: number | null): ErrorCode | null {
  if (pages === null) return "document.pages_unreadable";
  if (pages > EXTRACTION_LIMITS.maxPagesPerDocument) return "document.too_many_pages";
  return null;
}

// Database (PostgREST) ---------------------------------------------------

// What was being attempted, named after the RPC or the table write. The
// same SQLSTATE means different things in different calls.
export type DatabaseOperation =
  | "create_tenant"
  | "update_tenant"
  | "delete_tenant"
  | "delete_own_account"
  | "insert_membership"
  | "update_membership"
  | "delete_membership"
  | "select_document"
  | "insert_document"
  | "update_document"
  | "delete_document"
  | "complete_document_upload"
  | "enqueue_extraction_run"
  // the worker recording a run's outcome (finish_extraction_run)
  | "record_run"
  | "select";

// A PostgrestError, or the plain { code, message, details, hint } object
// postgrest-js returns. status is the response's HTTP status, if the caller
// has it: `{ ...result.error, status: result.status }`.
export type DatabaseErrorLike = {
  code?: string | null;
  message?: string | null;
  status?: number | null;
};

// PostgREST refused the JWT: undecodable (301), anonymous role disabled
// (302), claims invalid or expired (303).
const JWT_REJECTED = new Set(["PGRST301", "PGRST302", "PGRST303"]);

// Worth repeating unchanged: serialization failure, deadlock, out of
// resources, lock not available, statement timeout, shutdowns. Not the
// whole of class 53: 53400 is our spend ceiling. The worker also repeats a
// finish refused with one of these (delivery.ts).
export const TRANSIENT_SQLSTATES: ReadonlySet<string> = new Set([
  "40001",
  "40P01",
  "53000",
  "53200",
  "53300",
  "55P03",
  "57014",
  "57P01",
  "57P02",
  "57P03",
]);

export function classifyDatabaseError(
  error: DatabaseErrorLike | null | undefined,
  operation: DatabaseOperation,
): ErrorCode {
  return guarded(() => databaseCode(error, operation));
}

function databaseCode(error: DatabaseErrorLike | null | undefined, operation: DatabaseOperation): ErrorCode {
  if (!isRecord(error)) return "unknown";
  // Whatever stopped the worker's finish (lost connection, a price missing
  // for the model), the outcome for the user is the same: the run stays
  // open until the queue's sweep releases the document.
  if (operation === "record_run") return "extraction.record_failed";

  const code = stringField(error, "code");
  const message = stringField(error, "message") ?? "";
  const status = numberField(error, "status");

  // postgrest-js reports a request that got no response at all as code "".
  if (code === "") return "network.unavailable";
  if ((code !== undefined && JWT_REJECTED.has(code)) || status === 401) return "auth.session_expired";
  if ((code === "42501" || code === "P0001") && message.startsWith(DATABASE_PHRASES.authenticationRequired)) {
    return "auth.not_signed_in";
  }

  const specific = code === undefined ? undefined : byOperation(operation, code, message);
  if (specific) return specific;

  if (code !== undefined) {
    if (/^PGRST00[0-3]$/.test(code) || code.startsWith("08") || TRANSIENT_SQLSTATES.has(code)) {
      return "service.unavailable";
    }
    // bad text for a type (a uuid, an enum), a missing value, a check
    // nobody named above, a value too long, a bad parameter
    if (["22P02", "23502", "23514", "22001", "22023"].includes(code)) return "input.invalid";
  }
  if (status !== undefined && (status >= 500 || status === 429)) return "service.unavailable";
  return "unknown";
}

function byOperation(operation: DatabaseOperation, code: string, message: string): ErrorCode | undefined {
  switch (operation) {
    case "create_tenant":
    case "update_tenant":
      if (code === "23505") return "tenant.slug_taken";
      if (code === "23514") {
        if (message.includes(`"${CHECK_CONSTRAINTS.tenantSlug}"`)) return "tenant.slug_invalid";
        if (message.includes(`"${CHECK_CONSTRAINTS.tenantName}"`)) return "tenant.name_required";
        return undefined;
      }
      // create_tenant's execute grant is authenticated-only
      if (code === "42501") return operation === "create_tenant" ? "auth.not_signed_in" : "tenant.update_not_allowed";
      return undefined;

    case "delete_tenant":
      if (code === "42501") return "tenant.delete_not_owner";
      if (code === "55000") {
        if (message.startsWith(DATABASE_PHRASES.tenantExtractionInProgress)) return "tenant.delete_extraction_running";
        if (message.startsWith(DATABASE_PHRASES.tenantFilesRemain)) return "tenant.delete_has_files";
      }
      if (code === "22P02") return "tenant.not_found";
      return undefined;

    case "delete_own_account":
      if (code === "55000") return "account.delete_owns_organization";
      return undefined;

    case "insert_membership":
      if (code === "42501") return "membership.not_allowed";
      if (code === "23505") return "membership.already_member";
      // RLS runs first, so an unknown tenant is 42501; this is the user id
      if (code === "23503") return "membership.user_not_found";
      return undefined;

    case "update_membership":
    case "delete_membership":
      if (code === "42501") return "membership.not_allowed";
      // memberships_keep_an_owner; nothing else on memberships raises 23514
      if (code === "23514") return "membership.last_owner";
      return undefined;

    case "select_document":
      if (code === "22P02" || code === "PGRST116") return "document.not_found";
      return undefined;

    case "insert_document":
      if (code === "42501" || code === "22P02" || code === "23503") return "upload.not_allowed";
      if (code === "23514" && message.includes(`"${CHECK_CONSTRAINTS.documentFilename}"`)) {
        return "document.filename_invalid";
      }
      return undefined;

    case "update_document":
      if (code === "42501") return "document.rename_not_allowed";
      if (code === "22P02") return "document.not_found";
      if (code === "23514" && message.includes(`"${CHECK_CONSTRAINTS.documentFilename}"`)) {
        return "document.filename_invalid";
      }
      return undefined;

    case "delete_document":
      if (code === "42501") return "document.delete_not_allowed";
      if (code === "22P02") return "document.not_found";
      // documents_keep_row_while_file_exists
      if (code === "55000") return "document.file_still_present";
      return undefined;

    case "complete_document_upload":
      // missing, not the uploader, and no longer a member are one 42501 on
      // purpose (the RPC can't be used to probe ids)
      if (code === "42501" || code === "22P02") return "upload.not_allowed";
      if (code === "55000") {
        if (message.startsWith(DATABASE_PHRASES.notWaitingForUpload)) return "upload.already_uploaded";
        if (message.startsWith(DATABASE_PHRASES.noFileUploaded)) return "upload.file_missing";
      }
      return undefined;

    case "enqueue_extraction_run":
      // missing and not-admin are one 42501 on purpose
      if (code === "42501" || code === "22P02") return "extraction.not_allowed";
      if (code === "54000") return "extraction.rate_limited";
      if (code === "53400") {
        if (message.startsWith(DATABASE_PHRASES.tenantCeilingReached)) return "extraction.tenant_budget_reached";
        if (message.startsWith(DATABASE_PHRASES.globalCeilingReached)) return "extraction.global_budget_reached";
      }
      if (code === "55000") {
        if (message.startsWith(DATABASE_PHRASES.documentHasNoFile)) return "extraction.no_file";
        if (message.startsWith(DATABASE_PHRASES.extractionAlreadyRunning)) return "extraction.already_running";
      }
      return undefined;

    case "record_run":
    case "select":
      return undefined;
  }
}

// Supabase Auth ----------------------------------------------------------

// Named after the supabase.auth method that failed.
export type AuthOperation = "signUp" | "signInWithPassword" | "signOut" | "exchangeCodeForSession" | "getClaims";

// An AuthError from @supabase/supabase-js: AuthApiError carries the
// server's code and status, AuthWeakPasswordError adds reasons, and the
// client-side subclasses are told apart by name.
export type AuthErrorLike = {
  name?: string;
  code?: string;
  status?: number;
  message?: string;
  reasons?: unknown;
};

// Record over the SDK's own union, so a new reason in a Supabase upgrade
// fails the type check here instead of falling through silently.
const WEAK_PASSWORD_CODES: Record<WeakPasswordReasons, ErrorCode> = {
  length: "auth.password_too_short",
  characters: "auth.password_missing_characters",
  pwned: "auth.password_breached",
};

const SESSION_GONE = new Set([
  "session_not_found",
  "session_expired",
  "refresh_token_not_found",
  "refresh_token_already_used",
  "bad_jwt",
  "invalid_jwt",
]);

export function classifyAuthError(error: AuthErrorLike | null | undefined, operation: AuthOperation): ErrorCode {
  return guarded(() => authCode(error, operation));
}

function authCode(error: AuthErrorLike | null | undefined, operation: AuthOperation): ErrorCode {
  if (!isRecord(error)) return "unknown";
  const name = stringField(error, "name");
  const code = stringField(error, "code");
  const status = numberField(error, "status");
  const message = stringField(error, "message") ?? "";

  // The SDK wraps "no response" (status 0) and 5xx alike in this class.
  if (name === "AuthRetryableFetchError") return status ? "service.unavailable" : "network.unavailable";
  if (code === "over_email_send_rate_limit" || code === "over_sms_send_rate_limit") return "auth.email_rate_limited";
  if (code === "over_request_rate_limit" || status === 429) return "auth.rate_limited";
  // Expired, already used, unknown, or opened in another browser (the PKCE
  // verifier lives in the cookie of the browser that signed up): the user
  // can't tell these apart and the remedy is the same.
  if (operation === "exchangeCodeForSession") return "auth.confirmation_link_invalid";
  if (name === "AuthSessionMissingError") return "auth.not_signed_in";
  if (name === "AuthInvalidCredentialsError") return "auth.credentials_required";

  switch (code) {
    case "weak_password":
      return weakPasswordCode(error.reasons);
    case "invalid_credentials":
      return "auth.invalid_credentials";
    case "user_already_exists":
    case "email_exists":
      return "auth.email_taken";
    case "email_address_invalid":
      return "auth.email_invalid";
    case "email_address_not_authorized":
      return "auth.email_not_allowed";
    case "email_not_confirmed":
      return "auth.email_not_confirmed";
    case "signup_disabled":
      return "auth.signup_disabled";
    case "email_provider_disabled":
    case "provider_disabled":
      return operation === "signUp" ? "auth.signup_disabled" : "auth.sign_in_disabled";
    case "user_banned":
      return "auth.account_suspended";
    case "user_not_found":
      // never tell a sign-in form whether an email is registered
      return operation === "signInWithPassword" ? "auth.invalid_credentials" : "auth.session_expired";
    case "no_authorization":
      return "auth.not_signed_in";
    case "validation_failed":
      // GoTrue's wording, not ours, so it can't be checked against a
      // migration; it only sharpens what would otherwise be input.invalid.
      // The local check catches an over-long password before this.
      if (/longer than \d+ characters/i.test(message)) return "auth.password_too_long";
      if (/email/i.test(message)) return "auth.email_invalid";
      return "input.invalid";
    case "request_timeout":
    case "hook_timeout":
    case "hook_timeout_after_retry":
    case "unexpected_failure":
      return "service.unavailable";
  }
  if (code !== undefined && SESSION_GONE.has(code)) return "auth.session_expired";
  if (status !== undefined && status >= 500) return "service.unavailable";
  return "unknown";
}

// One reason gets its specific message. Several, none, or one this code
// doesn't know get the message that states every rule, so the user isn't
// sent round the form once per rule.
function weakPasswordCode(reasons: unknown): ErrorCode {
  const list = Array.isArray(reasons) ? [...new Set(reasons)] : [];
  const only = list.length === 1 ? list[0] : undefined;
  if (typeof only === "string" && Object.prototype.hasOwnProperty.call(WEAK_PASSWORD_CODES, only)) {
    return WEAK_PASSWORD_CODES[only as WeakPasswordReasons];
  }
  return "auth.password_weak";
}

// Supabase Storage -------------------------------------------------------

// Named after the storage method that failed. createSignedUrl is the
// app's download; download is what the Extract action uses, and its failure
// is stored as a run error instead (see classifyRunError).
export type StorageOperation = "upload" | "createSignedUrl" | "download" | "remove";

// A StorageError from @supabase/storage-js. StorageApiError carries the
// HTTP status, statusCode (the response body's own status, often "403" or
// "404" inside an HTTP 400) and code (the service's error code, such as
// AccessDenied). StorageUnknownError means no response was read.
export type StorageErrorLike = {
  name?: string;
  message?: string;
  status?: number;
  statusCode?: string;
  code?: string;
};

export function classifyStorageError(
  error: StorageErrorLike | null | undefined,
  operation: StorageOperation,
): ErrorCode {
  return guarded(() => storageCode(error, operation));
}

function storageCode(error: StorageErrorLike | null | undefined, operation: StorageOperation): ErrorCode {
  if (!isRecord(error)) return "unknown";
  const name = stringField(error, "name");
  const code = stringField(error, "code");
  const statusCode = stringField(error, "statusCode");
  const status = numberField(error, "status");

  if (name === "StorageUnknownError") return "network.unavailable";

  switch (code) {
    case "InvalidJWT":
      return "auth.session_expired";
    case "EntityTooLarge":
      return "upload.file_too_large";
    case "InvalidMimeType":
      return "upload.file_type_not_allowed";
    case "KeyAlreadyExists":
    case "ResourceAlreadyExists":
    case "Duplicate":
      return operation === "upload" ? "upload.already_uploaded" : "unknown";
    case "AccessDenied":
      return storageRefused(operation);
    case "NoSuchKey":
      return storageMissing(operation);
    case "InternalError":
    case "DatabaseError":
    case "DatabaseTimeout":
    case "ResourceLocked":
    case "LockTimeout":
    case "SlowDown":
      return "service.unavailable";
  }

  // The body's status first: Storage often answers HTTP 400 with the real
  // status inside. statusCode falls back to the service code when the body
  // has no status, so only a three-digit value counts.
  const effective = statusCode && /^\d{3}$/.test(statusCode) ? Number(statusCode) : status;
  if (effective === undefined) return "unknown";
  if (effective === 401) return "auth.session_expired";
  if (effective === 403) return storageRefused(operation);
  if (effective === 404) return storageMissing(operation);
  if (effective === 409) return operation === "upload" ? "upload.already_uploaded" : "unknown";
  if (effective === 413) return "upload.file_too_large";
  if (effective === 415) return "upload.file_type_not_allowed";
  if (effective === 423 || effective === 429 || effective >= 500) return "service.unavailable";
  return "unknown";
}

// Refused by a storage policy. A download that is refused and one whose
// object is gone get the same message: the select policy hides objects,
// so Storage itself can't tell them apart either.
function storageRefused(operation: StorageOperation): ErrorCode {
  switch (operation) {
    case "upload":
      return "upload.not_allowed";
    case "createSignedUrl":
    case "download":
      return "download.not_found";
    case "remove":
      return "document.delete_not_allowed";
  }
}

function storageMissing(operation: StorageOperation): ErrorCode {
  switch (operation) {
    case "createSignedUrl":
    case "download":
      return "download.not_found";
    case "remove":
      return "document.not_found";
    case "upload":
      return "unknown";
  }
}

// Model providers --------------------------------------------------------

// A Record, not a list, so a new ProviderErrorKind fails the type check
// here until it is classified.
const PROVIDER_ERROR_KINDS: Record<ProviderErrorKind, true> = {
  transport: true,
  server: true,
  client: true,
  refusal: true,
  truncated: true,
};

const PROVIDER_NAMES = Object.keys(DEFAULT_MODELS) as ProviderName[];

// A ProviderError, or its kind, status and message recovered from a stored
// run error.
export type ProviderErrorLike = {
  kind: ProviderErrorKind;
  status?: number;
  message?: string;
};

export function classifyProviderError(error: ProviderErrorLike | null | undefined): ErrorCode {
  return guarded(() => providerCode(error));
}

function providerCode(error: ProviderErrorLike | null | undefined): ErrorCode {
  if (!isRecord(error)) return "unknown";
  const kind = stringField(error, "kind");
  if (kind === undefined || !Object.prototype.hasOwnProperty.call(PROVIDER_ERROR_KINDS, kind)) return "unknown";
  const status = numberField(error, "status");
  const message = stringField(error, "message") ?? "";

  switch (kind as ProviderErrorKind) {
    case "transport":
      return message.startsWith(PROVIDER_MESSAGES.timeout) ? "extraction.provider_timeout" : "extraction.provider_unavailable";
    case "server":
      return "extraction.provider_unavailable";
    case "client":
      // a 4xx that waiting fixes
      if (status === 429) return "extraction.provider_unavailable";
      // our key or our model id, not the document
      if (status === 401 || status === 403 || status === 404) return "extraction.not_configured";
      if (status === undefined) {
        // A billed answer that ended abnormally: an unexpected stop reason,
        // or an OpenAI response left cancelled, queued or in progress.
        // Nothing the document did; a new run is likely to finish.
        if (message.startsWith(PROVIDER_MESSAGES.unexpectedStop) || message.startsWith(PROVIDER_MESSAGES.notCompleted)) {
          return "extraction.answer_incomplete";
        }
        // Otherwise the SDK failed before or after the request, or the
        // response lacked usage. Not the document's fault either.
        return "unknown";
      }
      return "extraction.provider_rejected";
    case "refusal":
      return "extraction.refused";
    case "truncated":
      return "extraction.truncated";
  }
}

// Stored run errors ------------------------------------------------------

const KIND_PATTERN = Object.keys(PROVIDER_ERROR_KINDS).join("|");
const PROVIDER_PATTERN = PROVIDER_NAMES.join("|");
// describeError's rendering of a ProviderError: "<provider> <kind>[ <status>]: <message>"
const DESCRIPTOR = `(?:${PROVIDER_PATTERN}) (?:${KIND_PATTERN})(?: \\d{3})?: `;
const DESCRIPTOR_AT_START = new RegExp(`^(${PROVIDER_PATTERN}) (${KIND_PATTERN})(?: (\\d{3}))?: ([\\s\\S]*)$`);
// run.ts's shape when the fallback's first call failed too: a descriptor,
// the primary's message, "; fallback ", and a second descriptor. A single
// provider error that merely mentions another provider doesn't have it.
const FALLBACK_FAILED = new RegExp(`^${DESCRIPTOR}[\\s\\S]*?${escapeRegExp(RUN_ERROR_MARKERS.fallbackFailed)}${DESCRIPTOR}`);

// Turns extraction_runs.error (and the Extract action's outcome.error) into
// a code. Members can read that column, and it is written for engineers,
// so the UI shows this code's message instead of the text.
export function classifyRunError(error: string | null | undefined): ErrorCode {
  return guarded(() => runCode(error));
}

// "cost estimated at the dearest price on file (22023; served by x): ..." or
// "cost estimated at claude-sonnet-5 prices (abandoned; ...): ..."
const COST_ESTIMATED = new RegExp(`^${escapeRegExp(RUN_ERROR_MARKERS.costEstimated)} [^()\\n]{1,120} \\([^()]*\\): `);

// Whether a run's cost is an estimate: failedCloseAttempts charged it at the
// dearest price on file because the database couldn't price the model that
// served it, or the stale-run reaper charged an abandoned run an estimate
// from its page count. The page shows such a cost as estimated.
export function isCostEstimated(error: string | null | undefined): boolean {
  return typeof error === "string" && COST_ESTIMATED.test(error);
}

function runCode(error: string | null | undefined): ErrorCode {
  if (typeof error !== "string" || error.trim().length === 0) return "unknown";

  const estimated = COST_ESTIMATED.exec(error);
  if (estimated) return runCode(error.slice(estimated[0].length));

  if (error.startsWith(RUN_ERROR_MARKERS.abandoned)) return "extraction.abandoned";
  if (error.startsWith(RUN_ERROR_MARKERS.expired)) return "extraction.expired";
  if (error.startsWith(RUN_ERROR_MARKERS.downloadFailed)) return "extraction.download_failed";
  if (error.startsWith(RUN_ERROR_MARKERS.resultNotRecorded)) return "extraction.result_not_saved";
  if (error.startsWith(RUN_ERROR_MARKERS.typeMismatch)) return "extraction.file_type_mismatch";
  if (error.startsWith(RUN_ERROR_MARKERS.pagesUnreadable)) return "document.pages_unreadable";
  if (error.startsWith(RUN_ERROR_MARKERS.tooManyPages)) return "document.too_many_pages";
  if (error.startsWith(RUN_ERROR_MARKERS.pageCountMismatch)) return "extraction.page_count_mismatch";
  if (error.startsWith(RUN_ERROR_MARKERS.tooDense)) return "extraction.too_dense";
  // The validation error is built from the validator's own wording, but a
  // stored error can come from anywhere (an admin can close a run with any
  // text), and a document can steer the model. So nothing past these
  // prefixes is searched: text inside a document must not be able to pick
  // the message.
  if (error.startsWith(RUN_ERROR_MARKERS.invalidAfterRetry)) return "extraction.invalid_answer";
  if (error.startsWith(RUN_ERROR_MARKERS.retryFailed)) {
    // "retry after invalid response (<validation error>) failed: <provider
    // error>". The provider error comes last, so read only what follows the
    // last separator.
    const at = error.lastIndexOf(RUN_ERROR_MARKERS.retryFailedSeparator);
    if (at < 0) return "extraction.invalid_answer";
    const code = classifyProviderText(error.slice(at + RUN_ERROR_MARKERS.retryFailedSeparator.length));
    return code === "unknown" ? "extraction.invalid_answer" : code;
  }

  // describeError renders a plain Error as "<name>: <message>"
  const unwrapped = error.replace(/^[A-Za-z]*Error: /, "");
  if (
    unwrapped.startsWith(RUN_ERROR_MARKERS.notConfigured) ||
    unwrapped.startsWith(RUN_ERROR_MARKERS.providerNotSelected) ||
    unwrapped.startsWith(RUN_ERROR_MARKERS.modelNotSelected)
  ) {
    return "extraction.not_configured";
  }
  return classifyProviderText(error);
}

// Provider errors as describeError renders them, possibly two joined by
// run.ts after a fallback, or one with the no-fallback note appended. A
// count that failed reads as the failure it was: no call was sent after it.
function classifyProviderText(text: string): ErrorCode {
  if (text.startsWith(RUN_ERROR_MARKERS.inputNotMeasured)) {
    return classifyProviderText(text.slice(RUN_ERROR_MARKERS.inputNotMeasured.length));
  }
  if (FALLBACK_FAILED.test(text)) return "extraction.all_providers_failed";
  const match = DESCRIPTOR_AT_START.exec(text);
  if (!match) return "unknown";
  return classifyProviderError({
    kind: match[2] as ProviderErrorKind,
    status: match[3] === undefined ? undefined : Number(match[3]),
    message: match[4],
  });
}

// Thrown errors ----------------------------------------------------------

// For an exception around a call that doesn't return { error }, such as a
// Server Action invoked from the browser. Only "the network failed" is told
// apart; everything else is unknown.
export function classifyThrown(error: unknown): ErrorCode {
  return guarded(() => thrownCode(error));
}

// The exact messages fetch rejects with when the network fails. Matching a
// word such as "fetch" instead would turn a bug like
// TypeError("fetchDocuments is not a function") into a network message.
const FETCH_FAILURES = new Set([
  "Failed to fetch", // Chrome, Edge
  "NetworkError when attempting to fetch resource.", // Firefox
  "Load failed", // Safari
  "The network connection was lost.", // older Safari
  "The Internet connection appears to be offline.", // older Safari
  "fetch failed", // Node (undici)
]);

function thrownCode(error: unknown): ErrorCode {
  if (!isRecord(error)) return "unknown";
  const name = stringField(error, "name");
  const message = stringField(error, "message") ?? "";
  if (name === "AbortError" || name === "TimeoutError") return "network.unavailable";
  if (name === "TypeError" && FETCH_FAILURES.has(message)) return "network.unavailable";
  return "unknown";
}

// Helpers ----------------------------------------------------------------

// Every classifier runs inside this. Its input comes from SDKs, JSON and
// catch blocks, and one that throws when read (a getter, a revoked Proxy)
// must give a message, not a second error.
function guarded(classify: () => ErrorCode): ErrorCode {
  try {
    return classify();
  } catch {
    return "unknown";
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Inputs are typed, but they come from SDKs, JSON and catch blocks, so
// every field is checked before it is trusted.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringField(record: object, key: string): string | undefined {
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function numberField(record: object, key: string): number | undefined {
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
