"use client";

import { useRouter } from "next/navigation";
import { useMemo } from "react";
import { createDocument, deleteDocument } from "@/app/app/actions";
import { extractDocument } from "@/app/app/extract-action";
import { createClient } from "@/lib/supabase/client";
import { type DocumentOperations, OperationsProvider, type UploadResult } from "./operations";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// The real operations. Upload is row first: the row via a Server Action
// (no bytes), then the bytes from the browser with the user's session, then
// the RPC that confirms the object and reads its size and type.
export function LiveOperations({ children }: { children: React.ReactNode }) {
  const router = useRouter();

  const operations = useMemo<DocumentOperations>(
    () => ({
      async upload(tenantId, file, onStep): Promise<UploadResult> {
        // 1. the row, via a Server Action (no bytes)
        onStep(1);
        let created: Awaited<ReturnType<typeof createDocument>>;
        try {
          created = await createDocument({ tenantId, filename: file.name });
        } catch (error) {
          return { ok: false, step: 1, message: messageOf(error), network: true, rowCreated: false };
        }
        if (created.error !== undefined) {
          return { ok: false, step: 1, message: created.error, rowCreated: false };
        }

        // From here on the row exists. If a later step fails, refresh so the
        // unfinished entry shows in the list next to the error that explains
        // it; the error itself stays in the upload form's state.
        const supabase = createClient();

        // 2. the bytes, straight from the browser with the user's session.
        //    Storage only accepts this because the row above exists.
        //    cacheControl 0: Supabase's CDN would otherwise keep serving a
        //    deleted file for up to an hour.
        onStep(2);
        try {
          const upload = await supabase.storage.from("documents").upload(created.storagePath, file, {
            contentType: file.type,
            upsert: false,
            cacheControl: "0",
          });
          if (upload.error) {
            router.refresh();
            const { status, statusCode } = upload.error;
            const code = "code" in upload.error ? (upload.error.code as string | undefined) : undefined;
            return {
              ok: false,
              step: 2,
              message: upload.error.message,
              status: typeof status === "number" ? status : undefined,
              code: code ?? statusCode,
              network: status === undefined,
              rowCreated: true,
            };
          }
        } catch (error) {
          router.refresh();
          return { ok: false, step: 2, message: messageOf(error), network: true, rowCreated: true };
        }

        // 3. confirm: the database reads size and type from the stored object
        onStep(3);
        try {
          const done = await supabase.rpc("complete_document_upload", {
            p_document_id: created.id,
          });
          if (done.error) {
            router.refresh();
            return { ok: false, step: 3, message: done.error.message, code: done.error.code, rowCreated: true };
          }
        } catch (error) {
          router.refresh();
          return { ok: false, step: 3, message: messageOf(error), network: true, rowCreated: true };
        }

        router.refresh();
        return { ok: true };
      },

      extractAction: extractDocument,
      deleteAction: deleteDocument,

      // The signed URL is minted on click and used at once, so it never sits
      // in the page's HTML. It is a bearer token valid for 60 seconds.
      // Content-Disposition: attachment, so the browser saves the file and
      // stays on this page.
      async download(storagePath, filename) {
        try {
          const supabase = createClient();
          const { data, error } = await supabase.storage
            .from("documents")
            .createSignedUrl(storagePath, 60, { download: filename });
          if (error || !data) return { error: error?.message ?? "No download link was returned." };
          window.location.assign(data.signedUrl);
          return {};
        } catch (error) {
          return { error: messageOf(error) };
        }
      },
    }),
    [router],
  );

  return <OperationsProvider operations={operations}>{children}</OperationsProvider>;
}
