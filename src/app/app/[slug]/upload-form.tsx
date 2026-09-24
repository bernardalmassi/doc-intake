"use client";

import { useEffect, useId, useRef, useState } from "react";
import { buttonClass, errorClass, errorInkRuleClass, ghostButtonClass, hintClass, secondaryButtonClass } from "@/app/ui";
import { fileKind, formatBytes } from "./format";
import { StateGlyph } from "./state-glyph";
import { checkPageCount, checkUploadFile, classifyThrown, UPLOAD_MIME_TYPES, userFacingError } from "@/lib/errors";
import { countPdfPagesInBrowser } from "@/lib/page-count-browser";
import { describeRejection, type RejectReason, UPLOAD_LIMIT_TEXT, UPLOAD_STEPS } from "./messages";
import { type UploadFailure, type UploadStep, useOperations } from "./operations";

// The bucket's types, from src/lib/errors.ts, and extensions too, so every
// OS file picker filters to the right files. checkUploadFile applies the
// bucket's limits before anything is sent, so an obviously wrong file
// never leaves an unfinished entry behind; the bucket is what enforces them.
const ACCEPT = [...UPLOAD_MIME_TYPES, ".pdf", ".png", ".jpg", ".jpeg"].join(",");

// pages: counted for a PDF before it is accepted, for the rejection message
export type PickedFile = { name: string; type: string; size: number; pages?: number | null };

export type UploadState =
  // `uploaded` names the file that just finished, for the confirmation
  | { kind: "idle"; uploaded?: string }
  | { kind: "rejected"; reason: RejectReason; file: PickedFile | null }
  | { kind: "chosen"; file: PickedFile }
  | { kind: "uploading"; file: PickedFile; step: UploadStep }
  | { kind: "failed"; file: PickedFile; failure: UploadFailure };

function describe(file: File): PickedFile {
  return { name: file.name, type: file.type, size: file.size };
}

