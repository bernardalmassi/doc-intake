"use server";

import { revalidatePath } from "next/cache";
import type { FormState } from "@/app/form-state";
import { failureFields } from "@/app/log-fields";
import { requireUser } from "@/lib/auth";
import { checkPageCount, classifyDatabaseError, classifyStorageError } from "@/lib/errors";
import { countPages } from "@/lib/extraction/pages";
import { detectMimeType, isSupportedMimeType, type SupportedMimeType } from "@/lib/extraction/sniff";
import { log } from "@/lib/log";
import { createClient } from "@/lib/supabase/server";

type DocumentRow = {
  id: string;
  tenant_id: string;
  storage_path: string;
  mime_type: string | null;
};

// Admin clicks Extract. The file is downloaded first, with the caller's
// session, so its pages can be counted: a document over the page limit, or
// a PDF whose pages can't be counted, is refused here before anything is
// queued (SECURITY.md, "Stale runs"). Then enqueue_extraction_run
// (20260925000002) does everything that can refuse, in the database: the
// caller is an admin, the document has a file and isn't already extracting,
// and the spend ceilings (counting every run in flight at its estimate) and
// the hourly limit. It queues the run with the count and wakes the worker,
// which downloads the file again, checks its type and recounts its pages
// before any model call, and records the outcome
// (src/lib/extraction/worker.ts). Nothing here calls a model or holds a
// token, so the action returns at once; the page polls until the run ends.
//
// A file that fails to download here, or doesn't match its type, is still
// enqueued, with no count: the worker's preflight fails the run with no
// model call, and the run records why.
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

  // 1. the page count, from the bytes as the caller's own session reads them
  const file = await downloadFile(supabase, doc, runLog);
  let pageCount: number | null = null;
  if (file.ok && file.detected !== null && file.detected === doc.mime_type) {
    pageCount = await countPages(file.bytes, file.detected);
    const refused = checkPageCount(pageCount);
    if (refused) {
      runLog.warn("extraction.enqueue_refused", { error_code: refused, mime_type: file.detected, size_bytes: file.bytes.length });
      return { error: refused };
    }
  } else if (file.ok) {
    runLog.warn("extraction.type_mismatch", {
      mime_type: isSupportedMimeType(doc.mime_type) ? doc.mime_type : null,
      detected_mime_type: file.detected,
      size_bytes: file.bytes.length,
    });
  }

  // 2. queue it: every limit is checked there, nothing is called here
  const enqueued = await supabase.rpc("enqueue_extraction_run", { p_document_id: doc.id, p_page_count: pageCount });
  if (enqueued.error) {
    const code = classifyDatabaseError({ ...enqueued.error, status: enqueued.status }, "enqueue_extraction_run");
    runLog.warn("extraction.enqueue_refused", { error_code: code, ...failureFields(enqueued.error, enqueued.status) });
    return { error: code };
  }
  runLog.info("extraction.enqueued", { run_id: enqueued.data as string, page_count: pageCount });

  revalidatePath(`/app/${slug}`);
  return {};
}

// The document's bytes and their detected type, or why they couldn't be
// read.
type DownloadedFile = { ok: true; bytes: Uint8Array; detected: SupportedMimeType | null } | { ok: false };

async function downloadFile(
  supabase: Awaited<ReturnType<typeof createClient>>,
  doc: DocumentRow,
  runLog: typeof log,
): Promise<DownloadedFile> {
  try {
    const downloaded = await supabase.storage.from("documents").download(doc.storage_path);
    if (downloaded.error || !downloaded.data) {
      const status =
        downloaded.error && "status" in downloaded.error ? (downloaded.error.status as number | undefined) : undefined;
      runLog.warn("extraction.download_failed", {
        error_code: downloaded.error ? classifyStorageError(downloaded.error, "download") : "extraction.download_failed",
        ...failureFields({ name: downloaded.error?.name }, status),
      });
      return { ok: false };
    }
    const bytes = new Uint8Array(await downloaded.data.arrayBuffer());
    return { ok: true, bytes, detected: detectMimeType(bytes) };
  } catch (error) {
    runLog.warn("extraction.download_failed", {
      error_code: "extraction.download_failed",
      error_kind: "unexpected",
      error_name: error instanceof Error ? error.name : undefined,
    });
    return { ok: false };
  }
}
