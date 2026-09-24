// The error taxonomy (src/lib/errors.ts), tested without a database or a
// network. Four kinds of check:
//
//   - the catalog: every message is plain, short, leaks nothing, and says
//     "try again" exactly when retrying can help
//   - drift: ERRORS.md matches the catalog; every raise in
//     supabase/migrations has a reviewed code; each phrase and rule the
//     module mirrors still exists in the SQL or the source that produces it
//   - classifiers: real error objects from the Supabase SDKs and
//     ProviderError, and the strings the real orchestrator stores
//   - no echo: whatever the input, the user sees only a catalog message

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { StorageUnknownError } from "@supabase/storage-js";
import {
  AuthApiError,
  AuthInvalidCredentialsError,
  AuthInvalidJwtError,
  AuthPKCECodeVerifierMissingError,
  AuthRetryableFetchError,
  AuthSessionMissingError,
  AuthWeakPasswordError,
  PostgrestError,
  StorageApiError,
} from "@supabase/supabase-js";
import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { ANTHROPIC_MODEL_ENV_VAR, EXTRACTION_LIMITS, PROVIDER_ENV_VAR } from "@/lib/extraction/config";
import { describeError, ProviderError, type ProviderResponse } from "@/lib/extraction/providers/types";
import { interpretAnthropicMessage, interpretOpenAIResponse } from "@/lib/extraction/providers/interpret";
import { runExtraction } from "@/lib/extraction/run";
import {
  checkCredentials,
  checkFilename,
  checkPageCount,
  checkTenantInput,
  checkUploadFile,
  CHECK_CONSTRAINTS,
  classifyAuthError,
  classifyDatabaseError,
  classifyProviderError,
  classifyRunError,
  classifyStorageError,
  classifyThrown,
  DATABASE_PHRASES,
  ERROR_CATALOG,
  ERROR_CODES,
  isErrorCode,
  MAX_FILENAME_LENGTH,
  MAX_UPLOAD_BYTES,
  PROVIDER_MESSAGES,
  RUN_ERROR_MARKERS,
  SLUG_PATTERN,
  UPLOAD_MIME_TYPES,
  userFacingError,
  type AuthOperation,
  type DatabaseOperation,
  type ErrorCode,
  type StorageOperation,
} from "@/lib/errors";
import { MAX_PASSWORD_BYTES, MIN_PASSWORD_LENGTH } from "@/lib/password";
import { fakeProvider } from "../helpers/fake-provider";
import { parseMigrations, type ParsedMigrations, type SqlRaise } from "../helpers/sql-raises";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

// The migrations ----------------------------------------------------------

const MIGRATIONS_DIR = "supabase/migrations";
const migrationFiles = readdirSync(join(ROOT, MIGRATIONS_DIR))
  .filter((name) => name.endsWith(".sql"))
  .sort();
const migrations = migrationFiles.map((name) => ({ name, sql: read(join(MIGRATIONS_DIR, name)) }));
const allSql = migrations.map((m) => m.sql).join("\n");

// Every RAISE in the migrations (tests/helpers/sql-raises.ts). The parser
// throws on any form it can't read completely; the first migration test
// reports that, since the tests that iterate over raises would otherwise
// just see none.
let parsed: ParsedMigrations = { all: [], live: [], liveBodies: new Map() };
let parseFailure: unknown = null;
try {
  parsed = parseMigrations(migrations);
} catch (error) {
  parseFailure = error;
}

// The ones a user can hit: in the definition of a function that is in force
// after the last migration (an older body of close_extraction_run doesn't
// count), at the level that aborts.
const raises = parsed.live.filter((r) => r.level === "exception");
const raiseKey = (r: SqlRaise) => `${r.fn}: ${r.message}`;

// What each function's errors surface as, by the operation the app names
// when it classifies them. Triggers surface through the write that fired
// them.
const FUNCTION_OPERATIONS: Record<string, DatabaseOperation[]> = {
  create_tenant: ["create_tenant"],
  delete_tenant: ["delete_tenant"],
  delete_own_account: ["delete_own_account"],
  enforce_tenant_has_owner: ["update_membership", "delete_membership"],
  refuse_document_delete_while_file_exists: ["delete_document"],
  complete_document_upload: ["complete_document_upload"],
  enqueue_extraction_run: ["enqueue_extraction_run"],
  open_extraction_run: ["open_extraction_run"],
  close_extraction_run: ["close_extraction_run"],
  finish_extraction_run: ["finish_extraction_run"],
  // helpers, surfacing through the RPCs that call them
  check_extraction_limits: ["enqueue_extraction_run", "open_extraction_run"],
  extraction_charge: ["close_extraction_run", "finish_extraction_run"],
  // the ledger's append-only trigger: only the definer functions that end a
  // run write the ledger, and they only insert
  refuse_spend_change: ["close_extraction_run", "finish_extraction_run"],
};

// The reviewed code for every raise. A new or reworded raise fails the test
// until someone decides here what the user should be told.
const RAISE_CODES: Record<string, ErrorCode> = {
  "create_tenant: authentication required": "auth.not_signed_in",
  "delete_tenant: only an owner can delete a tenant": "tenant.delete_not_owner",
  "delete_tenant: an extraction is in progress for this tenant": "tenant.delete_extraction_running",
  "delete_tenant: remove the tenant's files from storage before deleting it": "tenant.delete_has_files",
  "delete_own_account: authentication required": "auth.not_signed_in",
  "delete_own_account: delete your tenants or transfer ownership first": "account.delete_owns_organization",
  "enforce_tenant_has_owner: a tenant must keep at least one owner": "membership.last_owner",
  "refuse_document_delete_while_file_exists: remove the document's file from storage before deleting its row":
    "document.file_still_present",
  "complete_document_upload: authentication required": "auth.not_signed_in",
  "complete_document_upload: document not found or not uploaded by you": "upload.not_allowed",
  "complete_document_upload: you are no longer a member of this tenant": "upload.not_allowed",
  "complete_document_upload: document is not waiting for an upload": "upload.already_uploaded",
  "complete_document_upload: no file has been uploaded for this document": "upload.file_missing",
  "open_extraction_run: authentication required": "auth.not_signed_in",
  "open_extraction_run: document not found or you are not an admin of its organization": "extraction.not_allowed",
  "open_extraction_run: the document has no file yet": "extraction.no_file",
  "open_extraction_run: an extraction is already running for this document": "extraction.already_running",
  "enqueue_extraction_run: authentication required": "auth.not_signed_in",
  "enqueue_extraction_run: document not found or you are not an admin of its organization": "extraction.not_allowed",
  "enqueue_extraction_run: the document has no file yet": "extraction.no_file",
  "enqueue_extraction_run: an extraction is already running for this document": "extraction.already_running",
  "check_extraction_limits: this organization has reached its monthly extraction spend ceiling (% USD), counting extractions in progress":
    "extraction.tenant_budget_reached",
  "check_extraction_limits: the monthly extraction spend ceiling across all organizations has been reached (% USD), counting extractions in progress":
    "extraction.global_budget_reached",
  "check_extraction_limits: this organization has reached its limit of % extraction runs per hour":
    "extraction.rate_limited",
  // A failed close leaves the run open whatever the reason, and that is
  // what the user needs to know.
  "close_extraction_run: authentication required": "extraction.record_failed",
  "close_extraction_run: status must be succeeded or failed": "extraction.record_failed",
  "close_extraction_run: run not found or close token invalid": "extraction.record_failed",
  "close_extraction_run: only the user who opened the run can close it": "extraction.record_failed",
  "close_extraction_run: run is already closed": "extraction.record_failed",
  "close_extraction_run: a failed run cannot carry fields": "extraction.record_failed",
  "close_extraction_run: a failed run needs an error": "extraction.record_failed",
  "close_extraction_run: a successful run must name its model": "extraction.record_failed",
  "close_extraction_run: token counts without a model": "extraction.record_failed",
  "close_extraction_run: fields must be a JSON array": "extraction.record_failed",
  "close_extraction_run: malformed field: %": "extraction.record_failed",
  // The worker's finish: whatever refused it, the run stays running until
  // the sweep, and the worker only logs the code.
  "finish_extraction_run: status must be succeeded or failed": "extraction.record_failed",
  "finish_extraction_run: run not found or claim token invalid": "extraction.record_failed",
  "finish_extraction_run: run is not running": "extraction.record_failed",
  "finish_extraction_run: a failed run cannot carry fields": "extraction.record_failed",
  "finish_extraction_run: a failed run needs an error": "extraction.record_failed",
  "finish_extraction_run: a successful run must name its model": "extraction.record_failed",
  "finish_extraction_run: token counts without a model": "extraction.record_failed",
  "finish_extraction_run: fields must be a JSON array": "extraction.record_failed",
  "finish_extraction_run: malformed field: %": "extraction.record_failed",
  "extraction_charge: no price on file for model %": "extraction.record_failed",
  "extraction_charge: model % belongs to provider %": "extraction.record_failed",
  "refuse_spend_change: extraction spend is append-only": "extraction.record_failed",
};

