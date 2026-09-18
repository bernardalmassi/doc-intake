"use client";

import { createContext, useContext, useMemo, useState } from "react";
import { flushSync } from "react-dom";
import type { FormState } from "@/app/form-state";
import type { ErrorCode } from "@/lib/errors";

// Everything the organization page does to a document, behind one context.
// The real page provides LiveOperations (the Server Actions and Supabase
// calls); the local design preview provides fakes, so the same components
// can be clicked through every state without touching real data. Failures
// come back as codes from src/lib/errors.ts, never as a call's own text.

// 1: the row (a Server Action, no bytes), 2: the bytes, straight to
// Storage, 3: the confirmation RPC.
export type UploadStep = 1 | 2 | 3;

export type UploadFailure = {
  step: UploadStep;
  code: ErrorCode;
  // step 1 succeeded, so an unfinished entry now exists in the list
  rowCreated: boolean;
};

export type UploadResult = { ok: true } | ({ ok: false } & UploadFailure);

export type DocumentOperations = {
  upload: (tenantId: string, file: File, onStep: (step: UploadStep) => void) => Promise<UploadResult>;
  extractAction: (prev: FormState, formData: FormData) => Promise<FormState>;
  deleteAction: (prev: FormState, formData: FormData) => Promise<FormState>;
  // resolves with an error code, or starts the download and resolves {}
  download: (storagePath: string, filename: string) => Promise<{ error?: ErrorCode }>;
};

type ContextValue = DocumentOperations & {
  // says something to screen readers when the element that would have
  // said it is gone (a deleted document's own status line)
  announce: (message: string) => void;
};

const OperationsContext = createContext<ContextValue | null>(null);

export function OperationsProvider({
  operations,
  children,
}: {
  operations: DocumentOperations;
  children: React.ReactNode;
}) {
  const [announcement, setAnnouncement] = useState("");
  const value = useMemo(
    () => ({
      ...operations,
      // Emptied first, so the same words twice in a row (two files with
      // one name, deleted one after the other) are a change, and read.
      announce: (message: string) => {
        flushSync(() => setAnnouncement(""));
        setAnnouncement(message);
      },
    }),
    [operations],
  );
  return (
    <OperationsContext value={value}>
      {children}
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </OperationsContext>
  );
}

export function useOperations(): ContextValue {
  const value = useContext(OperationsContext);
  if (!value) throw new Error("useOperations must be used inside an OperationsProvider");
  return value;
}
