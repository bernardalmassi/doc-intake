"use client";

import { useActionState, useState } from "react";
import {
  buttonClass,
  dangerButtonClass,
  errorClass,
  hintClass,
  secondaryButtonClass,
} from "@/app/ui";
import { useOperations } from "./operations";

type Props = {
  id: string;
  slug: string;
  filename: string;
  storagePath: string;
  status: string;
  uploaded: boolean;
  canDelete: boolean;
  canExtract: boolean;
};

export function DocumentActions({
  id,
  slug,
  filename,
  storagePath,
  status,
  uploaded,
  canDelete,
  canExtract,
}: Props) {
  const operations = useOperations();
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [deleteState, deleteAction, deleting] = useActionState(operations.deleteAction, {});
  const [extractState, extractAction, extracting] = useActionState(operations.extractAction, {});

  async function download() {
    setDownloadError(null);
    const result = await operations.download(storagePath, filename);
    if (result.error) setDownloadError(result.error);
  }

  const processing = status === "processing";
  const message = downloadError ?? deleteState.error ?? extractState.error ?? extractState.message;
  const isError = Boolean(downloadError ?? deleteState.error ?? extractState.error);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {uploaded && (
        <button type="button" onClick={download} className={secondaryButtonClass}>
          Download
        </button>
      )}
      {canExtract && uploaded && (
        <form action={extractAction}>
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="slug" value={slug} />
          <button
            type="submit"
            disabled={extracting || processing}
            title={processing ? "An extraction is running" : undefined}
            className={buttonClass}
          >
            {extracting || processing ? "Extracting…" : "Extract"}
          </button>
        </form>
      )}
      {canDelete && (
        <form action={deleteAction}>
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="slug" value={slug} />
          <button type="submit" disabled={deleting} className={dangerButtonClass}>
            {deleting ? "Deleting…" : "Delete"}
          </button>
        </form>
      )}
      {message && (
        <span role={isError ? "alert" : "status"} className={isError ? errorClass : hintClass}>
          {message}
        </span>
      )}
    </div>
  );
}