// Postgres substitutes each % with an argument
const render = (literal: string) => literal.replace(/%/g, "1.000000");

// Fixtures ----------------------------------------------------------------

function pgError(code: string, message: string, details = ""): PostgrestError {
  return new PostgrestError({ code, message, details, hint: "" });
}

// A secret-shaped, tenant-identifying, markup-bearing string: if any of it
// reached a user-facing message, the no-echo tests would see it.
const SECRET = 'sk-ant-api03-SECRETSECRET tenant 7c9e6679-7425-40de-944b-e07fc1f0d479 <script>x</script> "orders"';

type DbCase = [label: string, error: Parameters<typeof classifyDatabaseError>[0], DatabaseOperation, ErrorCode];

const DATABASE_CASES: DbCase[] = [
  // tenants
  ["slug taken", pgError("23505", 'duplicate key value violates unique constraint "tenants_slug_key"', "Key (slug)=(acme) already exists."), "create_tenant", "tenant.slug_taken"],
  ["slug taken on update", pgError("23505", 'duplicate key value violates unique constraint "tenants_slug_key"'), "update_tenant", "tenant.slug_taken"],
  ["slug check", pgError("23514", 'new row for relation "tenants" violates check constraint "tenants_slug_check"'), "create_tenant", "tenant.slug_invalid"],
  ["name check", pgError("23514", 'new row for relation "tenants" violates check constraint "tenants_name_check"'), "create_tenant", "tenant.name_required"],
  ["another tenants check", pgError("23514", 'new row for relation "tenants" violates check constraint "tenants_other_check"'), "update_tenant", "input.invalid"],
  ["anonymous create_tenant", pgError("42501", "permission denied for function create_tenant"), "create_tenant", "auth.not_signed_in"],
  ["tenant update by a non-admin", pgError("42501", "permission denied for table tenants"), "update_tenant", "tenant.update_not_allowed"],
  ["malformed tenant id", pgError("22P02", 'invalid input syntax for type uuid: "acme"'), "delete_tenant", "tenant.not_found"],
  ["a 55000 on delete in words no migration raises", pgError("55000", SECRET), "delete_tenant", "unknown"],
  // memberships
  ["non-admin adds a member", pgError("42501", 'new row violates row-level security policy for table "memberships"'), "insert_membership", "membership.not_allowed"],
  ["already a member", pgError("23505", 'duplicate key value violates unique constraint "memberships_tenant_id_user_id_key"'), "insert_membership", "membership.already_member"],
  ["no such user", pgError("23503", 'insert or update on table "memberships" violates foreign key constraint "memberships_user_id_fkey"'), "insert_membership", "membership.user_not_found"],
  ["bad role", pgError("22P02", 'invalid input value for enum tenant_role: "boss"'), "insert_membership", "input.invalid"],
  ["membership column not grantable", pgError("42501", "permission denied for table memberships"), "update_membership", "membership.not_allowed"],
  // documents
  ["upload row by a non-member", pgError("42501", 'new row violates row-level security policy for table "documents"'), "insert_document", "upload.not_allowed"],
  ["upload row into a malformed tenant id", pgError("22P02", 'invalid input syntax for type uuid: "x"'), "insert_document", "upload.not_allowed"],
  ["filename check on insert", pgError("23514", 'new row for relation "documents" violates check constraint "documents_filename_check"'), "insert_document", "document.filename_invalid"],
  ["filename check on rename", pgError("23514", 'new row for relation "documents" violates check constraint "documents_filename_check"'), "update_document", "document.filename_invalid"],
  ["rename of a column not granted", pgError("42501", "permission denied for table documents"), "update_document", "document.rename_not_allowed"],
  ["malformed document id on rename", pgError("22P02", 'invalid input syntax for type uuid: "x"'), "update_document", "document.not_found"],
  ["malformed document id on lookup", pgError("22P02", 'invalid input syntax for type uuid: "x"'), "select_document", "document.not_found"],
  ["single() found no row", pgError("PGRST116", "JSON object requested, multiple (or no) rows returned", "The result contains 0 rows"), "select_document", "document.not_found"],
  ["delete by a non-admin", pgError("42501", "permission denied for table documents"), "delete_document", "document.delete_not_allowed"],
  ["malformed document id on delete", pgError("22P02", 'invalid input syntax for type uuid: "x"'), "delete_document", "document.not_found"],
  ["anonymous completion", pgError("42501", "permission denied for function complete_document_upload"), "complete_document_upload", "upload.not_allowed"],
  // extraction
  ["anonymous open", pgError("42501", "permission denied for function open_extraction_run"), "open_extraction_run", "extraction.not_allowed"],
  ["anonymous enqueue", pgError("42501", "permission denied for function enqueue_extraction_run"), "enqueue_extraction_run", "extraction.not_allowed"],
  ["malformed id on enqueue", pgError("22P02", 'invalid input syntax for type uuid: "x"'), "enqueue_extraction_run", "extraction.not_allowed"],
  ["a 53400 on enqueue in words no migration raises", pgError("53400", SECRET), "enqueue_extraction_run", "unknown"],
  ["malformed id on open", pgError("22P02", 'invalid input syntax for type uuid: "x"'), "open_extraction_run", "extraction.not_allowed"],
  ["a 53400 in words no migration raises", pgError("53400", SECRET), "open_extraction_run", "unknown"],
  ["a 55000 in words no migration raises", pgError("55000", SECRET), "open_extraction_run", "unknown"],
  ["a lost connection on close", { code: "", message: "TypeError: fetch failed" }, "close_extraction_run", "extraction.record_failed"],
  ["a lost connection on the worker's finish", { code: "", message: "TypeError: fetch failed" }, "finish_extraction_run", "extraction.record_failed"],
  // anywhere
  ["no response", { code: "", message: "TypeError: fetch failed", details: "Caused by: ...", hint: "" } as PostgrestError, "select", "network.unavailable"],
  ["aborted", { code: "", message: "AbortError: This operation was aborted", details: "", hint: "Request was aborted (timeout or manual cancellation)" } as PostgrestError, "insert_document", "network.unavailable"],
  ["expired JWT", pgError("PGRST303", "JWT expired"), "select", "auth.session_expired"],
  ["undecodable JWT", pgError("PGRST301", "No suitable key or wrong key type"), "open_extraction_run", "auth.session_expired"],
  ["HTTP 401 without a code", { message: "Unauthorized", status: 401 }, "select", "auth.session_expired"],
  ["PostgREST can't reach Postgres", pgError("PGRST001", "Database client error. Retrying the connection."), "select", "service.unavailable"],
  ["statement timeout", pgError("57014", "canceling statement due to statement timeout"), "open_extraction_run", "service.unavailable"],
  ["serialization failure", pgError("40001", "could not serialize access due to concurrent update"), "update_membership", "service.unavailable"],
  ["connection exception", pgError("08006", "connection failure"), "select", "service.unavailable"],
  ["a gateway's HTML 502", { message: "<html><body>502 Bad Gateway</body></html>", status: 502 }, "select", "service.unavailable"],
  ["rate limited by the gateway", { message: "Too Many Requests", status: 429 }, "create_tenant", "service.unavailable"],
  ["missing value", pgError("23502", 'null value in column "name" of relation "tenants" violates not-null constraint'), "create_tenant", "input.invalid"],
  ["an app bug: a generated column", pgError("428C9", 'cannot insert a non-DEFAULT value into column "storage_path"'), "insert_document", "unknown"],
  ["an unknown SQLSTATE", pgError("XX000", SECRET), "select", "unknown"],
  ["no code at all", { message: SECRET }, "select", "unknown"],
];

