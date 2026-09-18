"use server";

import { revalidatePath } from "next/cache";
import type { FormState } from "@/app/form-state";
import { failureFields } from "@/app/log-fields";
import { requireUser } from "@/lib/auth";
import { classifyDatabaseError, classifyRunError, classifyStorageError } from "@/lib/errors";
import { selectProviders } from "@/lib/extraction/providers/select";
import { describeError } from "@/lib/extraction/providers/types";
import { runExtraction, toCloseParams, type RunOutcome } from "@/lib/extraction/run";
import { detectMimeType, isSupportedMimeType } from "@/lib/extraction/sniff";
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

// Admin clicks Extract. Everything that can refuse does so in the database
// before any model is called: open_extraction_run checks the caller is an
// admin, the document has a file and isn't already running, and the spend
// ceilings and the hourly limit. The run is then closed with whatever
// happened, in one transaction, so it never half-commits.
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

  // 1. open the run: limits are checked here, nothing is called yet
  const opened = await supabase.rpc("open_extraction_run", { p_document_id: doc.id });
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
    return await runAndClose({ supabase, doc, slug, runId, closeToken, runLog });
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
};

async function runAndClose({ supabase, doc, slug, runId, closeToken, runLog }: RunContext): Promise<FormState> {
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
    // 2. the bytes, with the caller's own session
    const downloaded = await supabase.storage.from("documents").download(doc.storage_path);
    if (downloaded.error || !downloaded.data) {
      // The code, not Storage's message: this text is stored on the run.
      const reason = downloaded.error ? classifyStorageError(downloaded.error, "download") : "no data";
      const status =
        downloaded.error && "status" in downloaded.error ? (downloaded.error.status as number | undefined) : undefined;
      runLog.warn("extraction.download_failed", {
        error_code: "extraction.download_failed",
        ...failureFields({ name: downloaded.error?.name }, status),
      });
      outcome = failed(`could not download the file: ${reason}`);
    } else {
      const bytes = new Uint8Array(await downloaded.data.arrayBuffer());
      // 3. the bytes must be what the row says they are
      const detected = detectMimeType(bytes);
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
    runLog.error("extraction.close_failed", {
      run_status: outcome.status,
      error_code: "extraction.record_failed",
      ...failureFields(closed.error, closed.status),
      ...usage,
    });
    return { error: classifyDatabaseError({ ...closed.error, status: closed.status }, "close_extraction_run") };
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
