// One delivery of a queued run, once the worker has claimed it
// (claim_extraction_run, 20260925000002): the download, the preflight, the
// model calls, and the finish (finish_extraction_run). Free of I/O and
// secrets: extraction/worker.ts passes in the download, the providers and
// the finish, so tests/unit/delivery.test.ts can run all of it with fakes
// and count every provider call and every finish.
//
// The preflight, before any provider is built or called:
//   - the bytes must download (with the worker's key) within
//     DOWNLOAD_TIMEOUT_MS; the download is aborted then
//   - their magic bytes must match the row's type (sniff.ts)
//   - their pages must be countable, at most maxPagesPerDocument, and the
//     count the run was enqueued with. The enqueue trusts the count the
//     Extract action sends; this recount means a forged count never reaches
//     a model, so no run can cost more than the estimate it held against
//     the ceilings while in flight.
// Any failure finishes the run as failed with no model call: no model, 0
// tokens, 0 USD.
//
// The finish. One that gets no answer (a lost connection, a timeout, a 5xx
// from the gateway with no database error in it) or one of the database's
// transient refusals (a deadlock, a serialization failure, a statement
// timeout, no connection to the database) is sent again, unchanged, after a
// wait that doubles, for as long as the invocation has time left
// (`deadline`). A paid result is never replaced because of a blip. Only a
// definite refusal, the database answering with any other error, makes
// failedCloseAttempts (run.ts) plan what to finish with instead, as the
// Extract action closed runs before the queue: the same failure with the
// run's usage, then at the dearest price on file, marked estimated. A
// "not found or token invalid" (42501) after a finish that got no answer
// means the run has already ended, most likely by that finish: nothing more
// is tried. Only finishes are repeated, never model calls. If no finish is
// recorded, the run stays running and the queue's sweep charges it the
// estimate once its visibility timeout has passed.
//
// One log line per step, under the run's ids (src/lib/log.ts).

import { failureFields } from "@/app/log-fields";
import { classifyRunError, RUN_ERROR_MARKERS, TRANSIENT_SQLSTATES } from "../errors";
import type { Logger, LogFields } from "../log";
import {
  DOWNLOAD_TIMEOUT_MS,
  EXTRACTION_LIMITS,
  FINISH_ATTEMPT_TIMEOUT_MS,
  FINISH_MIN_ATTEMPT_MS,
  FINISH_RETRY_FIRST_DELAY_MS,
  FINISH_RETRY_MAX_DELAY_MS,
} from "./config";
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
// the response's status, or a thrown error's class name. postgrest-js
// reports a request that got no response (a lost connection, an abort) as
// code "" and status 0.
export type FinishRefusal = { code?: string | null; name?: string | null; status?: number | null };
// `signal` aborts the request when this attempt's time is up.
export type Finish = (params: ReturnType<typeof toFinishParams>, signal: AbortSignal) => Promise<FinishRefusal | null>;

// The time the finish may use, and how to wait: real by default, fake in
// tests.
export type Clock = { now(): number; sleep(ms: number): Promise<void> };
const realClock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };

// Whether a finish's refusal is worth sending the same finish again: no
// answer, a gateway's 5xx with no database error in it, PostgREST unable to
// reach the database, or a transient SQLSTATE. Anything else is the
// database refusing this outcome.
export function isTransientFinishRefusal(refusal: FinishRefusal): boolean {
  const code = refusal.code ?? null;
  const status = refusal.status ?? null;
  if (code === "" || status === 0) return true;
  if (code === null) return status === null || status >= 500;
  return /^PGRST00[0-3]$/.test(code) || code.startsWith("08") || TRANSIENT_SQLSTATES.has(code);
}

// A refusal that means the request may have been carried out: no answer came
// back at all, or a gateway answered for it.
function answerLost(refusal: FinishRefusal): boolean {
  const code = refusal.code ?? null;
  const status = refusal.status ?? null;
  return code === "" || status === 0 || (code === null && (status === null || status >= 500));
}

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
  // replaced with, or null if none was
  recorded: RunOutcome | null;
  // a finish got no answer and a later one found the run already ended: it
  // was most likely recorded by the one whose answer was lost
  unconfirmed: boolean;
  finishCalls: number;
};