type AuthCase = [label: string, error: Parameters<typeof classifyAuthError>[0], AuthOperation, ErrorCode];

const weak = (reasons: string[]) =>
  new AuthWeakPasswordError(
    `Password should be at least ${MIN_PASSWORD_LENGTH} characters.`,
    422,
    reasons as ConstructorParameters<typeof AuthWeakPasswordError>[2],
  );

const AUTH_CASES: AuthCase[] = [
  ["too short", weak(["length"]), "signUp", "auth.password_too_short"],
  ["too short, reported twice", weak(["length", "length"]), "signUp", "auth.password_too_short"],
  ["character types", weak(["characters"]), "signUp", "auth.password_missing_characters"],
  ["breached", weak(["pwned"]), "signUp", "auth.password_breached"],
  ["several reasons", weak(["length", "characters"]), "signUp", "auth.password_weak"],
  ["no reasons", weak([]), "signUp", "auth.password_weak"],
  ["a reason this code doesn't know", weak(["length", "dictionary_word"]), "signUp", "auth.password_weak"],
  ["over the byte cap", new AuthApiError("Password cannot be longer than 72 characters", 422, "validation_failed"), "signUp", "auth.password_too_long"],
  ["malformed email (older servers)", new AuthApiError("Unable to validate email address: invalid format", 400, "validation_failed"), "signUp", "auth.email_invalid"],
  ["other validation", new AuthApiError(SECRET, 400, "validation_failed"), "signUp", "input.invalid"],
  ["malformed email", new AuthApiError('Email address "x@y" is invalid', 400, "email_address_invalid"), "signUp", "auth.email_invalid"],
  ["email registered", new AuthApiError("User already registered", 422, "user_already_exists"), "signUp", "auth.email_taken"],
  ["email registered (other code)", new AuthApiError("A user with this email address has already been registered", 422, "email_exists"), "signUp", "auth.email_taken"],
  ["mailer refuses the address", new AuthApiError("Email address not authorized", 400, "email_address_not_authorized"), "signUp", "auth.email_not_allowed"],
  ["sign-ups off", new AuthApiError("Signups not allowed for this instance", 422, "signup_disabled"), "signUp", "auth.signup_disabled"],
  ["email provider off, signing up", new AuthApiError("Email signups are disabled", 422, "email_provider_disabled"), "signUp", "auth.signup_disabled"],
  ["email provider off, signing in", new AuthApiError("Email logins are disabled", 422, "email_provider_disabled"), "signInWithPassword", "auth.sign_in_disabled"],
  ["request rate limit", new AuthApiError("Request rate limit reached", 429, "over_request_rate_limit"), "signInWithPassword", "auth.rate_limited"],
  ["a 429 without a code", new AuthApiError("Too Many Requests", 429, undefined), "signUp", "auth.rate_limited"],
  ["email rate limit", new AuthApiError("email rate limit exceeded", 429, "over_email_send_rate_limit"), "signUp", "auth.email_rate_limited"],
  ["wrong password", new AuthApiError("Invalid login credentials", 400, "invalid_credentials"), "signInWithPassword", "auth.invalid_credentials"],
  ["user_not_found on sign-in says nothing more", new AuthApiError("User not found", 404, "user_not_found"), "signInWithPassword", "auth.invalid_credentials"],
  ["user_not_found for a session", new AuthApiError("User from sub claim in JWT does not exist", 403, "user_not_found"), "getClaims", "auth.session_expired"],
  ["not confirmed", new AuthApiError("Email not confirmed", 400, "email_not_confirmed"), "signInWithPassword", "auth.email_not_confirmed"],
  ["banned", new AuthApiError("User is banned", 400, "user_banned"), "signInWithPassword", "auth.account_suspended"],
  ["missing email and password", new AuthInvalidCredentialsError("You must provide either an email or phone number and a password"), "signInWithPassword", "auth.credentials_required"],
  ["no session", new AuthSessionMissingError(), "getClaims", "auth.not_signed_in"],
  ["no session on sign-out", new AuthSessionMissingError(), "signOut", "auth.not_signed_in"],
  ["no authorization header", new AuthApiError("This endpoint requires a valid Bearer token", 401, "no_authorization"), "getClaims", "auth.not_signed_in"],
  ["bad JWT", new AuthInvalidJwtError("Invalid JWT structure"), "getClaims", "auth.session_expired"],
  ["refresh token gone", new AuthApiError("Invalid Refresh Token: Refresh Token Not Found", 400, "refresh_token_not_found"), "getClaims", "auth.session_expired"],
  ["no response", new AuthRetryableFetchError("fetch failed", 0), "signInWithPassword", "network.unavailable"],
  ["a 503", new AuthRetryableFetchError("Service Unavailable", 503), "signUp", "service.unavailable"],
  ["a server hook timed out", new AuthApiError("Hook timed out", 422, "hook_timeout"), "signUp", "service.unavailable"],
  ["link opened in another browser", new AuthPKCECodeVerifierMissingError(), "exchangeCodeForSession", "auth.confirmation_link_invalid"],
  ["expired link", new AuthApiError("invalid flow state, flow state has expired", 403, "flow_state_expired"), "exchangeCodeForSession", "auth.confirmation_link_invalid"],
  ["used link", new AuthApiError("invalid flow state, no valid flow state found", 404, "flow_state_not_found"), "exchangeCodeForSession", "auth.confirmation_link_invalid"],
  ["rate limited confirming", new AuthApiError("Request rate limit reached", 429, "over_request_rate_limit"), "exchangeCodeForSession", "auth.rate_limited"],
  ["network confirming", new AuthRetryableFetchError("fetch failed", 0), "exchangeCodeForSession", "network.unavailable"],
  ["captcha (not configured here)", new AuthApiError(SECRET, 400, "captcha_failed"), "signUp", "unknown"],
  ["a code newer than this module", new AuthApiError(SECRET, 400, "brand_new_code"), "signInWithPassword", "unknown"],
];

type StorageCase = [label: string, error: Parameters<typeof classifyStorageError>[0], StorageOperation, ErrorCode];

// The Storage API often answers HTTP 400 with the real status in the body's
// statusCode; storage-js keeps both, plus the service's code when present.
const rls = (code?: string) => new StorageApiError("new row violates row-level security policy", 400, "403", "storage", code);

const STORAGE_CASES: StorageCase[] = [
  ["upload refused by the insert policy", rls("AccessDenied"), "upload", "upload.not_allowed"],
  ["upload refused, legacy body", rls(), "upload", "upload.not_allowed"],
  ["signed URL refused", rls("AccessDenied"), "createSignedUrl", "download.not_found"],
  ["remove refused", rls("AccessDenied"), "remove", "document.delete_not_allowed"],
  ["disallowed type", new StorageApiError("mime type text/plain is not supported", 400, "415", "storage", "InvalidMimeType"), "upload", "upload.file_type_not_allowed"],
  ["disallowed type, legacy body", new StorageApiError("mime type text/plain is not supported", 400, "415"), "upload", "upload.file_type_not_allowed"],
  ["too large", new StorageApiError("The object exceeded the maximum allowed size", 400, "413", "storage", "EntityTooLarge"), "upload", "upload.file_too_large"],
  ["too large, from a proxy", new StorageApiError("Payload Too Large", 413, "413"), "upload", "upload.file_too_large"],
  ["already there", new StorageApiError("The resource already exists", 400, "409", "storage", "Duplicate"), "upload", "upload.already_uploaded"],
  ["already there (S3 code)", new StorageApiError("The resource already exists", 409, "409", "storage", "KeyAlreadyExists"), "upload", "upload.already_uploaded"],
  ["signed URL for a missing object", new StorageApiError("Object not found", 400, "404", "storage", "NoSuchKey"), "createSignedUrl", "download.not_found"],
  ["signed URL for a missing object, legacy body", new StorageApiError("Object not found", 400, "404"), "createSignedUrl", "download.not_found"],
  ["download of a missing object", new StorageApiError("Object not found", 400, "404"), "download", "download.not_found"],
  ["remove of a missing object", new StorageApiError("Object not found", 400, "404", "storage", "NoSuchKey"), "remove", "document.not_found"],
  ["expired JWT", new StorageApiError("jwt expired", 400, "InvalidJWT", "storage", "InvalidJWT"), "upload", "auth.session_expired"],
  ["a 401", new StorageApiError("Unauthorized", 401, "401"), "createSignedUrl", "auth.session_expired"],
  ["database timeout", new StorageApiError("Database timeout", 544, "544", "storage", "DatabaseTimeout"), "upload", "service.unavailable"],
  ["a 503", new StorageApiError("Service Unavailable", 503, "503"), "createSignedUrl", "service.unavailable"],
  ["no response", new StorageUnknownError("fetch failed", new TypeError("fetch failed")), "upload", "network.unavailable"],
  ["a code newer than this module", new StorageApiError(SECRET, 400, "NewCode", "storage", "NewCode"), "upload", "unknown"],
  ["a bare 400", new StorageApiError(SECRET, 400, "400"), "createSignedUrl", "unknown"],
];

