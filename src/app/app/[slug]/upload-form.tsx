"use client";

import { useRef, useState } from "react";
import { buttonClass, errorClass, fileInputClass, labelClass } from "@/app/ui";
import { useOperations } from "./operations";

// Same limits as the bucket. Checked here only so an obviously bad file
// doesn't leave behind an 'uploading' row; the bucket is what enforces it.
const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_TYPES = ["application/pdf", "image/png", "image/jpeg"];

export function UploadForm({ tenantId }: { tenantId: string }) {
  const { upload } = useOperations();
  const fileInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
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
      const result = await upload(tenantId, file, () => {});
      if (!result.ok) {
        if (result.step === 1) setError(result.message);
        else if (result.step === 2) setError(`Upload failed: ${result.message}`);
        else setError(`Couldn't finish the upload: ${result.message}`);
        return;
      }
      form.reset();
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
          className={fileInputClass}
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
