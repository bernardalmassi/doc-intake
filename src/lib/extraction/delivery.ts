// One delivery of a queued run, once the worker has claimed it
// (claim_extraction_run, 20260925000002): the download, the preflight, the
// model calls, and the finish (finish_extraction_run). Free of I/O and
// secrets: extraction/worker.ts passes in the download, the providers and
// the finish, so tests/unit/delivery.test.ts can run all of it with fakes
// and count every provider call and every finish.
//
// The preflight, before any provider is built or called:
//   - the bytes must download (with the worker's key)
//   - their magic bytes must match the row's type (sniff.ts)
//   - their pages must be countable, at most maxPagesPerDocument, and the
//     count the run was enqueued with. The enqueue trusts the count the
//     Extract action sends; this recount means a forged count never reaches
//     a model, so no run can cost more than the estimate it held against
//     the ceilings while in flight.
// Any failure finishes the run as failed with no model call: no model, 0
// tokens, 0 USD.
//
// The finish: if it is refused, failedCloseAttempts (run.ts) plans what to
// finish with instead, as the Extract action closed runs before the queue:
// the same failure with the run's usage, then at the dearest price on file,
// marked estimated. Only finishes are repeated, never model calls. If every
// finish is refused, the run stays running and the queue's sweep charges it
// the estimate once its visibility timeout has passed.
//
// One log line per step, under the run's ids (src/lib/log.ts).

import { failureFields } from "@/app/log-fields";
import { classifyRunError, RUN_ERROR_MARKERS } from "../errors";
import type { Logger, LogFields } from "../log";
import { EXTRACTION_LIMITS } from "./config";
import { countPages } from "./pages";
import { describeError, type ExtractionProvider } from "./providers/types";
import { failedCloseAttempts, runExtraction, toFinishParams, type RunOutcome } from "./run";
import { detectMimeType, isSupportedMimeType, type SupportedMimeType } from "./sniff";

// What claim_extraction_run hands the worker about the run it claimed.
export type ClaimedRun = {
  runId: string;
  claimToken: string;
  tenantId: string;
  documentId: string;
  // the row's type, from the stored object's metadata at upload
  mimeType: string | null;
  // as the run was enqueued with, clamped; null if the Extract action
  // couldn't count the pages
  pageCount: number | null;
};

// The bytes, or why they couldn't be read: a code, never Storage's message,
// because it is stored on the run.
export type DownloadedFile = { ok: true; bytes: Uint8Array } | { ok: false; reason: string };

export type ProviderPair = { primary: ExtractionProvider; fallback: ExtractionProvider | null };

// What refused a finish, if anything: finish_extraction_run's SQLSTATE and
// the response's status, or a thrown error's class name.
export type FinishRefusal = { code?: string | null; name?: string | null; status?: number | null };
export type Finish = (params: ReturnType<typeof toFinishParams>) => Promise<FinishRefusal | null>;

export type Preflighted =
  | { ok: true; bytes: Uint8Array; mimeType: SupportedMimeType; pages: number }
  | { ok: false; error: string; log: LogFields };

export async function preflight(
  file: DownloadedFile,
  run: Pick<ClaimedRun, "mimeType" | "pageCount">,
): Promise<Preflighted> {
  if (!file.ok) {
    return {
      ok: false,
      error: `could not download the file: ${file.reason}`,
      log: { error_code: "extraction.download_failed" },
    };
  }
  const size_bytes = file.bytes.length;
  const detected = detectMimeType(file.bytes);
  if (detected === null || !isSupportedMimeType(run.mimeType) || detected !== run.mimeType) {
    return {
      ok: false,
      error: `file content (${detected ?? "unrecognized"}) does not match its declared type (${run.mimeType ?? "none"})`,
      log: {
        error_code: "extraction.file_type_mismatch",
        mime_type: isSupportedMimeType(run.mimeType) ? run.mimeType : null,
        detected_mime_type: detected,
        size_bytes,
      },
    };
  }
  const pages = await countPages(file.bytes, detected);
  const max = EXTRACTION_LIMITS.maxPagesPerDocument;
  const counted = { mime_type: detected, size_bytes, page_count: pages, expected_page_count: run.pageCount };
  if (pages === null) {
    return {
      ok: false,
      error: `${RUN_ERROR_MARKERS.pagesUnreadable}the file's pages could not be counted`,
      log: { error_code: "document.pages_unreadable", ...counted },
    };
  }
  if (pages > max) {
    return {
      ok: false,
      error: `${RUN_ERROR_MARKERS.tooManyPages}the file has ${pages}, the limit is ${max}`,
      log: { error_code: "document.too_many_pages", ...counted },
    };
  }
  if (pages !== run.pageCount) {
    return {
      ok: false,
      error: `${RUN_ERROR_MARKERS.pageCountMismatch}the file has ${pages}, the run was enqueued with ${run.pageCount ?? "none"}`,
      log: { error_code: "extraction.page_count_mismatch", ...counted },
    };
  }
  return { ok: true, bytes: file.bytes, mimeType: detected, pages };
}