type ProviderCase = [label: string, error: ProviderError, ErrorCode];

// What interpret.ts throws for an answer that didn't end with a normal
// finish. Only the fields it reads are filled in; interpret.test.ts checks
// its handling of the SDKs' full types.
function interpreted(read: () => unknown): ProviderError {
  try {
    read();
  } catch (error) {
    if (error instanceof ProviderError) return error;
    throw error;
  }
  throw new Error("expected a ProviderError");
}

const billed = { input_tokens: 100, output_tokens: 10 };

function anthropicEnding(stopReason: string | null): ProviderError {
  const message = { model: "claude-haiku-4-5-20251001", content: [], stop_reason: stopReason, usage: billed };
  return interpreted(() => interpretAnthropicMessage(message as unknown as Anthropic.Message, 2048));
}

function openAIEnding(status: string, incompleteReason?: string): ProviderError {
  const response = {
    model: "gpt-5-nano-2025-08-07",
    status,
    output: [],
    output_text: "",
    incomplete_details: incompleteReason ? { reason: incompleteReason } : null,
    usage: billed,
  };
  return interpreted(() => interpretOpenAIResponse(response as unknown as OpenAI.Responses.Response, 2048));
}

const PROVIDER_CASES: ProviderCase[] = [
  ["timeout", new ProviderError("anthropic", "transport", PROVIDER_MESSAGES.timeout), "extraction.provider_timeout"],
  ["connection failed", new ProviderError("openai", "transport", "connection failed"), "extraction.provider_unavailable"],
  ["overloaded", new ProviderError("anthropic", "server", "Overloaded", 529), "extraction.provider_unavailable"],
  ["bad gateway", new ProviderError("openai", "server", "bad gateway", 502), "extraction.provider_unavailable"],
  ["rate limited", new ProviderError("openai", "client", "Rate limit reached", 429), "extraction.provider_unavailable"],
  ["bad key", new ProviderError("anthropic", "client", "invalid x-api-key", 401), "extraction.not_configured"],
  ["key without access", new ProviderError("openai", "client", "forbidden", 403), "extraction.not_configured"],
  ["unknown model", new ProviderError("anthropic", "client", "model: not found", 404), "extraction.not_configured"],
  ["unreadable PDF", new ProviderError("anthropic", "client", "Could not process PDF", 400), "extraction.provider_rejected"],
  ["request too large", new ProviderError("openai", "client", "Request too large", 413), "extraction.provider_rejected"],
  ["no status", new ProviderError("openai", "client", "the response carried no usage, so its cost is unknown"), "unknown"],
  ["refusal", new ProviderError("anthropic", "refusal", "the model declined to process this document"), "extraction.refused"],
  ["incomplete for another reason", new ProviderError("openai", "refusal", "the response was incomplete (content_filter)"), "extraction.refused"],
  ["truncated", new ProviderError("openai", "truncated", "the answer exceeded the 2048 output token cap"), "extraction.truncated"],
  // endings interpret.ts fails closed on
  ...(["pause_turn", "stop_sequence", "tool_use", null] as const).map(
    (reason): ProviderCase => [`Anthropic stop reason ${reason}`, anthropicEnding(reason), "extraction.answer_incomplete"],
  ),
  ["Anthropic context window", anthropicEnding("model_context_window_exceeded"), "extraction.truncated"],
  ["Anthropic refusal", anthropicEnding("refusal"), "extraction.refused"],
  ["Anthropic output cap", anthropicEnding("max_tokens"), "extraction.truncated"],
  ["OpenAI response failed", openAIEnding("failed"), "extraction.provider_unavailable"],
  ...(["cancelled", "queued", "in_progress"] as const).map(
    (status): ProviderCase => [`OpenAI response ${status}`, openAIEnding(status), "extraction.answer_incomplete"],
  ),
  ["OpenAI content filter", openAIEnding("incomplete", "content_filter"), "extraction.refused"],
  ["OpenAI output cap", openAIEnding("incomplete", "max_output_tokens"), "extraction.truncated"],
];

// Strings in the shapes the Extract action and the reaper store. The
// orchestrator's own strings are produced live below instead.
const RUN_STRING_CASES: [label: string, error: string | null, ErrorCode][] = [
  ["download failed", "could not download the file: Object not found", "extraction.download_failed"],
  ["download returned nothing", "could not download the file: no data", "extraction.download_failed"],
  ["close refused, closed as failed", "the result could not be recorded: 22023", "extraction.result_not_saved"],
  ["magic bytes", "file content (unrecognized) does not match its declared type (application/pdf)", "extraction.file_type_mismatch"],
  ["magic bytes, other type", "file content (image/png) does not match its declared type (image/jpeg)", "extraction.file_type_mismatch"],
  ["no key", describeError(new Error("extraction is not configured: ANTHROPIC_API_KEY is not set")), "extraction.not_configured"],
  ["bad provider setting", describeError(new Error(`${PROVIDER_ENV_VAR} must be "anthropic" or "openai"`)), "extraction.not_configured"],
  ["bad Anthropic model setting", describeError(new Error(`${ANTHROPIC_MODEL_ENV_VAR} must be one of claude-haiku-4-5-20251001, claude-sonnet-5`)), "extraction.not_configured"],
  ["no key, unwrapped", "extraction is not configured: OPENAI_API_KEY is not set", "extraction.not_configured"],
  ["reaped", `abandoned: still running after ${EXTRACTION_LIMITS.staleRunMinutes} minutes; failed by a later open`, "extraction.abandoned"],
  [
    "reaped by the queue's sweep, at the estimate",
    "cost estimated at claude-sonnet-5 prices (abandoned; at most 3 calls of 7500 tokens in and 2048 out, for 1 page): abandoned: claimed but not finished within 300 seconds",
    "extraction.abandoned",
  ],
  ["expired before any claim", `expired: not claimed within ${EXTRACTION_LIMITS.staleRunMinutes} minutes; cancelled at no cost`, "extraction.expired"],
  ["both failed", "anthropic transport: request timed out; fallback openai server 503: Service Unavailable", "extraction.all_providers_failed"],
  ["both failed, fallback refused", "openai server 502: bad gateway; fallback anthropic refusal: the model declined to process this document", "extraction.all_providers_failed"],
  // One provider's error that merely mentions another is one failure.
  ["one error naming another provider", "anthropic client 400: bad request; see openai server status", "extraction.provider_rejected"],
  ["one error quoting the fallback shape loosely", "anthropic server 503: upstream says openai transport: down", "extraction.provider_unavailable"],
  ["two providers, not in run.ts's shape", "both providers failed (openai client 400: bad request / anthropic transport: connection failed)", "unknown"],
  ["no fallback after a timeout", "anthropic transport: request timed out; no fallback provider is configured", "extraction.provider_timeout"],
  ["no fallback after a 5xx", "openai server 503: Service Unavailable; no fallback provider is configured", "extraction.provider_unavailable"],
  ["an unexpected stop", "anthropic client: the answer stopped unexpectedly (pause_turn)", "extraction.answer_incomplete"],
  ["an OpenAI response that failed", "openai server: the response did not complete (failed)", "extraction.provider_unavailable"],
  ["an OpenAI response cancelled", "openai client: the response did not complete (cancelled)", "extraction.answer_incomplete"],
  ["cut off at the context window", "anthropic truncated: the answer was cut off at the model's context window", "extraction.truncated"],
  ["an exception from the action", describeError(new TypeError(SECRET)), "unknown"],
  ["empty", "", "unknown"],
  ["blank", "   ", "unknown"],
  ["null", null, "unknown"],
  ["anything else", SECRET, "unknown"],
];

