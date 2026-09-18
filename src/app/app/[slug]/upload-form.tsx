"use client";

import { useEffect, useId, useRef, useState } from "react";
import { buttonClass, errorClass, ghostButtonClass, hintClass, secondaryButtonClass } from "@/app/ui";
import { fileKind, formatBytes } from "./format";
import { AlertIcon, CheckIcon, DotIcon, FileIcon, SpinnerIcon, UploadIcon } from "./icons";
import {
  describeRejection,
  describeUploadFailure,
  isRetryable,
  type RejectReason,
  UPLOAD_LIMIT_TEXT,
  UPLOAD_STEPS,
  uploadFailureDetail,
} from "./messages";
import { type UploadFailure, type UploadStep, useOperations } from "./operations";

// Same limits as the bucket. Checked here only so an obviously wrong file
// never leaves an unfinished entry behind; the bucket is what enforces them.
const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPTED_TYPES = ["application/pdf", "image/png", "image/jpeg"];
// Extensions too, so every OS file picker filters to the right files.
const ACCEPT = [...ACCEPTED_TYPES, ".pdf", ".png", ".jpg", ".jpeg"].join(",");

export type PickedFile = { name: string; type: string; size: number };

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
  const id = useId();
  const hintId = `${id}-hint`;
  const messageId = `${id}-message`;

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

  function pick(files: FileList | null | undefined) {
    if (!files || files.length === 0 || uploading) return;
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
    const reason: RejectReason | null = !ACCEPTED_TYPES.includes(picked.type)
      ? "type"
      : picked.size === 0
        ? "empty"
        : picked.size > MAX_BYTES
          ? "size"
          : null;
    if (reason) {
      file.current = null;
      focusAfterRender.current = "choose";
      setState({ kind: "rejected", reason, file: info });
      return;
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
      failure = {
        step,
        message: error instanceof Error ? error.message : String(error),
        network: true,
        rowCreated: step > 1,
      };
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
    <div className="mt-3 max-w-2xl">
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
        className={`rounded-lg border p-4 sm:p-5 ${
          dragging
            ? "border-solid border-fg bg-surface"
            : showPicker
              ? `border-dashed bg-transparent ${state.kind === "rejected" ? "border-danger" : "border-line-strong"}`
              : "border-solid border-line bg-surface"
        }`}
      >
        {showPicker ? (
          <div className="flex items-center gap-4">
            <span className="hidden h-10 w-10 shrink-0 items-center justify-center rounded-full border border-line text-muted sm:flex">
              <UploadIcon />
            </span>
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-x-2 gap-y-2">
                <span className="pointer-coarse:hidden">{dragging ? "Drop it here" : "Drag a file here, or"}</span>
                <button
                  ref={chooseButton}
                  type="button"
                  onClick={() => input.current?.click()}
                  aria-describedby={`${hintId} ${messageId}`}
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
            {state.kind === "failed" && !isRetryable(state.failure) ? (
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

      {/* Always rendered, so screen readers announce what appears in it.
          min-h keeps the list below from jumping when a line appears. */}
      <div id={messageId} aria-live="polite" className="mt-2 min-h-5 text-sm">
        {state.kind === "idle" && state.uploaded && (
          <p className="flex items-start gap-1.5">
            <CheckIcon className="mt-0.5" />
            <span className="min-w-0 [overflow-wrap:anywhere]">Uploaded {state.uploaded}.</span>
          </p>
        )}
        {state.kind === "rejected" && (
          <p role="alert" className={`flex items-start gap-1.5 ${errorClass}`}>
            <AlertIcon className="mt-0.5" />
            <span className="min-w-0 [overflow-wrap:anywhere]">{describeRejection(state.reason, state.file)}</span>
          </p>
        )}
        {state.kind === "uploading" && <span className="sr-only">{UPLOAD_STEPS[state.step - 1]}…</span>}
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
      <div className="flex items-start gap-3">
        <FileIcon className="mt-0.5 text-muted" />
        <div className="min-w-0">
          <p className="font-medium [overflow-wrap:anywhere]">{file.name}</p>
          <p className={`${hintClass} tabular-nums`}>
            {kind ? `${kind} · ` : ""}
            {formatBytes(file.size)}
          </p>
        </div>
      </div>

      {state.kind === "uploading" && <UploadSteps current={state.step} />}

      {state.kind === "failed" && (
        <div className="mt-4">
          <p role="alert" className={`flex items-start gap-1.5 ${errorClass}`}>
            <AlertIcon className="mt-0.5" />
            <span className="min-w-0">
              The upload didn&apos;t finish. {describeUploadFailure(state.failure)}
            </span>
          </p>
          {state.failure.rowCreated && (
            <p className={`mt-1 ${hintClass}`}>
              An unfinished entry for this file is now in the list below.{" "}
              {canManage ? "You can delete it there." : "An admin can delete it."}
            </p>
          )}
          <details className="mt-2 text-sm">
            <summary className="w-fit cursor-pointer text-muted">Technical details</summary>
            <p className="mt-1 text-muted [overflow-wrap:anywhere]">{uploadFailureDetail(state.failure)}</p>
          </details>
        </div>
      )}
    </>
  );
}

function UploadSteps({ current }: { current: UploadStep }) {
  return (
    <ol aria-label="Upload progress" className="mt-4 space-y-1.5 text-sm">
      {UPLOAD_STEPS.map((label, index) => {
        const step = index + 1;
        const status = step < current ? "done" : step === current ? "current" : "waiting";
        return (
          <li key={label} className={`flex items-center gap-2 ${status === "waiting" ? "text-muted" : "text-fg"}`}>
            {status === "done" ? <CheckIcon /> : status === "current" ? <SpinnerIcon /> : <DotIcon />}
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