// The download, or "timed out" once DOWNLOAD_TIMEOUT_MS has passed, when
// `signal` is aborted so the request stops too.
async function downloadInTime(download: (signal: AbortSignal) => Promise<DownloadedFile>, runLog: Logger): Promise<DownloadedFile> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<DownloadedFile>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      runLog.warn("extraction.download_failed", {
        error_code: "extraction.download_failed",
        error_kind: "transport",
        latency_ms: DOWNLOAD_TIMEOUT_MS,
      });
      resolve({ ok: false, reason: `timed out after ${DOWNLOAD_TIMEOUT_MS / 1000} s` });
    }, DOWNLOAD_TIMEOUT_MS);
  });
  try {
    return await Promise.race([download(controller.signal), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

export async function deliver(input: {
  run: ClaimedRun;
  // aborted if it outlasts DOWNLOAD_TIMEOUT_MS
  download: (signal: AbortSignal) => Promise<DownloadedFile>;
  // called only once the preflight has passed
  providers: () => ProviderPair;
  finish: Finish;
  log: Logger;
  // when the invocation must be done with its finishes (epoch milliseconds)
  deadline: number;
  clock?: Clock;
}): Promise<DeliveryResult> {
  const { run, log: runLog } = input;
  const clock = input.clock ?? realClock;
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
    const checked = await preflight(await downloadInTime(input.download, runLog), run);
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
  const finishOnce = async (attempt: RunOutcome, timeoutMs: number): Promise<FinishRefusal | null> => {
    finishCalls += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await input.finish(toFinishParams(run.runId, run.claimToken, attempt, attempt.costEstimated), controller.signal);
    } catch (error) {
      // no answer at all, as postgrest-js reports a lost connection
      return { code: "", name: error instanceof Error ? error.name : null };
    } finally {
      clearTimeout(timer);
    }
  };

  // One finish, sent again while it gets no answer or a transient refusal
  // and the deadline allows. What it came to: recorded, a definite refusal,
  // or out of time; and whether an attempt's answer was lost on the way.
  type Recording = { recorded: true } | { recorded: false; refusal: FinishRefusal; definite: boolean; lost: boolean };
  const record = async (attempt: RunOutcome, retry: number): Promise<Recording> => {
    let delay = FINISH_RETRY_FIRST_DELAY_MS;
    let lost = false;
    let last: FinishRefusal = { code: "", name: "DeadlineReached" };
    for (let sent = 0; ; sent++) {
      const remaining = input.deadline - clock.now();
      if (remaining < FINISH_MIN_ATTEMPT_MS) return { recorded: false, refusal: last, definite: false, lost };
      const refused = await finishOnce(attempt, Math.min(FINISH_ATTEMPT_TIMEOUT_MS, remaining));
      if (!refused) return { recorded: true };
      last = refused;
      if (!isTransientFinishRefusal(refused)) return { recorded: false, refusal: refused, definite: true, lost };
      lost ||= answerLost(refused);
      // another attempt only after the full wait, and only with time for it
      if (clock.now() + delay + FINISH_MIN_ATTEMPT_MS > input.deadline) {
        return { recorded: false, refusal: refused, definite: false, lost };
      }
      runLog.warn("worker.finish_retrying", { retry, attempt: sent + 1, run_status: attempt.status, ...failureFields(refused, refused.status) });
      await clock.sleep(delay);
      delay = Math.min(delay * 2, FINISH_RETRY_MAX_DELAY_MS);
    }
  };

  const first = await record(outcome, 0);
  if (first.recorded) {
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
    return { outcome, recorded: outcome, unconfirmed: false, finishCalls };
  }

  const refusal = failureFields(first.refusal, first.refusal.status);
  runLog.error("worker.finish_failed", {
    retry: 0,
    run_status: outcome.status,
    error_code: "extraction.record_failed",
    ...refusal,
    ...usage,
  });
  // out of time, or a blip that never cleared: the outcome is not replaced;
  // the sweep charges the run the estimate after its visibility timeout
  if (!first.definite) return { outcome, recorded: null, unconfirmed: false, finishCalls };
  // the token is gone after a finish whose answer was lost: that finish most
  // likely recorded the run, and every other would get the same refusal
  if (first.lost && first.refusal.code === "42501") {
    runLog.warn("worker.finish_unconfirmed", { run_status: outcome.status, ...refusal });
    return { outcome, recorded: null, unconfirmed: true, finishCalls };
  }

  for (const [index, attempt] of failedCloseAttempts(outcome, refusal.db_code ?? null).entries()) {
    const retry = index + 1;
    const again = await record(attempt, retry);
    if (again.recorded) {
      runLog.warn("worker.finish_retried", {
        retry,
        run_status: "failed",
        error_code: attempt.status === "failed" ? classifyRunError(attempt.error) : "unknown",
        model: attempt.model,
        input_tokens: attempt.inputTokens,
        output_tokens: attempt.outputTokens,
      });
      return { outcome, recorded: attempt, unconfirmed: false, finishCalls };
    }
    runLog.error("worker.finish_failed", {
      retry,
      run_status: "failed",
      error_code: "extraction.record_failed",
      ...failureFields(again.refusal, again.refusal.status),
    });
    if (!again.definite) break;
    if (again.lost && again.refusal.code === "42501") {
      runLog.warn("worker.finish_unconfirmed", { run_status: "failed", ...failureFields(again.refusal, again.refusal.status) });
      return { outcome, recorded: null, unconfirmed: true, finishCalls };
    }
  }
  return { outcome, recorded: null, unconfirmed: false, finishCalls };
}
