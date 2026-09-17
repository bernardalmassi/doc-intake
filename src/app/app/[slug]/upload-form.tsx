"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { createDocument } from "@/app/app/actions";
import { buttonClass, errorClass, inputClass, labelClass } from "@/app/ui";
import { createClient } from "@/lib/supabase/client";

// Same limits as the bucket. Checked here only so an obviously bad file
// doesn't leave behind an 'uploading' row; the bucket is what enforces it.
const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_TYPES = ["application/pdf", "image/png", "image/jpeg"];

export function UploadForm({ tenantId }: { tenantId: string }) {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const file = fileInput.current?.files?.[0];
    if (!file) return;

    if (!ALLOWED_TYPES.includes(file.type)) {
      setError("Only PDF, PNG and JPEG files are accepted.");
      return;
    }
    if (file.size > MAX_BYTES) {
      setError("Files must be 10 MB or smaller.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      // 1. the row, via a Server Action (no bytes)
      const created = await createDocument({ tenantId, filename: file.name });
      if (created.error !== undefined) {
        setError(created.error);
        return;
      }

      // 2. the bytes, straight from the browser with the user's session.
      //    Storage only accepts this because the row above exists.
      //    cacheControl 0: Supabase's CDN would otherwise keep serving a
      //    deleted file for up to an hour.
      const supabase = createClient();
      const upload = await supabase.storage.from("documents").upload(created.storagePath, file, {
        contentType: file.type,
        upsert: false,
        cacheControl: "0",
      });
      if (upload.error) {
        setError(`Upload failed: ${upload.error.message}`);
        return;
      }

      // 3. confirm: the database reads size and type from the stored object
      const done = await supabase.rpc("complete_document_upload", {
        p_document_id: created.id,
      });
      if (done.error) {
        setError(`Couldn't finish the upload: ${done.error.message}`);
        return;
      }

      event.currentTarget?.reset();
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-3 space-y-3">
      <div>
        <label htmlFor="file" className={labelClass}>
          PDF, PNG or JPEG, up to 10 MB
        </label>
        <input
          id="file"
          name="file"
          type="file"
          ref={fileInput}
          required
          accept={ALLOWED_TYPES.join(",")}
          className={`${inputClass} file:mr-3 file:rounded file:border-0 file:bg-neutral-700 file:px-2 file:py-1 file:text-neutral-100`}
        />
      </div>
      <p aria-live="polite" className="min-h-5 text-sm">
        {error && (
          <span role="alert" className={errorClass}>
            {error}
          </span>
        )}
      </p>
      <button type="submit" disabled={busy} className={buttonClass}>
        {busy ? "Uploading…" : "Upload"}
      </button>
    </form>
  );
}