// What the real orchestrator stores for each way a provider can fail, run
// with fakes. If run.ts changes what it writes, these fail.
type RunCase = {
  label: string;
  primary: (ProviderResponse | ProviderError)[];
  fallback?: (ProviderResponse | ProviderError)[];
  // what run.ts stores, where the exact text matters
  stored?: string | RegExp;
  expected: ErrorCode;
};

const notJson = (text = "this is not JSON"): ProviderResponse => ({
  text,
  inputTokens: 100,
  outputTokens: 10,
  model: "claude-haiku-4-5-20251001",
});

// An answer whose unexpected keys impersonate provider errors. The
// validation error quotes keys, and a document can steer the model into
// writing them, so they must not decide the message.
const spoofed = notJson(
  JSON.stringify({
    "openai server 503: spoofed": 1,
    "anthropic refusal: spoofed": 2,
    ") failed: openai client 401: spoofed": 3,
  }),
);

const RUN_CASES: RunCase[] = [
  {
    label: "timeout, no fallback",
    primary: [new ProviderError("anthropic", "transport", PROVIDER_MESSAGES.timeout)],
    stored: "anthropic transport: request timed out; no fallback provider is configured",
    expected: "extraction.provider_timeout",
  },
  { label: "connection failed, no fallback", primary: [new ProviderError("anthropic", "transport", "connection failed")], expected: "extraction.provider_unavailable" },
  {
    label: "5xx, no fallback",
    primary: [new ProviderError("openai", "server", "Service Unavailable", 503)],
    stored: "openai server 503: Service Unavailable; no fallback provider is configured",
    expected: "extraction.provider_unavailable",
  },
  {
    label: "primary times out, fallback 5xx",
    primary: [new ProviderError("anthropic", "transport", PROVIDER_MESSAGES.timeout)],
    fallback: [new ProviderError("openai", "server", "Service Unavailable", 503)],
    stored: "anthropic transport: request timed out; fallback openai server 503: Service Unavailable",
    expected: "extraction.all_providers_failed",
  },
  {
    label: "primary 5xx, fallback refuses",
    primary: [new ProviderError("anthropic", "server", "Overloaded", 529)],
    fallback: [openAIEnding("incomplete", "content_filter")],
    stored: /^anthropic server 529: Overloaded; fallback openai refusal: /,
    expected: "extraction.all_providers_failed",
  },
  {
    // after the fallback answers, a failed retry is that one failure alone
    label: "primary times out, fallback answers invalid, its retry 5xx",
    primary: [new ProviderError("anthropic", "transport", PROVIDER_MESSAGES.timeout)],
    fallback: [notJson(), new ProviderError("openai", "server", "Service Unavailable", 503)],
    stored: /^retry after invalid response \([\s\S]*\) failed: openai server 503: Service Unavailable$/,
    expected: "extraction.provider_unavailable",
  },
  {
    label: "an unexpected stop reason",
    primary: [anthropicEnding("pause_turn")],
    fallback: [],
    stored: "anthropic client: the answer stopped unexpectedly (pause_turn)",
    expected: "extraction.answer_incomplete",
  },
  {
    label: "an OpenAI response that failed",
    primary: [openAIEnding("failed")],
    fallback: [],
    stored: "openai server: the response did not complete (failed)",
    expected: "extraction.provider_unavailable",
  },
  {
    label: "an OpenAI response cancelled",
    primary: [openAIEnding("cancelled")],
    fallback: [],
    stored: "openai client: the response did not complete (cancelled)",
    expected: "extraction.answer_incomplete",
  },
  {
    label: "cut off at the context window",
    primary: [anthropicEnding("model_context_window_exceeded")],
    fallback: [],
    stored: "anthropic truncated: the answer was cut off at the model's context window",
    expected: "extraction.truncated",
  },
  { label: "400 does not fall back", primary: [new ProviderError("anthropic", "client", "Could not process PDF", 400)], fallback: [], expected: "extraction.provider_rejected" },
  { label: "bad key", primary: [new ProviderError("anthropic", "client", "invalid x-api-key", 401)], expected: "extraction.not_configured" },
  { label: "429", primary: [new ProviderError("openai", "client", "Rate limit reached", 429)], expected: "extraction.provider_unavailable" },
  { label: "refusal", primary: [new ProviderError("anthropic", "refusal", "the model declined to process this document")], expected: "extraction.refused" },
  { label: "truncated", primary: [new ProviderError("openai", "truncated", "the answer exceeded the 2048 output token cap")], expected: "extraction.truncated" },
  { label: "invalid twice", primary: [notJson(), notJson()], expected: "extraction.invalid_answer" },
  { label: "invalid twice, keys impersonating provider errors", primary: [spoofed, spoofed], expected: "extraction.invalid_answer" },
  { label: "invalid, then the retry times out", primary: [notJson(), new ProviderError("anthropic", "transport", PROVIDER_MESSAGES.timeout)], expected: "extraction.provider_timeout" },
  { label: "impersonating keys, then the retry times out", primary: [spoofed, new ProviderError("anthropic", "transport", PROVIDER_MESSAGES.timeout)], expected: "extraction.provider_timeout" },
  { label: "invalid, then the retry is refused", primary: [notJson(), new ProviderError("anthropic", "refusal", "declined")], expected: "extraction.refused" },
];

async function storedError(primary: (ProviderResponse | ProviderError)[], fallback?: (ProviderResponse | ProviderError)[]) {
  const outcome = await runExtraction({
    bytes: new TextEncoder().encode("%PDF-1.4 fake"),
    mimeType: "application/pdf",
    filename: "fake.pdf",
    primary: fakeProvider("anthropic", "claude-haiku-4-5-20251001", primary),
    fallback: fallback ? fakeProvider("openai", "gpt-5-nano", fallback) : null,
  });
  if (outcome.status !== "failed") throw new Error("expected the fake run to fail");
  return outcome.error;
}

type CheckCase = [label: string, actual: () => ErrorCode | null, expected: ErrorCode | null];

