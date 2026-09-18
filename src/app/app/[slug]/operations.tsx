"use client";

import { createContext, useContext, useMemo, useState } from "react";
import type { FormState } from "@/app/auth/actions";

// Everything the organization page does to a document, behind one context.
// The real page provides LiveOperations (the Server Actions and Supabase
// calls); the local design preview provides fakes, so the same components
// can be clicked through every state without touching real data.

// 1: the row (a Server Action, no bytes), 2: the bytes, straight to
// Storage, 3: the confirmation RPC.
export type UploadStep = 1 | 2 | 3;

export type UploadFailure = {
  step: UploadStep;
  // what the failing call reported, kept for the technical details
  message: string;
  // HTTP status from Storage, when there was a response
  status?: number;
  // Storage error code or Postgres SQLSTATE, when known
  code?: string;
  // the call threw instead of answering (offline, connection dropped)
  network?: boolean;
  // step 1 succeeded, so an unfinished entry now exists in the list
  rowCreated: boolean;
};

export type UploadResult = { ok: true } | ({ ok: false } & UploadFailure);

export type DocumentOperations = {
  upload: (tenantId: string, file: File, onStep: (step: UploadStep) => void) => Promise<UploadResult>;
  extractAction: (prev: FormState, formData: FormData) => Promise<FormState>;
  deleteAction: (prev: FormState, formData: FormData) => Promise<FormState>;
  // resolves with an error message, or starts the download and resolves {}
  download: (storagePath: string, filename: string) => Promise<{ error?: string }>;
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
  const value = useMemo(() => ({ ...operations, announce: setAnnouncement }), [operations]);
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
