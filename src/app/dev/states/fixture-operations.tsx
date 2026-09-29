"use client";

import { useMemo } from "react";
import type { DocumentOperations, UploadResult } from "@/app/app/[slug]/operations";
import { OperationsProvider } from "@/app/app/[slug]/operations";
import type { FormState } from "@/app/form-state";
import type { ErrorCode } from "@/lib/errors";

// Stand-ins for LiveOperations on /dev/states. No network, no Server
// Action, no Supabase client: each answers after a short wait with the
// result the screen asked for, shaped like the real one.

export type Outcome = FormState | "hang" | "throw";

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function answer(outcome: Outcome, ms: number): Promise<FormState> {
  if (outcome === "hang") return new Promise(() => {});
  await wait(ms);
  if (outcome === "throw") throw new TypeError("Failed to fetch");
  return outcome;
}

export function FixtureOperations({
  extract = { message: "Extraction finished." },
  remove = {},
  download = null,
  children,
}: {
  extract?: Outcome;
  remove?: Outcome;
  // an error code to answer a Download click with; null does nothing
  download?: ErrorCode | null;
  children: React.ReactNode;
}) {
  const operations = useMemo<DocumentOperations>(
    () => ({
      // Walks the three steps and succeeds. Nothing is sent anywhere.
      async upload(_tenantId, _file, onStep): Promise<UploadResult> {
        onStep(1);
        await wait(600);
        onStep(2);
        await wait(1_200);
        onStep(3);
        await wait(600);
        return { ok: true };
      },
      extractAction: () => answer(extract, 400),
      deleteAction: () => answer(remove, 400),
      async download() {
        await wait(200);
        return download ? { error: download } : {};
      },
    }),
    [extract, remove, download],
  );

  return <OperationsProvider operations={operations}>{children}</OperationsProvider>;
}