const CHECK_CASES: CheckCase[] = [
  ["empty email", () => checkCredentials("", "x".repeat(20), "sign_up"), "auth.credentials_required"],
  ["blank email", () => checkCredentials("   ", "x".repeat(20), "sign_in"), "auth.credentials_required"],
  ["empty password", () => checkCredentials("a@example.com", "", "sign_in"), "auth.credentials_required"],
  ["one short of the minimum", () => checkCredentials("a@example.com", "x".repeat(MIN_PASSWORD_LENGTH - 1), "sign_up"), "auth.password_too_short"],
  ["the minimum", () => checkCredentials("a@example.com", "x".repeat(MIN_PASSWORD_LENGTH), "sign_up"), null],
  ["short is fine for signing in", () => checkCredentials("a@example.com", "short", "sign_in"), null],
  ["72 ASCII bytes", () => checkCredentials("a@example.com", "x".repeat(MAX_PASSWORD_BYTES), "sign_up"), null],
  ["73 ASCII bytes", () => checkCredentials("a@example.com", "x".repeat(MAX_PASSWORD_BYTES + 1), "sign_up"), "auth.password_too_long"],
  ["36 accented letters are 72 bytes", () => checkCredentials("a@example.com", "é".repeat(36), "sign_up"), null],
  ["37 accented letters are 74 bytes", () => checkCredentials("a@example.com", "é".repeat(37), "sign_up"), "auth.password_too_long"],
  ["19 emoji: 38 in the form's count, 76 bytes", () => checkCredentials("a@example.com", "😀".repeat(19), "sign_up"), "auth.password_too_long"],
  ["one page", () => checkPageCount(1), null],
  ["exactly the page limit", () => checkPageCount(EXTRACTION_LIMITS.maxPagesPerDocument), null],
  ["one page over the limit", () => checkPageCount(EXTRACTION_LIMITS.maxPagesPerDocument + 1), "document.too_many_pages"],
  ["pages that can't be counted", () => checkPageCount(null), "document.pages_unreadable"],
  ["organization ok", () => checkTenantInput("Acme", "acme-1"), null],
  ["organization name blank", () => checkTenantInput("  ", "acme"), "tenant.name_required"],
  ["slug too short", () => checkTenantInput("Acme", "ab"), "tenant.slug_invalid"],
  ["slug at 48", () => checkTenantInput("Acme", "a".repeat(48)), null],
  ["slug at 49", () => checkTenantInput("Acme", "a".repeat(49)), "tenant.slug_invalid"],
  ["slug with capitals", () => checkTenantInput("Acme", "Acme"), "tenant.slug_invalid"],
  ["slug with a space", () => checkTenantInput("Acme", "ac me"), "tenant.slug_invalid"],
  ["filename ok", () => checkFilename("invoice (1).pdf"), null],
  ["filename empty", () => checkFilename(""), "document.filename_invalid"],
  ["filename blank", () => checkFilename("   "), "document.filename_invalid"],
  ["filename at the limit", () => checkFilename("a".repeat(MAX_FILENAME_LENGTH)), null],
  ["filename over the limit", () => checkFilename("a".repeat(MAX_FILENAME_LENGTH + 1)), "document.filename_invalid"],
  ["filename of emoji at the limit, counted as Postgres does", () => checkFilename("😀".repeat(MAX_FILENAME_LENGTH)), null],
  ["filename of emoji over the limit", () => checkFilename("😀".repeat(MAX_FILENAME_LENGTH + 1)), "document.filename_invalid"],
  ["filename with a newline", () => checkFilename("a\nb.pdf"), "document.filename_invalid"],
  ["filename with a tab", () => checkFilename("a\tb.pdf"), "document.filename_invalid"],
  ["filename with DEL", () => checkFilename("ab.pdf"), "document.filename_invalid"],
  ["filename with a C1 control", () => checkFilename("ab.pdf"), "document.filename_invalid"],
  ["no file", () => checkUploadFile(null), "upload.no_file"],
  ["text file", () => checkUploadFile({ type: "text/plain", size: 10 }), "upload.file_type_not_allowed"],
  ["no declared type", () => checkUploadFile({ type: "", size: 10 }), "upload.file_type_not_allowed"],
  ["PDF at the limit", () => checkUploadFile({ type: "application/pdf", size: MAX_UPLOAD_BYTES }), null],
  ["JPEG over the limit", () => checkUploadFile({ type: "image/jpeg", size: MAX_UPLOAD_BYTES + 1 }), "upload.file_too_large"],
  ["PNG", () => checkUploadFile({ type: "image/png", size: 1 }), null],
];

const THROWN_CASES: [label: string, error: unknown, ErrorCode][] = [
  ["Chrome", new TypeError("Failed to fetch"), "network.unavailable"],
  ["Firefox", new TypeError("NetworkError when attempting to fetch resource."), "network.unavailable"],
  ["Safari", new TypeError("Load failed"), "network.unavailable"],
  ["Node", new TypeError("fetch failed"), "network.unavailable"],
  ["older Safari, lost", new TypeError("The network connection was lost."), "network.unavailable"],
  ["older Safari, offline", new TypeError("The Internet connection appears to be offline."), "network.unavailable"],
  // bugs whose messages merely contain a network word
  ["a bug naming fetch", new TypeError("fetchDocuments is not a function"), "unknown"],
  ["a bug naming the network", new TypeError("network is undefined"), "unknown"],
  ["a failed chunk import", new TypeError("Failed to fetch dynamically imported module: /_next/x.js"), "unknown"],
  ["the right words from the wrong class", new Error("Failed to fetch"), "unknown"],
  ["aborted", new DOMException("The operation was aborted.", "AbortError"), "network.unavailable"],
  ["timed out", new DOMException("The operation timed out.", "TimeoutError"), "network.unavailable"],
  ["a bug", new TypeError("Cannot read properties of undefined (reading 'id')"), "unknown"],
  ["a server error", new Error("An unexpected response was received from the server."), "unknown"],
  ["a string", SECRET, "unknown"],
  ["null", null, "unknown"],
];

// Codes no classifier returns, because only the page knows them: the
// database answers these with zero rows or a status, not an error.
const SET_BY_THE_PAGE: ErrorCode[] = ["membership.own_role", "membership.owner_only", "upload.incomplete"];

// The catalog ---------------------------------------------------------------

// Words a user shouldn't have to know. The UI says "organization", never
// "tenant", and never names the vendors behind the extraction service.
const JARGON =
  /\b(supabase|postgres(ql)?|postgrest|sql|sqlstate|rls|row-level|jwt|rpc|api|http|json|bucket|storage|constraint|schema|tenants?|providers?|models?|anthropic|openai|claude|gpt|haiku|sonnet|tokens?|stack|exception|errcode)\b/i;
const SQLSTATE_LIKE = /\b(?:\d[0-9A-Z]{4}|[A-Z]\d{4}|PGRST\d{3})\b/;