export type DeliveryResult = {
  // what the run ended with
  outcome: RunOutcome;
  // what was recorded: the outcome itself, the failure a refused finish was
  // replaced with, or null if every finish was refused
  recorded: RunOutcome | null;
  finishCalls: number;
};

export async function deliver(input: {
  run: ClaimedRun;
  download: () => Promise<DownloadedFile>;
  // called only once the preflight has passed
  providers: () => ProviderPair;
  finish: Finish;
  log: Logger;
}): Promise<DeliveryResult> {
  const { run, log: runLog } = input;
  const startedAt = Date.now();
  const failed = (error: string): RunOutcome => ({
    status: "failed",
    error,
    rawResponse: null,
    provider: null,
    model: null,
    attempts: 0,
    inputTokens: 0,
    outputTokens: 0,
    latencyMs: Date.now() - startedAt,
    costEstimated: false,
  });

  let outcome: RunOutcome;
  try {
    const checked = await preflight(await input.download(), run);
    if (!checked.ok) {
      runLog.warn("worker.preflight_failed", checked.log);
      outcome = failed(checked.error);
    } else {
      const { primary, fallback } = input.providers();
      outcome = await runExtraction({
        bytes: checked.bytes,
        mimeType: checked.mimeType,
        pages: checked.pages,
        primary,
        fallback,
        logContext: { run_id: run.runId, document_id: run.documentId, tenant_id: run.tenantId },
      });
    }
  } catch (error) {
    runLog.error("worker.unexpected_error", {
      error_kind: "unexpected",
      error_name: error instanceof Error ? error.name : undefined,
    });
    outcome = failed(describeError(error));
  }

  const usage = {
    provider: outcome.provider,
    model: outcome.model,
    attempts: outcome.attempts,
    input_tokens: outcome.inputTokens,
    output_tokens: outcome.outputTokens,
    latency_ms: outcome.latencyMs,
  };
  let finishCalls = 0;
  const finish = async (attempt: RunOutcome, costEstimated: boolean): Promise<FinishRefusal | null> => {
    finishCalls += 1;
    try {
      return await input.finish(toFinishParams(run.runId, run.claimToken, attempt, costEstimated));
    } catch (error) {
      // no answer at all, as postgrest-js reports a lost connection
      return { code: "", name: error instanceof Error ? error.name : null };
    }
  };

  const refused = await finish(outcome, outcome.costEstimated);
  if (!refused) {
    if (outcome.status === "failed") {
      runLog.warn("worker.finished", { run_status: "failed", error_code: classifyRunError(outcome.error), ...usage });
    } else {
      runLog.info("worker.finished", {
        run_status: "succeeded",
        document_status: outcome.documentStatus,
        field_count: outcome.fields.length,
        ...usage,
      });
    }
    return { outcome, recorded: outcome, finishCalls };
  }

  const refusal = failureFields(refused, refused.status);
  runLog.error("worker.finish_failed", {
    retry: 0,
    run_status: outcome.status,
    error_code: "extraction.record_failed",
    ...refusal,
    ...usage,
  });
  for (const [index, attempt] of failedCloseAttempts(outcome, refusal.db_code ?? null).entries()) {
    const retry = index + 1;
    const again = await finish(attempt, attempt.costEstimated);
    if (!again) {
      runLog.warn("worker.finish_retried", {
        retry,
        run_status: "failed",
        error_code: attempt.status === "failed" ? classifyRunError(attempt.error) : "unknown",
        model: attempt.model,
        input_tokens: attempt.inputTokens,
        output_tokens: attempt.outputTokens,
      });
      return { outcome, recorded: attempt, finishCalls };
    }
    runLog.error("worker.finish_failed", {
      retry,
      run_status: "failed",
      error_code: "extraction.record_failed",
      ...failureFields(again, again.status),
    });
  }
  return { outcome, recorded: null, finishCalls };
}
