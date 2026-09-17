"use server";

import { revalidatePath } from "next/cache";
import type { FormState } from "@/app/auth/actions";
import { requireUser } from "@/lib/auth";
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
export async function extractDocument(_prev: FormState, formData: FormData): Promise<FormState> {
  await requireUser();

  const id = String(formData.get("id") ?? "");
  const slug = String(formData.get("slug") ?? "");
  if (!id || !slug) return { error: "Missing document." };

  const supabase = await createClient();

  const { data: doc, error: lookupError } = await supabase
    .from("documents")
    .select("id, filename, storage_path, status, mime_type")
    .eq("id", id)
    .maybeSingle<DocumentRow>();
  if (lookupError) return { error: lookupError.message };
  if (!doc) return { error: "Document not found." };

  // 1. open the run: limits are checked here, nothing is called yet
  const opened = await supabase.rpc("open_extraction_run", { p_document_id: doc.id });
  if (opened.error) return { error: describeOpenError(opened.error) };
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
      outcome = failed(`could not download the file: ${downloaded.error?.message ?? "no data"}`);
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
    return { error: `The run could not be recorded: ${closed.error.message}` };
  }

  revalidatePath(`/app/${slug}`);

  if (outcome.status === "failed") {
    return { error: `Extraction failed: ${outcome.error}` };
  }
  const review = outcome.fields.filter((f) => f.band === "low").length;
  const questions = outcome.fields.filter((f) => f.band === "medium").length;
  return {
    message:
      `Extracted ${outcome.fields.length} fields with ${outcome.provider}` +
      (questions ? `, ${questions} with a question` : "") +
      (review ? `, ${review} low confidence: sent to review` : "") +
      ".",
  };
}

function describeOpenError(error: { code?: string; message: string }): string {
  switch (error.code) {
    case "42501":
      return "Only admins can run extraction.";
    case "53400":
      // tenant or global monthly spend ceiling; the message says which
      return `Extraction is paused: ${error.message}.`;
    case "54000":
      return `Extraction is rate limited: ${error.message}.`;
    case "55000":
      return `Can't extract right now: ${error.message}.`;
    default:
      return error.message;
  }
}
