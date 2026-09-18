# Error messages

Every failure a user can hit, the code `src/lib/errors.ts` gives it, and the message the user sees. `tests/unit/errors.test.ts` fails if this table and the module disagree, if a `raise` in `supabase/migrations/` has no code, or if a phrase the module matches on disappears from the SQL.

## Rules

- A user only ever sees the Message column, looked up by code with `userFacingError(code)`. No classifier returns text, so nothing that Postgres, Supabase Auth, Storage, a model provider or a document produced can reach the page through this module.
- Anything not listed maps to `unknown`, whose message is generic. Its input is never echoed.
- Where the database deliberately gives one answer for two cases (a document that doesn't exist and one you can't see; a slug that doesn't exist and an organization you aren't in), the message covers both, so the UI can't be used to probe either.
- Classification goes by code (SQLSTATE, Auth code, Storage code, ProviderError kind) and by what was attempted. Message text is read only where one SQLSTATE covers two outcomes, and then only as the exact phrase a migration raises.
- Retry is "yes" when repeating the same action unchanged can succeed, possibly after the wait the message names. Every "yes" message says "try again" and no "no" message does.

## Using it

- A PostgREST query or RPC result: `classifyDatabaseError(error, operation)`, where `operation` is the RPC or table write that failed.
- `supabase.auth.*`: `classifyAuthError(error, method)`.
- `supabase.storage.*`: `classifyStorageError(error, method)`.
- `extraction_runs.error`, or the Extract action's `outcome.error`: `classifyRunError(text)`.
- An exception thrown around a Server Action call: `classifyThrown(error)`.
- Before submitting a form: `checkCredentials`, `checkTenantInput`, `checkFilename`, `checkUploadFile`.
- An update or delete that RLS filters to zero rows returns no error at all; the call site picks the code ("zero rows" below).
- A Server Action returns the code; the page renders `userFacingError(code).message`. A code arriving in a URL is checked with `isErrorCode` first.

## Signing up, signing in and the session

