"use client";

import { useActionState, useState } from "react";
import { deleteDocument } from "@/app/app/actions";
import { dangerButtonClass, errorClass, secondaryButtonClass } from "@/app/ui";
import { createClient } from "@/lib/supabase/client";

type Props = {
  id: string;
  slug: string;
  filename: string;
  storagePath: string;
  uploaded: boolean;
  canDelete: boolean;
};

export function DocumentActions({ id, slug, filename, storagePath, uploaded, canDelete }: Props) {
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [deleteState, deleteAction, deleting] = useActionState(deleteDocument, {});

  // The signed URL is minted on click and used at once, so it never sits in
  // the page's HTML. It is a bearer token valid for 60 seconds.
  async function download() {
    setDownloadError(null);
    const supabase = createClient();
    const { data, error } = await supabase.storage
      .from("documents")
      .createSignedUrl(storagePath, 60, { download: filename });
    if (error || !data) {
      setDownloadError(error?.message ?? "Couldn't create a download link.");
      return;
    }
    // Content-Disposition: attachment, so the browser saves the file and
    // stays on this page.
    window.location.assign(data.signedUrl);
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={download}
        disabled={!uploaded}
        title={uploaded ? undefined : "This upload hasn't finished"}
        className={secondaryButtonClass}
      >
        Download
      </button>
      {canDelete && (
        <form action={deleteAction}>
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="slug" value={slug} />
          <button type="submit" disabled={deleting} className={dangerButtonClass}>
            {deleting ? "Deleting…" : "Delete"}
          </button>
        </form>
      )}
      {(downloadError || deleteState.error) && (
        <span role="alert" className={errorClass}>
          {downloadError ?? deleteState.error}
        </span>
      )}
    </div>
  );
}
