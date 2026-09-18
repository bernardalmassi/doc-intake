"use server";

import { revalidatePath } from "next/cache";
import type { FormState } from "@/app/form-state";
import { requireUser } from "@/lib/auth";
import { classifyDatabaseError, classifyRunError, classifyStorageError } from "@/lib/errors";
import { selectProviders } from "@/lib/extraction/providers/select";
import { describeError } from "@/lib/extraction/providers/types";
import { runExtraction, toCloseParams, type RunOutcome } from "@/lib/extraction/run";
import { detectMimeType, isSupportedMimeType } from "@/lib/extraction/sniff";
import { createClient } from "@/lib/supabase/server";

type DocumentRow = {
  id: string;
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
export async function extractDocument(_prev: FormState, formData: FormData): Promise<FormState> {
  await requireUser();

  const id = String(formData.get("id") ?? "");
  const slug = String(formData.get("slug") ?? "");
  if (!id || !slug) return { error: "document.not_found" };

  const supabase = await createClient();

  const lookup = await supabase
    .from("documents")
    .select("id, filename, storage_path, status, mime_type")
    .eq("id", id)
    .maybeSingle<DocumentRow>();
  if (lookup.error) return { error: classifyDatabaseError({ ...lookup.error, status: lookup.status }, "select_document") };
  const doc = lookup.data;
  if (!doc) return { error: "document.not_found" };

  // 1. open the run: limits are checked here, nothing is called yet
  const opened = await supabase.rpc("open_extraction_run", { p_document_id: doc.id });
  if (opened.error) {
    return { error: classifyDatabaseError({ ...opened.error, status: opened.status }, "open_extraction_run") };
  }
  const { run_id: runId, close_token: closeToken } = (opened.data as { run_id: string; close_token: string }[])[0];

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
      outcome = failed(`could not download the file: ${reason}`);
    } else {
      const bytes = new Uint8Array(await downloaded.data.arrayBuffer());
      // 3. the bytes must be what the row says they are
      const detected = detectMimeType(bytes);
      if (detected === null || !isSupportedMimeType(doc.mime_type) || detected !== doc.mime_type) {
        outcome = failed(
          `file content (${detected ?? "unrecognized"}) does not match its declared type (${doc.mime_type ?? "none"})`,
        );
      } else {
        // 4. the model calls
        const providers = selectProviders();
        outcome = await runExtraction({
          bytes,
          mimeType: detected,
          filename: doc.filename,
          primary: providers.primary,
          fallback: providers.fallback,
        });
      }
    }
  } catch (error) {
    outcome = failed(describeError(error));
  }

  // 5. close the run: usage, cost (computed there), status and fields in
  //    one transaction
  const closed = await supabase.rpc("close_extraction_run", toCloseParams(runId, closeToken, outcome));
  if (closed.error) {
    return { error: classifyDatabaseError({ ...closed.error, status: closed.status }, "close_extraction_run") };
  }

  revalidatePath(`/app/${slug}`);

  if (outcome.status === "failed") return { error: classifyRunError(outcome.error) };
  return {
    message:
      outcome.documentStatus === "needs_review"
        ? "Extraction finished. Some fields need checking."
        : "Extraction finished.",
  };
}