describe("the catalog", () => {
  it("has unique, dotted codes, with unknown as the only undotted one", () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
    expect(ERROR_CODES).toContain("unknown");
    for (const code of ERROR_CODES) {
      if (code !== "unknown") expect(code, code).toMatch(/^[a-z]+\.[a-z_]+$/);
    }
  });

  it.each(ERROR_CODES)("%s has a short, plain message that leaks nothing", (code) => {
    const { message, retryable } = ERROR_CATALOG[code];
    expect(typeof retryable).toBe("boolean");
    expect(message.trim()).toBe(message);
    expect(message.length).toBeGreaterThan(10);
    expect(message.length).toBeLessThanOrEqual(200);
    expect(message).toMatch(/^[A-Z]/);
    expect(message).toMatch(/\.$/);
    // one or two sentences
    const sentences = message.match(/[.!?](?=\s|$)/g) ?? [];
    expect(sentences.length).toBeGreaterThanOrEqual(1);
    expect(sentences.length).toBeLessThanOrEqual(2);
    expect(message).not.toMatch(SQLSTATE_LIKE);
    expect(message).not.toMatch(/\b(null|undefined|NaN|true|false)\b|\[object/);
    expect(message).not.toMatch(JARGON);
    // no template or format leftovers, nothing that would break the ERRORS.md table
    expect(message).not.toMatch(/[${}%|<>`]|\s{2}/);
  });

  it.each(ERROR_CODES)("%s says 'try again' exactly when retrying can help", (code) => {
    const { message, retryable } = ERROR_CATALOG[code];
    expect(/try again/i.test(message), message).toBe(retryable);
  });

  it("quotes the limits it describes from their single sources", () => {
    expect(ERROR_CATALOG["auth.password_too_short"].message).toContain(String(MIN_PASSWORD_LENGTH));
    expect(ERROR_CATALOG["auth.password_too_long"].message).toContain(String(MAX_PASSWORD_BYTES));
    expect(ERROR_CATALOG["upload.file_too_large"].message).toContain(`${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
    expect(ERROR_CATALOG["document.filename_invalid"].message).toContain(String(MAX_FILENAME_LENGTH));
    expect(ERROR_CATALOG["extraction.rate_limited"].message).toContain(String(EXTRACTION_LIMITS.hourlyRunLimit));
    expect(ERROR_CATALOG["extraction.already_running"].message).toContain(`${EXTRACTION_LIMITS.staleRunMinutes} minutes`);
    expect(ERROR_CATALOG["extraction.record_failed"].message).toContain(`${EXTRACTION_LIMITS.staleRunMinutes} minutes`);
    expect(ERROR_CATALOG["extraction.expired"].message).toContain(`${EXTRACTION_LIMITS.staleRunMinutes} minutes`);
    expect(ERROR_CATALOG["tenant.delete_extraction_running"].message).toContain(`${EXTRACTION_LIMITS.staleRunMinutes + 1} minutes`);
  });

  it("can't be changed at runtime", () => {
    expect(Object.isFrozen(ERROR_CATALOG)).toBe(true);
    expect(Object.isFrozen(ERROR_CODES)).toBe(true);
    for (const code of ERROR_CODES) expect(Object.isFrozen(ERROR_CATALOG[code])).toBe(true);
  });

  it("accepts only its own codes from outside", () => {
    expect(isErrorCode("extraction.rate_limited")).toBe(true);
    expect(isErrorCode("unknown")).toBe(true);
    for (const value of ["constructor", "__proto__", "toString", "hasOwnProperty", "", "extraction", 42, null, undefined, {}]) {
      expect(isErrorCode(value), String(value)).toBe(false);
    }
    expect(userFacingError("constructor" as ErrorCode)).toEqual({ code: "unknown", ...ERROR_CATALOG.unknown });
    expect(userFacingError("upload.file_too_large")).toEqual({
      code: "upload.file_too_large",
      ...ERROR_CATALOG["upload.file_too_large"],
    });
  });

  it("gives every code a way to be reached", () => {
    const reached = new Set<ErrorCode>([
      ...DATABASE_CASES.map((c) => c[3]),
      ...AUTH_CASES.map((c) => c[3]),
      ...STORAGE_CASES.map((c) => c[3]),
      ...PROVIDER_CASES.map((c) => c[2]),
      ...RUN_STRING_CASES.map((c) => c[2]),
      ...RUN_CASES.map((c) => c.expected),
      ...CHECK_CASES.flatMap((c) => (c[2] === null ? [] : [c[2]])),
      ...THROWN_CASES.map((c) => c[2]),
      ...Object.values(RAISE_CODES),
      ...SET_BY_THE_PAGE,
    ]);
    expect(ERROR_CODES.filter((code) => !reached.has(code))).toEqual([]);
  });
});

describe("ERRORS.md", () => {
  const rows = read("ERRORS.md")
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => cells.length === 5 && /^`[a-z._]+`$/.test(cells[2]));

  it("has a row for every code, and no code the module doesn't have", () => {
    const codes = rows.map((cells) => cells[2].slice(1, -1));
    expect(codes.filter((code) => !isErrorCode(code))).toEqual([]);
    expect(ERROR_CODES.filter((code) => !codes.includes(code))).toEqual([]);
  });

  it("shows each code's message and retry exactly as the module does", () => {
    expect(rows.length).toBeGreaterThan(ERROR_CODES.length);
    for (const [failure, , codeCell, retry, message] of rows) {
      const info = ERROR_CATALOG[codeCell.slice(1, -1) as ErrorCode];
      expect(message, failure).toBe(info.message);
      expect(retry, failure).toBe(info.retryable ? "yes" : "no");
    }
  });
});

describe("the migrations", () => {
  it("has every RAISE readable, and counts a redefined function once", () => {
    if (parseFailure) throw parseFailure;
    expect(raises.length).toBeGreaterThan(20);
    // close_extraction_run is defined in two migrations; only the later body counts
    const close = (list: SqlRaise[]) => list.filter((r) => r.fn === "close_extraction_run");
    expect(close(parsed.all).length).toBeGreaterThan(close(raises).length);
    for (const fn of new Set(raises.map((r) => r.fn))) {
      expect(new Set(raises.filter((r) => r.fn === fn).map((r) => r.file)).size, String(fn)).toBe(1);
    }
  });

  it("has a reviewed code for every raise, and no stale entries", () => {
    const keys = raises.map(raiseKey);
    expect(keys.filter((key) => !(key in RAISE_CODES))).toEqual([]);
    expect(Object.keys(RAISE_CODES).filter((key) => !keys.includes(key))).toEqual([]);
  });

  it.each(raises.map((r): [string, SqlRaise] => [`${r.file}:${r.line} ${r.fn} ${r.sqlstate} "${r.message}"`, r]))(
    "%s maps to its reviewed code",
    (_label, r) => {
      const operations = FUNCTION_OPERATIONS[r.fn ?? ""];
      expect(operations, `no operation known for ${r.fn}; add it to FUNCTION_OPERATIONS`).toBeDefined();
      const expected = RAISE_CODES[raiseKey(r)];
      expect(expected).not.toBe("unknown");
      for (const operation of operations) {
        const error = pgError(r.sqlstate, render(r.message));
        expect(classifyDatabaseError(error, operation), operation).toBe(expected);
      }
    },
  );

  it("still raises every phrase the module matches on, in the live functions", () => {
    const messages = raises.map((r) => r.message);
    for (const [name, phrase] of Object.entries(DATABASE_PHRASES)) {
      expect(messages.some((message) => message.startsWith(phrase)), name).toBe(true);
    }
  });

  it("uses one SQLSTATE for two outcomes only where the module reads the phrase", () => {
    // If one of these functions gains a third message under one of these
    // SQLSTATEs, the phrases above won't cover it.
    const phrased: Record<string, string[]> = {
      "check_extraction_limits 53400": [DATABASE_PHRASES.tenantCeilingReached, DATABASE_PHRASES.globalCeilingReached],
      "enqueue_extraction_run 55000": [DATABASE_PHRASES.documentHasNoFile, DATABASE_PHRASES.extractionAlreadyRunning],
      "open_extraction_run 55000": [DATABASE_PHRASES.documentHasNoFile, DATABASE_PHRASES.extractionAlreadyRunning],
      "complete_document_upload 55000": [DATABASE_PHRASES.notWaitingForUpload, DATABASE_PHRASES.noFileUploaded],
      "delete_tenant 55000": [DATABASE_PHRASES.tenantExtractionInProgress, DATABASE_PHRASES.tenantFilesRemain],
    };
    for (const [key, phrases] of Object.entries(phrased)) {
      const [fn, sqlstate] = key.split(" ");
      const found = raises.filter((r) => r.fn === fn && r.sqlstate === sqlstate).map((r) => r.message);
      expect(found.length, key).toBe(phrases.length);
      for (const message of found) expect(phrases.some((p) => message.startsWith(p)), message).toBe(true);
    }
  });

  it("names the check constraints the module looks for", () => {
    expect(allSql).toContain(`add constraint ${CHECK_CONSTRAINTS.documentFilename}`);
    // tenants' checks are unnamed, so Postgres names them tenants_<column>_check
    const tenants = /create table public\.tenants \(([\s\S]*?)\n\);/.exec(allSql)?.[1] ?? "";
    expect(tenants).toMatch(/^\s*name\s+text\b[^\n]*\bcheck\b/m);
    expect(tenants).toMatch(/^\s*slug\s+text\b[^\n]*\bcheck\b/m);
    expect(CHECK_CONSTRAINTS.tenantName).toBe("tenants_name_check");
    expect(CHECK_CONSTRAINTS.tenantSlug).toBe("tenants_slug_check");
    expect(allSql).not.toMatch(/drop constraint (if exists )?tenants_(name|slug)_check/i);
  });

  it("still has the reaper's messages, in the live reap_extraction_run", () => {
    const reap = parsed.liveBodies.get("reap_extraction_run") ?? "";
    expect(reap).toContain(`'cost estimated at %s prices (abandoned; `);
    expect(reap).toContain(`): ${RUN_ERROR_MARKERS.abandoned}%s'`);
    expect(reap).toContain(`'${RUN_ERROR_MARKERS.expired}%s'`);
  });

  it("enforces the rules the local checks mirror", () => {
    expect(allSql).toContain(`slug ~ '${SLUG_PATTERN.source}'`);
    expect(allSql).toMatch(new RegExp(`length\\(filename\\) between 1 and ${MAX_FILENAME_LENGTH}\\b`));
    expect(allSql).toContain("filename !~ '[[:cntrl:]]'");

    const size = [...allSql.matchAll(/file_size_limit\s*=\s*([\d\s*]+),/g)].at(-1)?.[1] ?? "";
    expect(size.split("*").reduce((product, n) => product * Number(n.trim()), 1)).toBe(MAX_UPLOAD_BYTES);

    const types = [...allSql.matchAll(/allowed_mime_types\s*=\s*array\[([^\]]*)\]/g)].at(-1)?.[1] ?? "";
    expect(types.split(",").map((t) => t.trim().replace(/'/g, "")).sort()).toEqual([...UPLOAD_MIME_TYPES].sort());
  });
});

describe("the sources that write run errors", () => {
  it("still write the markers the module reads", () => {
    const action = read("src/app/app/extract-action.ts");
    expect(action).toContain(RUN_ERROR_MARKERS.downloadFailed);
    expect(action).toContain(RUN_ERROR_MARKERS.typeMismatch);
    expect(action).toContain("does not match its declared type");

    const run = read("src/lib/extraction/run.ts");
    expect(run).toContain(RUN_ERROR_MARKERS.invalidAfterRetry);
    expect(run).toContain(RUN_ERROR_MARKERS.retryFailed);
    expect(run).toContain(RUN_ERROR_MARKERS.retryFailedSeparator);
    expect(run).toContain(RUN_ERROR_MARKERS.fallbackFailed);
    expect(run).toContain(RUN_ERROR_MARKERS.noFallback);
    // failedCloseAttempts writes it through the constant
    expect(run).toContain("RUN_ERROR_MARKERS.resultNotRecorded");
    expect(run).toContain("RUN_ERROR_MARKERS.costEstimated");

    const select = read("src/lib/extraction/providers/select.ts");
    expect(select).toContain(RUN_ERROR_MARKERS.notConfigured);
    expect(select).toContain("${PROVIDER_ENV_VAR} must be");
    expect(select).toContain("${ANTHROPIC_MODEL_ENV_VAR} must be one of");
  });

  it("still start provider messages the way the module reads them", () => {
    const dir = "src/lib/extraction/providers";
    const sources = readdirSync(join(ROOT, dir))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => read(join(dir, name)));
    for (const [name, start] of Object.entries(PROVIDER_MESSAGES)) {
      // quoted: as a whole string, or as the start of a template literal
      expect(sources.some((source) => source.includes(`"${start}"`) || source.includes(`\`${start}`)), name).toBe(true);
    }
  });
});

// The classifiers -------------------------------------------------------------

describe("classifyDatabaseError", () => {
  it.each(DATABASE_CASES)("%s", (_label, error, operation, expected) => {
    expect(classifyDatabaseError(error, operation)).toBe(expected);
  });
});

describe("classifyAuthError", () => {
  it.each(AUTH_CASES)("%s", (_label, error, operation, expected) => {
    expect(classifyAuthError(error, operation)).toBe(expected);
  });
});

describe("classifyStorageError", () => {
  it.each(STORAGE_CASES)("%s", (_label, error, operation, expected) => {
    expect(classifyStorageError(error, operation)).toBe(expected);
  });
});

describe("classifyProviderError", () => {
  it.each(PROVIDER_CASES)("%s", (_label, error, expected) => {
    expect(classifyProviderError(error)).toBe(expected);
  });

  it("classifies the stored form of each the same way", () => {
    for (const [label, error, expected] of PROVIDER_CASES) {
      expect(classifyRunError(describeError(error)), label).toBe(expected);
    }
  });
});

describe("classifyRunError", () => {
  it.each(RUN_STRING_CASES)("%s", (_label, error, expected) => {
    expect(classifyRunError(error)).toBe(expected);
  });

  it.each(RUN_CASES)("what the orchestrator stores: $label", async ({ primary, fallback, stored, expected }) => {
    const error = await storedError(primary, fallback);
    if (typeof stored === "string") expect(error).toBe(stored);
    else if (stored) expect(error).toMatch(stored);
    expect(classifyRunError(error)).toBe(expected);
  });
});

describe("the local checks", () => {
  it.each(CHECK_CASES)("%s", (_label, actual, expected) => {
    expect(actual()).toBe(expected);
  });
});

describe("classifyThrown", () => {
  it.each(THROWN_CASES)("%s", (_label, error, expected) => {
    expect(classifyThrown(error)).toBe(expected);
  });
});

// No echo ---------------------------------------------------------------------

describe("what the user sees", () => {
  const garbage: unknown[] = [null, undefined, 0, 42, "", SECRET, [], [SECRET], {}, { code: 42 }, { message: SECRET }, new Error(SECRET)];

  it("is always a catalog message, never the input's text", () => {
    const inputs: [string, unknown][] = [
      ...DATABASE_CASES.map((c): [string, unknown] => [c[0], c[1]]),
      ...AUTH_CASES.map((c): [string, unknown] => [c[0], c[1]]),
      ...STORAGE_CASES.map((c): [string, unknown] => [c[0], c[1]]),
      ...PROVIDER_CASES.map((c): [string, unknown] => [c[0], c[1]]),
    ];
    const messages = new Set(Object.values(ERROR_CATALOG).map((info) => info.message));
    for (const [label, input] of inputs) {
      const raw = (input as { message?: string }).message ?? "";
      const codes = [
        classifyDatabaseError(input as never, "select"),
        classifyAuthError(input as never, "signInWithPassword"),
        classifyStorageError(input as never, "upload"),
        classifyProviderError(input as never),
        classifyThrown(input),
      ];
      for (const code of codes) {
        const shown = userFacingError(code);
        expect(messages.has(shown.message), label).toBe(true);
        if (raw.length > 12) expect(JSON.stringify(shown), label).not.toContain(raw);
      }
    }
  });

  it("is unknown for input nobody anticipated, and never contains it", () => {
    const secretParts = ["sk-ant-api03", "7c9e6679", "<script>", "orders"];
    for (const input of garbage) {
      const codes = [
        classifyDatabaseError(input as never, "open_extraction_run"),
        classifyAuthError(input as never, "signUp"),
        classifyStorageError(input as never, "createSignedUrl"),
        classifyProviderError(input as never),
        classifyRunError(input as never),
        classifyThrown(input),
      ];
      for (const code of codes) {
        expect(isErrorCode(code)).toBe(true);
        expect(code, JSON.stringify(input)).toBe("unknown");
        const shown = JSON.stringify(userFacingError(code));
        for (const part of secretParts) expect(shown).not.toContain(part);
      }
    }
  });

  it("never throws on input that throws when it is read, and is unknown when every read does", () => {
    const fail = () => {
      throw new Error(SECRET);
    };
    const fields = ["code", "message", "name", "status", "statusCode", "kind", "reasons"];
    const classifyAll = (input: unknown) => [
      classifyDatabaseError(input as never, "open_extraction_run"),
      classifyAuthError(input as never, "signUp"),
      classifyStorageError(input as never, "upload"),
      classifyProviderError(input as never),
      classifyRunError(input as never),
      classifyThrown(input),
    ];

    // one field throws, the rest are plausible: whatever comes back is a code
    for (const key of fields) {
      const input = { code: "42501", name: "TypeError", kind: "client", status: 400, message: "Failed to fetch" };
      Object.defineProperty(input, key, { get: fail });
      for (const code of classifyAll(input)) expect(isErrorCode(code), key).toBe(true);
    }

    // every read throws
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const everyGetter = Object.defineProperties({}, Object.fromEntries(fields.map((key) => [key, { get: fail }])));
    for (const input of [everyGetter, new Proxy({}, { get: fail }), revoked.proxy]) {
      expect(classifyAll(input)).toEqual(Array(6).fill("unknown"));
    }

    // weak_password reasons that can't be read
    const weakWith = (reasons: unknown) => Object.assign(new AuthApiError("weak", 422, "weak_password"), { reasons });
    expect(classifyAuthError(weakWith(new Proxy([], { get: fail })), "signUp")).toBe("unknown");
    // not an array, so not taken as reasons: the message that states every rule
    expect(classifyAuthError(weakWith({ [Symbol.iterator]: fail }), "signUp")).toBe("auth.password_weak");
  });

  it("is unknown for a provider error of a kind that doesn't exist", () => {
    expect(classifyProviderError({ kind: "meltdown" as never, status: 500 })).toBe("unknown");
    expect(classifyRunError("anthropic meltdown 500: boom")).toBe("unknown");
  });
});
