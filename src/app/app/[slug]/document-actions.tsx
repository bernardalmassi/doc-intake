"use client";

import { useActionState, useEffect, useId, useRef, useState } from "react";
import type { FormState } from "@/app/form-state";
import {
  armedDangerButtonClass,
  buttonClass,
  dangerButtonClass,
  errorClass,
  errorInkRuleClass,
  linkClass,
  secondaryButtonClass,
  textTargetClass,
} from "@/app/ui";
import { classifyThrown, type ErrorCode, userFacingError } from "@/lib/errors";
import { QUEUING, useSetExtracting } from "./ledger";
import { DOCUMENTS_HEADING_ID, describeExtractResult, type Explained } from "./messages";
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

// quiet: said to screen readers only, because the button beside it
// already says it (Deleting…).
type Notice = (Explained & { tone: "progress" | "done" | "error"; quiet?: boolean }) | null;

// The buttons never move. Labels that swap keep one width (min-w-28 fits
// Extract, Extract again and Extracting…; min-w-24 fits Delete, Yes, delete
// and Deleting…, in the label face). The root is display: contents, so its
// two parts, the buttons (data-part="buttons") and every message beside
// them (data-part="notice": progress, result, error, the delete
// confirmation), are placed by the row that holds them: the register line
// puts the buttons in its action column and the message on a line of its
// own under the detail (globals.css, "The register").
export function DocumentActions({ id, slug, filename, storagePath, canDownload, canDelete, extract }: Props) {
  const operations = useOperations();
  const questionId = useId();
  // The message shown is the one for the last thing the user did.
  const [last, setLast] = useState<"extract" | "delete" | "download" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [downloadError, setDownloadError] = useState<ErrorCode | null>(null);
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
    } catch (error) {
      return { error: classifyThrown(error) };
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
    } catch (error) {
      return { error: classifyThrown(error) };
    }
  }, {});

  // While Extract is in flight the register says so: the line's mark and
  // detail and the key read the requested state, not the data's from
  // before the click. Cleared when the answer comes back, or if this
  // button goes away first.
  const setExtracting = useSetExtracting();
  useEffect(() => {
    if (!setExtracting || !extracting) return;
    setExtracting(id, true);
    return () => setExtracting(id, false);
  }, [setExtracting, extracting, id]);

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
    // In the register the line's detail prints this and the register says
    // the line is queued, so the notice says nothing more.
    if (extracting) notice = setExtracting === null ? { tone: "progress", text: QUEUING } : null;
    else if (result) notice = { tone: result.ok ? "done" : "error", text: result.text };
  } else if (last === "delete") {
    if (deleting) notice = { tone: "progress", text: "Deleting…", quiet: true };
    else if (deleteState.error) notice = { tone: "error", text: userFacingError(deleteState.error).message };
  } else if (last === "download" && downloadError) {
    notice = { tone: "error", text: userFacingError(downloadError).message };
  }

  if (!canDownload && !canDelete && !extract) return null;

  const extractLabel =
    extracting || extract?.mode === "running" ? "Extracting…" : extract?.mode === "again" ? "Extract again" : "Extract";

  return (
    <div data-actions className="contents">
      <div data-part="buttons" className="flex flex-wrap gap-2">
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
              data-action="extract"
              disabled={busy || extract.mode === "running"}
              className={`${extract.primary ? buttonClass : secondaryButtonClass} min-w-28`}
            >
              {extractLabel}
              <FileName filename={filename} />
            </button>
          </form>
        )}
        {canDownload && (
          <button type="button" data-action="download" onClick={download} className={secondaryButtonClass}>
            Download
            <FileName filename={filename} />
          </button>
        )}
        {canDelete && (
          <form action={deleteAction} onSubmit={() => setConfirming(false)}>
            <input type="hidden" name="id" value={id} />
            <input type="hidden" name="slug" value={slug} />
            <button
              ref={deleteButton}
              type="submit"
              data-action="delete"
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
              <FileName filename={filename} />
            </button>
          </form>
        )}
      </div>

      <div data-part="notice" className="min-w-0 text-small">
        <div className="min-w-0">
          {/* Two regions, always rendered so what appears in them is
              announced, and side by side rather than nested so nothing is
              announced twice: polite for the question, progress and
              results, alert for errors. Every error is the catalog's
              sentence for a code, never a call's own text. */}
          <div aria-live="polite">
            {confirming ? (
              <p className="mt-2">
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
        </div>
      </div>
    </div>
  );
}

// A message about what the user just did. An error or a refusal stands
// against a 2px ink rule; progress and results are plain words. No glyph:
// the state glyphs mean a document's state, and a refused Extract on a
// ready document leaves it ready. No spinner: the words say it is under
// way.
function NoticeLine({ notice }: { notice: NonNullable<Notice> }) {
  return (
    <p
      className={
        notice.quiet ? "sr-only" : `mt-2 min-w-0 ${errorClass} ${notice.tone === "error" ? errorInkRuleClass : ""}`
      }
    >
      {notice.text}
    </p>
  );
}

// The file a button acts on, for a screen reader's list of buttons, where
// "Extract again" twice and "Download" three times can't be told apart.
// Hidden from sight: on the page the button sits in its document's line.
function FileName({ filename }: { filename: string }) {
  return <span className="sr-only normal-case"> {filename}</span>;
}
