"use client";

import { useActionState, useEffect, useId, useRef, useState } from "react";
import type { FormState } from "@/app/auth/actions";
import {
  armedDangerButtonClass,
  buttonClass,
  dangerButtonClass,
  errorClass,
  linkClass,
  secondaryButtonClass,
  textTargetClass,
} from "@/app/ui";
import { AlertIcon, CheckIcon, SpinnerIcon } from "./icons";
import {
  CONNECTION_ERROR,
  DOCUMENTS_HEADING_ID,
  describeDeleteError,
  describeDownloadError,
  describeExtractResult,
  type Explained,
} from "./messages";
import { useOperations } from "./operations";

// first: never extracted. again: there are earlier runs. running: an
// extraction is in progress (the button is disabled and says so).
export type ExtractMode = "first" | "again" | "running";

type Props = {
  id: string;
  slug: string;
  filename: string;
  storagePath: string;
  // false while the upload never finished: there is no file yet
  canDownload: boolean;
  canDelete: boolean;
  // null: no Extract button (a member, or no file). primary: the accent
  // fill, for when extracting is this document's next step.
  extract: { mode: ExtractMode; primary: boolean } | null;
};

type Notice = (Explained & { tone: "progress" | "done" | "error" }) | null;

// The buttons never move. Labels that swap keep one width (min-w-28 fits
// Extract, Extract again and Extracting…; min-w-24 fits Delete, Yes, delete
// and Deleting…, measured in Geist at text-sm), and
// every message (progress, result, error, the delete confirmation) appears
// beside the buttons from sm up and below them on a phone, never before
// them.
export function DocumentActions({ id, slug, filename, storagePath, canDownload, canDelete, extract }: Props) {
  const operations = useOperations();
  const questionId = useId();
  // The message shown is the one for the last thing the user did.
  const [last, setLast] = useState<"extract" | "delete" | "download" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const downloading = useRef(false);
  const armedAt = useRef(0);
  const extractButton = useRef<HTMLButtonElement>(null);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);

  // A Server Action that throws (offline) would otherwise reach the error
  // boundary and replace the page; it becomes an ordinary error instead.
  const [extractState, extractAction, extracting] = useActionState<FormState, FormData>(async (prev, formData) => {
    try {
      return await operations.extractAction(prev, formData);
    } catch {
      return { error: CONNECTION_ERROR };
    }
  }, {});

  const [deleteState, deleteAction, deleting] = useActionState<FormState, FormData>(async (prev, formData) => {
    try {
      const result = await operations.deleteAction(prev, formData);
      if (!result.error) {
        // The refreshed list no longer has this item, and focus would fall
        // to the top of the page. Move it to the list first, and say what
        // happened where it will still be heard.
        operations.announce(`Deleted ${filename}.`);
        document.getElementById(DOCUMENTS_HEADING_ID)?.focus();
      }
      return result;
    } catch {
      return { error: CONNECTION_ERROR };
    }
  }, {});

  // A disabled button loses focus. When the action is over and focus fell
  // to the page, put it back on the button that started it.
  const wasBusy = useRef({ extracting: false, deleting: false });
  useEffect(() => {
    const focusLost = document.activeElement === null || document.activeElement === document.body;
    if (wasBusy.current.extracting && !extracting && focusLost) extractButton.current?.focus();
    if (wasBusy.current.deleting && !deleting && focusLost) deleteButton.current?.focus();
    wasBusy.current = { extracting, deleting };
  }, [extracting, deleting]);

  const busy = extracting || deleting;

  async function download() {
    if (downloading.current) return;
    downloading.current = true;
    setLast("download");
    setConfirming(false);
    setDownloadError(null);
    const result = await operations.download(storagePath, filename);
    downloading.current = false;
    setDownloadError(result.error ?? null);
  }

  function cancelDelete() {
    setConfirming(false);
    deleteButton.current?.focus();
  }

  // First click arms, second click deletes. The second click must be a
  // separate, later click: a double-click on Delete doesn't confirm it.
  function onDeleteClick(event: React.MouseEvent<HTMLButtonElement>) {
    if (!confirming) {
      event.preventDefault();
      armedAt.current = event.timeStamp;
      setLast("delete");
      setConfirming(true);
      return;
    }
    if (event.timeStamp - armedAt.current < 500) event.preventDefault();
  }

  function onEscape(event: React.KeyboardEvent) {
    if (event.key === "Escape" && confirming) {
      event.preventDefault();
      cancelDelete();
    }
  }

  let notice: Notice = null;
  if (last === "extract") {
    const result = describeExtractResult(extractState);
    if (extracting) notice = { tone: "progress", text: "Extracting. This can take up to a minute." };
    else if (result) notice = { tone: result.ok ? "done" : "error", text: result.text, detail: result.detail };
  } else if (last === "delete") {
    if (deleting) notice = { tone: "progress", text: "Deleting…" };
    else if (deleteState.error) notice = { tone: "error", ...describeDeleteError(deleteState.error) };
  } else if (last === "download" && downloadError) {
    notice = { tone: "error", ...describeDownloadError(downloadError) };
  }

  if (!canDownload && !canDelete && !extract) return null;

  const extractLabel =
    extracting || extract?.mode === "running" ? "Extracting…" : extract?.mode === "again" ? "Extract again" : "Extract";

  return (
    <div className="mt-4 flex flex-wrap items-start gap-x-4 gap-y-2">
      <div className="flex flex-wrap gap-2">
        {extract && (
          <form
            action={extractAction}
            onSubmit={() => {
              setLast("extract");
              setConfirming(false);
            }}
          >
            <input type="hidden" name="id" value={id} />
            <input type="hidden" name="slug" value={slug} />
            <button
              ref={extractButton}
              type="submit"
              disabled={busy || extract.mode === "running"}
              className={`${extract.primary ? buttonClass : secondaryButtonClass} min-w-28`}
            >
              {extractLabel}
            </button>
          </form>
        )}
        {canDownload && (
          <button type="button" onClick={download} className={secondaryButtonClass}>
            Download
          </button>
        )}
        {canDelete && (
          <form action={deleteAction} onSubmit={() => setConfirming(false)}>
            <input type="hidden" name="id" value={id} />
            <input type="hidden" name="slug" value={slug} />
            <button
              ref={deleteButton}
              type="submit"
              disabled={busy}
              onClick={onDeleteClick}
              onKeyDown={onEscape}
              onBlur={(event) => {
                if (confirming && event.relatedTarget !== cancelButton.current) setConfirming(false);
              }}
              aria-describedby={confirming ? questionId : undefined}
              className={`${confirming ? armedDangerButtonClass : dangerButtonClass} min-w-24`}
            >
              {deleting ? "Deleting…" : confirming ? "Yes, delete" : "Delete"}
            </button>
          </form>
        )}
      </div>

      {/* basis-64: the message sits beside the buttons when there is room,
          below them when not, whatever it says. */}
      <div className="flex min-w-0 flex-1 basis-64 items-center text-sm sm:min-h-9">
        <div className="min-w-0 flex-1">
          {/* Two regions, always rendered so what appears in them is
              announced, and side by side rather than nested so nothing is
              announced twice: polite for the question, progress and
              results, alert for errors. The technical details stay outside
              both, to be opened, not read out. */}
          <div aria-live="polite">
            {confirming ? (
              <p>
                <span id={questionId}>
                  Delete this document and everything extracted from it? This can&apos;t be undone.
                </span>{" "}
                <button
                  ref={cancelButton}
                  type="button"
                  onClick={cancelDelete}
                  onKeyDown={onEscape}
                  onBlur={(event) => {
                    // Leaving the confirmation altogether disarms it too.
                    if (event.relatedTarget !== deleteButton.current) setConfirming(false);
                  }}
                  className={`${linkClass} ${textTargetClass}`}
                >
                  Cancel
                </button>
              </p>
            ) : (
              notice && notice.tone !== "error" && <NoticeLine notice={notice} />
            )}
          </div>
          <div role="alert">{!confirming && notice?.tone === "error" && <NoticeLine notice={notice} />}</div>
          {!confirming && notice?.tone === "error" && notice.detail && (
            <details className="mt-1 pl-5.5">
              <summary className={`w-fit cursor-pointer text-muted ${textTargetClass}`}>Technical details</summary>
              <p className="mt-1 text-muted [overflow-wrap:anywhere]">{notice.detail}</p>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}

function NoticeLine({ notice }: { notice: NonNullable<Notice> }) {
  if (notice.tone === "error") {
    return (
      <p className={`flex items-start gap-1.5 ${errorClass}`}>
        <AlertIcon className="mt-0.5" />
        <span className="min-w-0">{notice.text}</span>
      </p>
    );
  }
  return (
    <p className={`flex items-start gap-1.5 ${notice.tone === "progress" ? "text-muted" : "text-fg"}`}>
      {notice.tone === "progress" ? <SpinnerIcon className="mt-0.5" /> : <CheckIcon className="mt-0.5" />}
      <span className="min-w-0">{notice.text}</span>
    </p>
  );
}