// Idle, chosen, uploading, rejected and failed, in one place. supabase-js
// reports no byte progress, so the upload shows its three real steps (row,
// bytes, confirmation) as each one starts, never a percentage.
// `initialState` lets the design preview show any state without a file.
export function UploadForm({
  tenantId,
  canManage,
  initialState,
}: {
  tenantId: string;
  canManage: boolean;
  initialState?: UploadState;
}) {
  const { upload } = useOperations();
  const [state, setState] = useState<UploadState>(initialState ?? { kind: "idle" });
  const [dragging, setDragging] = useState(false);
  const file = useRef<File | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const chooseButton = useRef<HTMLButtonElement>(null);
  const primaryButton = useRef<HTMLButtonElement>(null);
  // Where focus goes after the next render. Views swap buttons in and out,
  // and a keyboard user must not be dropped at the top of the page.
  const focusAfterRender = useRef<"choose" | "primary" | null>(null);
  const hintId = useId();
  // bumped on every pick, so a page count that finishes after a newer pick
  // is dropped
  const pickId = useRef(0);

  useEffect(() => {
    const target = focusAfterRender.current;
    focusAfterRender.current = null;
    if (target === "choose") chooseButton.current?.focus();
    if (target === "primary") primaryButton.current?.focus();
  });

  // A file dropped just outside the upload area would make the browser
  // leave the page to open it. Ignore drops anywhere else on the page.
  useEffect(() => {
    function ignore(event: DragEvent) {
      if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
    }
    window.addEventListener("dragover", ignore);
    window.addEventListener("drop", ignore);
    return () => {
      window.removeEventListener("dragover", ignore);
      window.removeEventListener("drop", ignore);
    };
  }, []);

  const uploading = state.kind === "uploading";

  async function pick(files: FileList | null | undefined) {
    if (!files || files.length === 0 || uploading) return;
    const id = ++pickId.current;
    // A rejection shows the picker again; the button that opened the file
    // dialog may have been in the file card, which is now gone.
    if (files.length > 1) {
      file.current = null;
      focusAfterRender.current = "choose";
      setState({ kind: "rejected", reason: "several", file: null });
      return;
    }
    const picked = files[0];
    const info = describe(picked);
    const refused = checkUploadFile(picked);
    const reason: RejectReason | null =
      refused === "upload.file_type_not_allowed"
        ? "type"
        : picked.size === 0
          ? "empty"
          : refused === "upload.file_too_large"
            ? "size"
            : null;
    if (reason) {
      file.current = null;
      focusAfterRender.current = "choose";
      setState({ kind: "rejected", reason, file: info });
      return;
    }
    // A PDF over the page limit, or one whose pages can't be counted, would
    // be refused at Extract; say so now. The Extract action checks again on
    // the server, since this check can be skipped.
    if (picked.type === "application/pdf") {
      const pages = await countPdfPagesInBrowser(picked);
      if (id !== pickId.current) return;
      const tooMany = checkPageCount(pages);
      if (tooMany) {
        file.current = null;
        focusAfterRender.current = "choose";
        setState({ kind: "rejected", reason: tooMany === "document.too_many_pages" ? "pages" : "unreadable", file: { ...info, pages } });
        return;
      }
    }
    file.current = picked;
    focusAfterRender.current = "primary";
    setState({ kind: "chosen", file: info });
  }

  function clear() {
    file.current = null;
    focusAfterRender.current = "choose";
    setState({ kind: "idle" });
  }

  async function start() {
    const chosen = file.current;
    if (!chosen || uploading) return;
    const info = describe(chosen);
    let step: UploadStep = 1;
    setState({ kind: "uploading", file: info, step });

    let failure: UploadFailure | null = null;
    try {
      const result = await upload(tenantId, chosen, (next) => {
        step = next;
        setState({ kind: "uploading", file: info, step: next });
      });
      if (!result.ok) failure = result;
    } catch (error) {
      failure = { step, code: classifyThrown(error), rowCreated: step > 1 };
    }

    if (failure) {
      focusAfterRender.current = "primary";
      setState({ kind: "failed", file: info, failure });
      return;
    }
    file.current = null;
    focusAfterRender.current = "choose";
    setState({ kind: "idle", uploaded: chosen.name });
  }

  const showPicker = state.kind === "idle" || state.kind === "rejected";

  return (
    <div>
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        tabIndex={-1}
        aria-hidden="true"
        className="sr-only"
        onChange={(event) => {
          pick(event.target.files);
          // so choosing the same file again still fires a change
          event.target.value = "";
        }}
      />

      <div
        onDragEnter={(event) => {
          if (uploading || !event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          setDragging(true);
        }}
        onDragOver={(event) => {
          if (uploading || !event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          pick(event.dataTransfer.files);
        }}
        // A ruled line of the register, like every other: the drop area is
        // the whole line, and a file dragged over it draws a 2px ink frame.
        className={`border-y border-ink py-4 ${dragging ? "outline-2 -outline-offset-2 outline-ink" : ""}`}
      >
        {showPicker ? (
          <div>
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-x-2 gap-y-2">
                <span className="pointer-coarse:hidden">{dragging ? "Drop it here." : "Drag a file here, or"}</span>
                {/* Described by the limits only. The last result is announced
                    by the regions below as it happens; focus often lands here
                    at that same moment, and a description holding the result
                    would read it out a second time. */}
                <button
                  ref={chooseButton}
                  type="button"
                  onClick={() => input.current?.click()}
                  aria-describedby={hintId}
                  className={secondaryButtonClass}
                >
                  Choose a file
                </button>
              </p>
              <p id={hintId} className={`mt-2 ${hintClass}`}>
                {UPLOAD_LIMIT_TEXT}
              </p>
            </div>
          </div>
        ) : (
          <ChosenFile state={state} canManage={canManage} />
        )}

        {!showPicker && (
          <div className="mt-4 flex flex-wrap gap-2">
            {state.kind === "failed" && !userFacingError(state.failure.code).retryable ? (
              // Sending the same file again can't work: offer another one.
              <button
                ref={primaryButton}
                type="button"
                onClick={() => input.current?.click()}
                className={secondaryButtonClass}
              >
                Choose another file
              </button>
            ) : (
              <button
                ref={primaryButton}
                type="button"
                onClick={start}
                disabled={uploading}
                className={`${buttonClass} min-w-28`}
              >
                {uploading ? "Uploading…" : state.kind === "failed" ? "Try again" : "Upload"}
              </button>
            )}
            <button type="button" onClick={clear} disabled={uploading} className={ghostButtonClass}>
              Clear
            </button>
          </div>
        )}
      </div>

      {/* Two regions, always rendered so what appears in them is announced,
          and side by side rather than nested so nothing is announced twice:
          polite for the steps and the result, alert for a rejected file.
          (A failed upload is announced inside the file card.) min-h keeps
          the list below from jumping when a line appears. */}
      <div className="mt-2 min-h-5 text-small">
        <div aria-live="polite">
          {state.kind === "idle" && state.uploaded && (
            <p className="min-w-0 [overflow-wrap:anywhere]">Uploaded {state.uploaded}.</p>
          )}
          {state.kind === "uploading" && <span className="sr-only">{UPLOAD_STEPS[state.step - 1]}…</span>}
        </div>
        <div role="alert">
          {state.kind === "rejected" && (
            <p className={`min-w-0 [overflow-wrap:anywhere] ${errorClass} ${errorInkRuleClass}`}>
              {describeRejection(state.reason, state.file)}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// The file card: what was chosen, then the steps while it uploads, or why
// it stopped.
function ChosenFile({
  state,
  canManage,
}: {
  state: Extract<UploadState, { file: PickedFile }>;
  canManage: boolean;
}) {
  const { file } = state;
  const kind = fileKind(file.type);

  return (
    <>
      <div>
        <div className="min-w-0">
          <p className="[overflow-wrap:anywhere]">{file.name}</p>
          <p className={`${hintClass} tabular-nums`}>
            {kind ? `${kind} · ` : ""}
            {formatBytes(file.size)}
          </p>
        </div>
      </div>

      {state.kind === "uploading" && <UploadSteps current={state.step} />}

      {/* Rendered while the card is (chosen, uploading, failed), so it is
          in the page before a failure is written into it. */}
      <div role="alert">
        {state.kind === "failed" && (
          <p className={`mt-4 min-w-0 ${errorClass} ${errorInkRuleClass}`}>
            The upload didn&apos;t finish. {userFacingError(state.failure.code).message}
          </p>
        )}
      </div>
      {state.kind === "failed" && (
        <>
          {state.failure.rowCreated && (
            <p className={`mt-1 ${hintClass}`}>
              An unfinished entry for this file is now in the list above.{" "}
              {canManage ? "You can delete it there." : "An admin can delete it."}
            </p>
          )}
        </>
      )}
    </>
  );
}

function UploadSteps({ current }: { current: UploadStep }) {
  return (
    <ol aria-label="Upload progress" className="mt-4 space-y-1.5 text-small">
      {/* The state glyphs, meaning what they mean everywhere: full for a
          step done, half for the one under way, empty for one to come. */}
      {UPLOAD_STEPS.map((label, index) => {
        const step = index + 1;
        const status = step < current ? "done" : step === current ? "current" : "waiting";
        return (
          <li key={label} className="flex items-center gap-2">
            <StateGlyph glyph={status === "done" ? "full" : status === "current" ? "half" : "empty"} />
            <span>
              {label}
              {status === "current" && "…"}
            </span>
            <span className="sr-only">
              {status === "done" ? "(done)" : status === "current" ? "(in progress)" : "(not started)"}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
