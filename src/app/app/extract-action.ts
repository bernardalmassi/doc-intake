"use server";

import { revalidatePath } from "next/cache";
import type { FormState } from "@/app/form-state";
import { failureFields } from "@/app/log-fields";
import { requireUser } from "@/lib/auth";
import { classifyDatabaseError, classifyStorageError } from "@/lib/errors";
import { checkFileForExtraction, type FileForExtraction } from "@/lib/extraction/extract-check";
import { log } from "@/lib/log";
import { createClient } from "@/lib/supabase/server";

type DocumentRow = {
  id: string;
  tenant_id: string;
  storage_path: string;
  mime_type: string | null;
};

// Admin clicks Extract. The file is downloaded first, with the caller's
// session, and checked the way the worker's preflight will check it
// (checkFileForExtraction, src/lib/extraction/extract-check.ts): a file that
// can't be downloaded, bytes that aren't the declared type, a PDF with no
// pages, over the page limit, or whose pages can't be counted gets its error
// here, and no run is queued, since the worker would only fail it
// (SECURITY.md, "Stale runs"). Then enqueue_extraction_run (20260925000002)
// does everything that can refuse, in the database: the caller is an admin,
// the document has a file and isn't already extracting, and the spend
// ceilings (counting every run in flight at its estimate) and the hourly
// limit. It queues the run with the page count and wakes the worker, which
// downloads the file again, checks its type and recounts its pages before
// any model call, and records the outcome (src/lib/extraction/worker.ts).
// Nothing here calls a model or holds a token, so the action returns at
// once; the page polls until the run ends.
//
// Every failure is returned as a code from src/lib/errors.ts. Every step is
// logged with the user, organization, document and run ids, the code and the
// SQLSTATE or HTTP status, never a message.
export async function extractDocument(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();

  const id = String(formData.get("id") ?? "");
  const slug = String(formData.get("slug") ?? "");
  // document_id is dropped from the line unless it's a UUID
  let runLog = log.with({ user_id: user.id, document_id: id });
  if (!id || !slug) {
    runLog.warn("extraction.enqueue_refused", { error_code: "document.not_found" });
    return { error: "document.not_found" };
  }

  const supabase = await createClient();

  const lookup = await supabase
    .from("documents")
    .select("id, tenant_id, storage_path, mime_type")
    .eq("id", id)
    .maybeSingle<DocumentRow>();
  if (lookup.error) {
    const code = classifyDatabaseError({ ...lookup.error, status: lookup.status }, "select_document");
    runLog.warn("extraction.enqueue_refused", { error_code: code, ...failureFields(lookup.error, lookup.status) });
    return { error: code };
  }
  const doc = lookup.data;
  if (!doc) {
    runLog.warn("extraction.enqueue_refused", { error_code: "document.not_found" });
    return { error: "document.not_found" };
  }
  runLog = runLog.with({ tenant_id: doc.tenant_id });

  // 1. the file, as the caller's own session reads it, checked as the
  //    worker will check it: a run bound to fail is never queued
  const checked = await checkFileForExtraction(await downloadFile(supabase, doc, runLog), doc.mime_type);
  if (!checked.ok) {
    runLog.warn("extraction.enqueue_refused", checked.log);
    return { error: checked.error };
  }

  // 2. queue it: every limit is checked there, nothing is called here
  const enqueued = await supabase.rpc("enqueue_extraction_run", { p_document_id: doc.id, p_page_count: checked.pageCount });
  if (enqueued.error) {
    const code = classifyDatabaseError({ ...enqueued.error, status: enqueued.status }, "enqueue_extraction_run");
    runLog.warn("extraction.enqueue_refused", { error_code: code, ...failureFields(enqueued.error, enqueued.status) });
    return { error: code };
  }
  runLog.info("extraction.enqueued", { run_id: enqueued.data as string, page_count: checked.pageCount });

  revalidatePath(`/app/${slug}`);
  return {};
}

// The document's bytes, or the code for why they couldn't be read.
async function downloadFile(
  supabase: Awaited<ReturnType<typeof createClient>>,
  doc: DocumentRow,
  runLog: typeof log,
): Promise<FileForExtraction> {
  try {
    const downloaded = await supabase.storage.from("documents").download(doc.storage_path);
    if (downloaded.error || !downloaded.data) {
      const status =
        downloaded.error && "status" in downloaded.error ? (downloaded.error.status as number | undefined) : undefined;
      const error = downloaded.error ? classifyStorageError(downloaded.error, "download") : "extraction.download_failed";
      runLog.warn("extraction.download_failed", {
        error_code: error,
        ...failureFields({ name: downloaded.error?.name }, status),
      });
      return { ok: false, error };
    }
    return { ok: true, bytes: new Uint8Array(await downloaded.data.arrayBuffer()) };
  } catch (error) {
    runLog.warn("extraction.download_failed", {
      error_code: "extraction.download_failed",
      error_kind: "unexpected",
      error_name: error instanceof Error ? error.name : undefined,
    });
    return { ok: false, error: "extraction.download_failed" };
  }
}
