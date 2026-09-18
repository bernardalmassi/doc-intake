"use server";

import { revalidatePath } from "next/cache";
import type { FormState } from "@/app/form-state";
import { failureFields } from "@/app/log-fields";
import { requireUser } from "@/lib/auth";
import { classifyDatabaseError, classifyRunError, classifyStorageError } from "@/lib/errors";
import { selectProviders } from "@/lib/extraction/providers/select";
import { describeError } from "@/lib/extraction/providers/types";
import { failedCloseAttempts, runExtraction, toCloseParams, type RunOutcome } from "@/lib/extraction/run";
import { countPages } from "@/lib/extraction/pages";
import { detectMimeType, isSupportedMimeType, type SupportedMimeType } from "@/lib/extraction/sniff";
import { log } from "@/lib/log";
import { registerSecret } from "@/lib/redact";
import { createClient } from "@/lib/supabase/server";

type DocumentRow = {
  id: string;
  tenant_id: string;
  filename: string;
  storage_path: string;
  status: string;
  mime_type: string | null;
};

// Admin clicks Extract. The file is downloaded first, with the caller's
// session, so its pages can be counted: open_extraction_run stores the count
// on the run, and the stale-run reaper charges an abandoned run from it
// (migration 20260918000003). Then everything that can refuse does so in the
// database before any model is called: open_extraction_run checks the
// caller is an admin, the document has a file and isn't already running,
// and the spend ceilings and the hourly limit. The run is then closed with
// whatever happened, in one transaction, so it never half-commits. If the database
// refuses that close, the run is closed again as failed with no fields, so
// the document goes back to how it was instead of sitting in processing
// until the stale-run reaper frees it.
//
// Every failure is returned as a code from src/lib/errors.ts. The text
// stored on a failed run is for engineers, and the page shows it only as
// classifyRunError's code, so what goes into it here is this file's own
// wording and codes, never Storage's message.
//
// Every step is logged with the user, organization, document and run ids,
// the code and the SQLSTATE or HTTP status, never a message. The close
// token is registered as a secret for as long as the request holds it, so
// no log line or stored error can contain it.
export async function extractDocument(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();

  const id = String(formData.get("id") ?? "");
  const slug = String(formData.get("slug") ?? "");
  // document_id is dropped from the line unless it's a UUID
  let runLog = log.with({ user_id: user.id, document_id: id });
  if (!id || !slug) {
    runLog.warn("extraction.open_refused", { error_code: "document.not_found" });
    return { error: "document.not_found" };
  }

  const supabase = await createClient();

  const lookup = await supabase
    .from("documents")
    .select("id, tenant_id, filename, storage_path, status, mime_type")
    .eq("id", id)
    .maybeSingle<DocumentRow>();
  if (lookup.error) {
    const code = classifyDatabaseError({ ...lookup.error, status: lookup.status }, "select_document");
    runLog.warn("extraction.open_refused", { error_code: code, ...failureFields(lookup.error, lookup.status) });
    return { error: code };
  }
  const doc = lookup.data;
  if (!doc) {
    runLog.warn("extraction.open_refused", { error_code: "document.not_found" });
    return { error: "document.not_found" };
  }
  runLog = runLog.with({ tenant_id: doc.tenant_id });

  // 1. the bytes, with the caller's own session, and their page count if
  //    they are what the row says they are (null otherwise: the database
  //    then charges an abandoned run as the most pages a document can have)
  const file = await downloadFile(supabase, doc, runLog);
  const pageCount =
    file.ok && file.detected !== null && file.detected === doc.mime_type ? countPages(file.bytes, file.detected) : null;

  // 2. open the run: limits are checked here, nothing is called yet
  const opened = await supabase.rpc("open_extraction_run", { p_document_id: doc.id, p_page_count: pageCount });
  if (opened.error) {
    const code = classifyDatabaseError({ ...opened.error, status: opened.status }, "open_extraction_run");
    runLog.warn("extraction.open_refused", { error_code: code, ...failureFields(opened.error, opened.status) });
    return { error: code };
  }
  const { run_id: runId, close_token: closeToken } = (opened.data as { run_id: string; close_token: string }[])[0];
  const releaseToken = registerSecret(closeToken);
  try {
    runLog = runLog.with({ run_id: runId });
    runLog.info("extraction.run_opened");
    return await runAndClose({ supabase, doc, slug, runId, closeToken, runLog, file });
  } finally {
    releaseToken();
  }
}

type RunContext = {
  supabase: Awaited<ReturnType<typeof createClient>>;
  doc: DocumentRow;
  slug: string;
  runId: string;
  closeToken: string;
  runLog: typeof log;
  file: DownloadedFile;
};

// The document's bytes and their detected type, or why they couldn't be
// read. The reason is a code, never Storage's message: it is stored on the
// run.
type DownloadedFile =
  | { ok: true; bytes: Uint8Array; detected: SupportedMimeType | null }
  | { ok: false; reason: string };