| Failure | Detected by | Code | Retry | Message |
|---|---|---|---|---|
| Email or password left empty | `checkCredentials`; `AuthInvalidCredentialsError` | `auth.credentials_required` | no | Enter your email address and password. |
| Password shorter than the minimum | `checkCredentials`; Auth `weak_password` with only reason `length` | `auth.password_too_short` | no | Your password must be at least 15 characters long. |
| Password longer than 72 bytes (bcrypt's limit) | `checkCredentials` (counts UTF-8 bytes); Auth `validation_failed` saying "longer than 72 characters" | `auth.password_too_long` | no | Your password is too long. Use at most 72 characters; accented letters and emoji count as two or more. |
| Password lacks required character types (only if the project requires them) | Auth `weak_password` with only reason `characters` | `auth.password_missing_characters` | no | Your password doesn't use the required kinds of characters. Mix lowercase and uppercase letters, digits and symbols. |
| Password appears in a breach (needs leaked password protection, off today) | Auth `weak_password` with only reason `pwned` | `auth.password_breached` | no | This password has appeared in a known data breach. Choose a different one. |
| Password breaks several rules, or a rule this module doesn't know | Auth `weak_password` with other reasons, or none | `auth.password_weak` | no | This password isn't strong enough. Use at least 15 characters with a mix of letters, digits and symbols, and don't reuse a password from another site. |
| Email already registered (Supabase reveals this only while email confirmation is off) | Auth `user_already_exists`, `email_exists` | `auth.email_taken` | no | An account with this email address already exists. Sign in instead. |
| Email address malformed | Auth `email_address_invalid`; `validation_failed` about the email | `auth.email_invalid` | no | That email address isn't valid. Check it for typos. |
| Supabase's built-in mailer won't send to the address | Auth `email_address_not_authorized` | `auth.email_not_allowed` | no | We can't send email to that address. Sign up with a different email address. |
| Sign-ups turned off | Auth `signup_disabled`; `email_provider_disabled` or `provider_disabled` on sign-up | `auth.signup_disabled` | no | New accounts can't be created right now. |
| Email sign-in turned off | Auth `email_provider_disabled` or `provider_disabled` on sign-in | `auth.sign_in_disabled` | no | Signing in with an email address is turned off right now. |
| Too many sign-up, sign-in or confirmation attempts | Auth `over_request_rate_limit`, or HTTP 429 | `auth.rate_limited` | yes | Too many attempts in a short time. Wait a few minutes, then try again. |
| Too many confirmation emails sent | Auth `over_email_send_rate_limit` | `auth.email_rate_limited` | yes | We can't send another email right now. Wait a while, then try again. |
| Wrong password, or an email with no account (not told apart) | Auth `invalid_credentials`; `user_not_found` on sign-in | `auth.invalid_credentials` | no | The email address or password is incorrect. |
| Email not confirmed yet | Auth `email_not_confirmed` | `auth.email_not_confirmed` | no | Your email address isn't confirmed yet. Open the confirmation link we emailed you, then sign in. |
| Account banned | Auth `user_banned` | `auth.account_suspended` | no | This account has been suspended. |
| Confirmation link without a code, expired, already used, or opened in another browser than the one that signed up | `/auth/confirm` without `code`; any `exchangeCodeForSession` error except network and rate limit | `auth.confirmation_link_invalid` | no | This confirmation link is invalid, has expired, or was opened in a different browser from the one you signed up in. Sign in, or sign up again to get a new link. |
| Not signed in | `requireUser()`; `AuthSessionMissingError`; Auth `no_authorization`; an RPC's "authentication required" (42501, or P0001 from `create_tenant`); 42501 calling `create_tenant` anonymously | `auth.not_signed_in` | no | You're not signed in. Sign in to continue. |
| Session expired or revoked | PostgREST `PGRST301` to `PGRST303` or HTTP 401; Auth `session_not_found`, `refresh_token_not_found`, `invalid_jwt` and the like; `user_not_found` outside sign-in; Storage `InvalidJWT` or 401 | `auth.session_expired` | no | Your session has expired. Sign in again to continue. |
| Other sign-up or sign-in input the server rejects | Auth `validation_failed` | `input.invalid` | no | Some of the information you entered isn't valid. Correct it and submit the form again. |

## Organizations and accounts

| Failure | Detected by | Code | Retry | Message |
|---|---|---|---|---|
| Organization name blank | `checkTenantInput`; 23514 on `tenants_name_check` | `tenant.name_required` | no | Enter a name for the organization. |
| Slug doesn't match `^[a-z0-9-]{3,48}$` | `checkTenantInput`; 23514 on `tenants_slug_check` | `tenant.slug_invalid` | no | The slug must be 3 to 48 characters long and use only lowercase letters, digits and hyphens. |
| Slug already used, including by an organization the user can't see | 23505 from `create_tenant` or a tenants update | `tenant.slug_taken` | no | That slug is already in use. Choose a different one. |
| Organization page for a slug that doesn't exist, or that the user isn't a member of | no row (RLS hides it); 22P02 from `delete_tenant` | `tenant.not_found` | no | We couldn't find that organization, or you don't have access to it. |
| A non-admin renames the organization or changes its slug | zero rows; 42501 | `tenant.update_not_allowed` | no | Only an admin can change this organization's name or slug. |
| A non-owner deletes the organization | 42501 from `delete_tenant` | `tenant.delete_not_owner` | no | Only an owner can delete this organization. |
| Deleting an organization whose documents still have files | 55000 from `delete_tenant` | `tenant.delete_has_files` | no | This organization still has documents with files. Delete them first, then delete the organization. |
| Deleting your account while you own an organization | 55000 from `delete_own_account` | `account.delete_owns_organization` | no | You still own an organization. Delete it, or make another member an owner and have them remove you, before deleting your account. |

## Members and roles

| Failure | Detected by | Code | Retry | Message |
|---|---|---|---|---|
| A non-admin adds, changes or removes a member, or an owner rule below reaches the database | 42501 on memberships insert or role update; zero rows on update or delete | `membership.not_allowed` | no | You don't have permission to make this change to the organization's members. |
| Changing your own role | the page, before the call (the database answers with zero rows) | `membership.own_role` | no | You can't change your own role. Ask another admin or owner to do it. |
| A non-owner grants, changes or removes the owner role | the page, before the call (the database answers with 42501 or zero rows) | `membership.owner_only` | no | Only an owner can make someone an owner, or change or remove an owner. |
| Removing or demoting the last owner | 23514 from the `memberships_keep_an_owner` trigger | `membership.last_owner` | no | An organization must always have at least one owner. Make someone else an owner first, or delete the organization. |
| Adding someone who is already a member | 23505 on memberships insert | `membership.already_member` | no | That person is already a member of this organization. |
| Adding a user id that has no account | 23503 on memberships insert | `membership.user_not_found` | no | There is no account for that person. |
| A role that isn't owner, admin or member | 22P02 | `input.invalid` | no | Some of the information you entered isn't valid. Correct it and submit the form again. |

## Uploading

| Failure | Detected by | Code | Retry | Message |
|---|---|---|---|---|
| No file chosen | `checkUploadFile` | `upload.no_file` | no | Choose a file to upload. |
| Not a PDF, PNG or JPEG | `checkUploadFile` (declared type); Storage `InvalidMimeType` or 415 | `upload.file_type_not_allowed` | no | Only PDF, PNG and JPEG files can be uploaded. |
| Larger than the bucket allows | `checkUploadFile`; Storage `EntityTooLarge` or 413 | `upload.file_too_large` | no | Files must be 10 MB or smaller. |
| File name empty, blank, too long or with control characters | `checkFilename`; 23514 on `documents_filename_check` | `document.filename_invalid` | no | File names must be 1 to 255 characters, not only spaces, with no line breaks, tabs or other control characters. |
| Row insert refused: not a member, or no longer one | 42501 on documents insert (RLS); 22P02 or 23503 on `tenant_id` | `upload.not_allowed` | no | This upload was refused. You may no longer be a member of this organization, or the upload was cancelled. |
| Storage refuses the bytes: no matching row, not the uploader, row no longer `uploading`, or no longer a member | Storage `AccessDenied` or 403 on `upload` | `upload.not_allowed` | no | This upload was refused. You may no longer be a member of this organization, or the upload was cancelled. |
| Completion refused: row missing, not the uploader, or no longer a member (one answer on purpose) | 42501 from `complete_document_upload` | `upload.not_allowed` | no | This upload was refused. You may no longer be a member of this organization, or the upload was cancelled. |
| A file is already stored at the row's path, or the upload was already completed | Storage `Duplicate`, `KeyAlreadyExists` or 409; 55000 "document is not waiting for an upload" | `upload.already_uploaded` | no | This file has already been uploaded. Refresh the page to see it. |
| Completion finds no file | 55000 "no file has been uploaded for this document" | `upload.file_missing` | yes | The file didn't finish uploading. Please try again. |
| Upload never completed (tab closed, network lost, file refused), so the row stays `uploading` | the document's status | `upload.incomplete` | no | This upload never finished, so there is no file to open. Upload the file again; an admin can remove this entry. |

## Documents

| Failure | Detected by | Code | Retry | Message |
|---|---|---|---|---|
| Document id missing, malformed, deleted, or in an organization the user can't see | no row; 22P02; `PGRST116`; Storage 404 on `remove` | `document.not_found` | no | This document doesn't exist, or you don't have access to it. |
| Rename breaks the file name rules | `checkFilename`; 23514 on `documents_filename_check` | `document.filename_invalid` | no | File names must be 1 to 255 characters, not only spaces, with no line breaks, tabs or other control characters. |
| Rename by someone who is neither the uploader nor an admin | zero rows; 42501 | `document.rename_not_allowed` | no | Only the person who uploaded a document, or an admin, can rename it. |
| Download of a file that is gone or no longer visible (not told apart) | Storage `NoSuchKey`, `AccessDenied`, 404 or 403 on `createSignedUrl` | `download.not_found` | no | This file isn't available. It may have been deleted, or you may no longer have access to it. |
| Download of an upload that never finished | the document's status | `upload.incomplete` | no | This upload never finished, so there is no file to open. Upload the file again; an admin can remove this entry. |
| Delete by a non-admin (Storage removes nothing and reports success; the row delete matches zero rows) | zero rows; 42501; Storage 403 on `remove` | `document.delete_not_allowed` | no | Only an admin can delete documents. |
| Row delete refused because the file is still there (it landed after the remove) | 55000 from the `documents_keep_row_while_file_exists` trigger | `document.file_still_present` | yes | The document's file couldn't be removed, so the document was kept. Please try again. |

## Extraction: starting a run

| Failure | Detected by | Code | Retry | Message |
|---|---|---|---|---|
| Document missing, or the caller isn't an admin of its organization (one answer on purpose) | 42501 from `open_extraction_run` | `extraction.not_allowed` | no | This document doesn't exist, or you aren't an admin of its organization. Only admins can run extraction. |
| Document still `uploading` | 55000 "the document has no file yet" | `extraction.no_file` | no | This document has no file yet. Finish uploading it before extracting. |
| A run for the document is already in progress and not yet stale | 55000 "an extraction is already running for this document" | `extraction.already_running` | yes | An extraction is already running for this document. Try again when it finishes; one that is stuck is released after 10 minutes. |
| The organization's monthly spend ceiling is reached | 53400 "this organization has reached its monthly extraction spend ceiling" | `extraction.tenant_budget_reached` | no | Your organization has used this month's extraction budget. Extraction resumes at the start of next month (UTC). |
| The monthly spend ceiling across all organizations is reached | 53400 "the monthly extraction spend ceiling across all organizations has been reached" | `extraction.global_budget_reached` | no | Extraction is paused for everyone because this month's overall budget has been used. It resumes at the start of next month (UTC). |
| The organization's hourly run limit is reached | 54000 from `open_extraction_run` | `extraction.rate_limited` | yes | Your organization has reached its limit of 5 extractions per hour. Try again later. |

## Extraction: how a run can fail

These come from the text stored in `extraction_runs.error` (and returned as the Extract action's `outcome.error`).

| Failure | Detected by | Code | Retry | Message |
|---|---|---|---|---|
| No key for the primary provider, or `EXTRACTION_PROVIDER` set to something else | starts "extraction is not configured" or "EXTRACTION_PROVIDER must be" | `extraction.not_configured` | no | Extraction isn't set up on this server. Ask whoever runs this service to configure it. |
| The provider rejects our key or model id | ProviderError `client` with 401, 403 or 404 | `extraction.not_configured` | no | Extraction isn't set up on this server. Ask whoever runs this service to configure it. |
| The file couldn't be downloaded with the user's session | starts "could not download the file" | `extraction.download_failed` | yes | The file couldn't be read for extraction. Please try again. |
| The bytes aren't the declared type (magic-byte check) | starts "file content (" | `extraction.file_type_mismatch` | no | This file's contents don't match its file type, so it wasn't sent for extraction. Upload it again as a genuine PDF, PNG or JPEG file. |
| A provider call timed out | ProviderError `transport` "request timed out" | `extraction.provider_timeout` | yes | The extraction service took too long to respond. Try again in a few minutes. |
| A provider is unreachable, answers 5xx, or rate limits us | ProviderError `transport` otherwise, `server`, or `client` with 429 | `extraction.provider_unavailable` | yes | The extraction service is unavailable or busy right now. Try again in a few minutes. |
| The primary and the fallback provider both failed | two different providers named in the error | `extraction.all_providers_failed` | yes | Both extraction services we use failed on this document. Try again in a few minutes. |
| A provider rejects the document (damaged, protected or too long) | ProviderError `client` with any other status | `extraction.provider_rejected` | no | The extraction service couldn't process this document. It may be damaged, password-protected or too long. |
| The model refused, or stopped for a reason other than the output cap | ProviderError `refusal` | `extraction.refused` | no | The extraction service declined to process this document. Review it yourself instead. |
| The answer hit the output token cap | ProviderError `truncated` | `extraction.truncated` | no | This document has more content than one extraction can return. Review it yourself instead. |
| The answer failed validation, and so did the retry | starts "response failed validation after" | `extraction.invalid_answer` | yes | The extraction service's answer failed our checks, even after a second attempt. You can try again or review the document yourself. |
| The answer failed validation and the retry call failed | starts "retry after invalid response (": the provider error after the last ") failed: " decides, as above; if it can't be read, this | `extraction.invalid_answer` | yes | The extraction service's answer failed our checks, even after a second attempt. You can try again or review the document yourself. |
| A run left `running` past the stale limit, failed by the next open | starts "abandoned: still running after" (the reaper in `open_extraction_run`) | `extraction.abandoned` | yes | This extraction stopped before it finished and was cancelled. Please try again. |
| An SDK error with no HTTP status (a bug, or a response without usage) | ProviderError `client` without a status | `unknown` | yes | Something went wrong. Please try again. |
| The outcome couldn't be recorded, so the document stays `processing` until the reaper frees it | any error from `close_extraction_run`, including a lost connection | `extraction.record_failed` | yes | The extraction ran, but its result couldn't be saved. You can try again in about 10 minutes. |

## Anywhere

| Failure | Detected by | Code | Retry | Message |
|---|---|---|---|---|
| No response from Supabase (offline, DNS, aborted) | PostgREST `code: ""`; `AuthRetryableFetchError` with status 0; `StorageUnknownError`; a thrown fetch `TypeError` or `AbortError` | `network.unavailable` | yes | We couldn't reach the server. Check your internet connection and try again. |
| Supabase or the database temporarily unavailable | HTTP 5xx or 429; `PGRST000` to `PGRST003`; 40001, 40P01, 53000, 53200, 53300, 55P03, 57014, 57P01 to 57P03, class 08; Storage `DatabaseTimeout`, `SlowDown` and similar; Auth 5xx | `service.unavailable` | yes | The service is temporarily unavailable. Please try again in a minute. |
| Input no check above names (a malformed id, a missing value, an unnamed check) | 22P02, 23502, 23514, 22001, 22023 | `input.invalid` | no | Some of the information you entered isn't valid. Correct it and submit the form again. |
| Anything else | everything not above | `unknown` | yes | Something went wrong. Please try again. |