async function downloadFile(
  supabase: RunContext["supabase"],
  doc: DocumentRow,
  runLog: typeof log,
): Promise<DownloadedFile> {
  try {
    const downloaded = await supabase.storage.from("documents").download(doc.storage_path);
    if (downloaded.error || !downloaded.data) {
      const reason = downloaded.error ? classifyStorageError(downloaded.error, "download") : "no data";
      const status =
        downloaded.error && "status" in downloaded.error ? (downloaded.error.status as number | undefined) : undefined;
      runLog.warn("extraction.download_failed", {
        error_code: "extraction.download_failed",
        ...failureFields({ name: downloaded.error?.name }, status),
      });
      return { ok: false, reason };
    }
    const bytes = new Uint8Array(await downloaded.data.arrayBuffer());
    return { ok: true, bytes, detected: detectMimeType(bytes) };
  } catch (error) {
    runLog.warn("extraction.download_failed", {
      error_code: "extraction.download_failed",
      error_kind: "unexpected",
      error_name: error instanceof Error ? error.name : undefined,
    });
    return { ok: false, reason: "unknown" };
  }
}

async function runAndClose({ supabase, doc, slug, runId, closeToken, runLog, file }: RunContext): Promise<FormState> {
  const startedAt = Date.now();
  const failed = (error: string): RunOutcome => ({
    status: "failed",
    error,
    rawResponse: null,
    provider: null,
    model: null,
    attempts: 0,
    inputTokens: 0,
    outputTokens: 0,
    latencyMs: Date.now() - startedAt,
  });

  let outcome: RunOutcome;
  try {
    // 3. the bytes (downloaded before the open) must be what the row says
    if (!file.ok) {
      outcome = failed(`could not download the file: ${file.reason}`);
    } else {
      const { bytes, detected } = file;
      if (detected === null || !isSupportedMimeType(doc.mime_type) || detected !== doc.mime_type) {
        runLog.warn("extraction.type_mismatch", {
          mime_type: isSupportedMimeType(doc.mime_type) ? doc.mime_type : null,
          detected_mime_type: detected,
          size_bytes: bytes.length,
        });
        outcome = failed(
          `file content (${detected ?? "unrecognized"}) does not match its declared type (${doc.mime_type ?? "none"})`,
        );
      } else {
        // 4. the model calls, which log under the same ids
        const providers = selectProviders();
        outcome = await runExtraction({
          bytes,
          mimeType: detected,
          filename: doc.filename,
          primary: providers.primary,
          fallback: providers.fallback,
          logContext: { run_id: runId, document_id: doc.id, tenant_id: doc.tenant_id },
        });
      }
    }
  } catch (error) {
    runLog.error("extraction.unexpected_error", {
      error_kind: "unexpected",
      error_name: error instanceof Error ? error.name : undefined,
    });
    outcome = failed(describeError(error));
  }

  const usage = {
    provider: outcome.provider,
    model: outcome.model,
    attempts: outcome.attempts,
    input_tokens: outcome.inputTokens,
    output_tokens: outcome.outputTokens,
    latency_ms: outcome.latencyMs,
  };

  // 5. close the run: usage, cost (computed there), status and fields in
  //    one transaction
  const closed = await supabase.rpc("close_extraction_run", toCloseParams(runId, closeToken, outcome));
  if (closed.error) {
    const failure = failureFields(closed.error, closed.status);
    runLog.error("extraction.close_failed", {
      retry: 0,
      run_status: outcome.status,
      error_code: "extraction.record_failed",
      ...failure,
      ...usage,
    });
    return closeAsFailed({ supabase, slug, runId, closeToken, runLog }, outcome, failure.db_code ?? null);
  }

  revalidatePath(`/app/${slug}`);

  if (outcome.status === "failed") {
    const code = classifyRunError(outcome.error);
    runLog.warn("extraction.run_closed", { run_status: "failed", error_code: code, ...usage });
    return { error: code };
  }
  runLog.info("extraction.run_closed", {
    run_status: "succeeded",
    document_status: outcome.documentStatus,
    field_count: outcome.fields.length,
    ...usage,
  });
  return {
    message:
      outcome.documentStatus === "needs_review"
        ? "Extraction finished. Some fields need checking."
        : "Extraction finished.",
  };
}

// The database refused to record what happened. Close the run again as
// failed, as failedCloseAttempts plans it (src/lib/extraction/run.ts), so
// the document goes back to how it was. The code returned is what the page
// will show for the stored run: the run's own failure, or
// extraction.result_not_saved for a success that couldn't be recorded. Only
// when every close is refused does the run stay open for the reaper.
async function closeAsFailed(
  { supabase, slug, runId, closeToken, runLog }: Omit<RunContext, "doc" | "file">,
  outcome: RunOutcome,
  sqlState: string | null,
): Promise<FormState> {
  for (const [index, attempt] of failedCloseAttempts(outcome, sqlState).entries()) {
    const retry = index + 1;
    const closed = await supabase.rpc("close_extraction_run", toCloseParams(runId, closeToken, attempt));
    if (!closed.error) {
      const code = attempt.status === "failed" ? classifyRunError(attempt.error) : "unknown";
      runLog.warn("extraction.close_retried", {
        retry,
        run_status: "failed",
        error_code: code,
        model: attempt.model,
        input_tokens: attempt.inputTokens,
        output_tokens: attempt.outputTokens,
      });
      revalidatePath(`/app/${slug}`);
      return { error: code };
    }
    runLog.error("extraction.close_failed", {
      retry,
      run_status: "failed",
      error_code: "extraction.record_failed",
      ...failureFields(closed.error, closed.status),
    });
  }
  return { error: "extraction.record_failed" };
}
