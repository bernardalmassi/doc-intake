import "server-only";

// The queue worker (docs/worker-design.md): claims one queued run with the
// project's secret key and delivers it (extraction/delivery.ts). Called by
// the worker route (src/app/api/extraction-worker/route.ts) in after(), once
// its 202 is on the way, and by the local runner in the Supabase suites
// (tests/helpers/local-worker.ts) with fake or replayed providers. Nothing
// else may import it (tests/unit/worker-boundary.test.ts).
//
// It holds the two secrets nothing else in src/ names. SUPABASE_SECRET_KEY
// runs as service_role, the only role that may claim and finish a run, and
// reads any tenant's files; EXTRACTION_WORKER_SECRET is the bearer pg_net
// sends. Each is registered with the redactor as it is read, and so is each
// claim token for as long as it is held.
//
// One invocation claims at most one run. It never retries a model call:
// only a new enqueue, through the ceilings, runs a document again.

import { failureFields } from "@/app/log-fields";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { classifyStorageError } from "../errors";
import { log, type Logger } from "../log";
import { registerSecret } from "../redact";
import { CLAIM_REQUEST_TIMEOUT_MS } from "./config";
import { deliver, type DeliveryResult, type DownloadedFile, type ProviderPair } from "./delivery";
import { isAuthorizedWorkerCall } from "./worker-auth";
import { workerProjectUrl } from "./worker-target";

// The route's bearer check against EXTRACTION_WORKER_SECRET, which must be
// the app project's Vault extraction_worker_secret.
export function isAuthorizedWorkerRequest(authorization: string | null): boolean {
  const configured = process.env.EXTRACTION_WORKER_SECRET;
  if (configured) registerSecret(configured);
  return isAuthorizedWorkerCall(authorization, configured);
}

export type WorkerResult =
  | { kind: "not_configured" }
  | { kind: "claim_failed" }
  | { kind: "idle" }
  | { kind: "error" }
  | ({ kind: "delivered"; runId: string } & DeliveryResult);

// claim_extraction_run's row
type ClaimRow = {
  run_id: string;
  claim_token: string;
  tenant_id: string;
  document_id: string;
  storage_path: string;
  mime_type: string | null;
  page_count: number | null;
};

// providers is called only once a claimed run has passed its preflight: the
// route passes selectProviders, so a missing key fails that run with
// "extraction is not configured" instead of leaving it queued. deadline is
// when the invocation must be done with its finishes (epoch milliseconds):
// the route's start plus its maxDuration, less WORKER_DEADLINE_MARGIN_MS.
export async function processOneDelivery({
  providers,
  deadline,
}: {
  providers: () => ProviderPair;
  deadline: number;
}): Promise<WorkerResult> {
  let url: string;
  try {
    // refuses every project but this NODE_ENV's one, before any client exists
    url = workerProjectUrl(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NODE_ENV);
  } catch {
    log.error("worker.not_configured", { error_code: "worker_target_refused" });
    return { kind: "not_configured" };
  }
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!key) {
    log.error("worker.not_configured", { error_code: "worker_key_missing" });
    return { kind: "not_configured" };
  }
  registerSecret(key);

  try {
    const supabase = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });

    // the database ends a claim after CLAIM_TIMEOUT_MS (its transaction_timeout,
    // 20260925000005); this waits a little longer, so when it gives up the
    // claim has committed or rolled back
    const claimed = await supabase.rpc("claim_extraction_run").abortSignal(AbortSignal.timeout(CLAIM_REQUEST_TIMEOUT_MS));
    if (claimed.error) {
      log.error("worker.claim_failed", failureFields(claimed.error, claimed.status));
      return { kind: "claim_failed" };
    }
    const row = ((claimed.data ?? []) as ClaimRow[])[0];
    if (!row) {
      log.info("worker.idle");
      return { kind: "idle" };
    }

    const releaseToken = registerSecret(row.claim_token);
    try {
      const runLog = log.with({ run_id: row.run_id, document_id: row.document_id, tenant_id: row.tenant_id });
      runLog.info("worker.claimed", { expected_page_count: row.page_count });
      const result = await deliver({
        run: {
          runId: row.run_id,
          claimToken: row.claim_token,
          tenantId: row.tenant_id,
          documentId: row.document_id,
          mimeType: row.mime_type,
          pageCount: row.page_count,
        },
        download: (signal) => downloadFile(supabase, row.storage_path, runLog, signal),
        providers,
        // each attempt is aborted when its time is up (delivery.ts)
        finish: async (params, signal) => {
          const finished = await supabase.rpc("finish_extraction_run", params).abortSignal(signal);
          return finished.error ? { code: finished.error.code, status: finished.status } : null;
        },
        log: runLog,
        deadline,
      });
      return { kind: "delivered", runId: row.run_id, ...result };
    } finally {
      releaseToken();
    }
  } catch (error) {
    // after() has nothing to hand an error to; this is its last line
    log.error("worker.unexpected_error", {
      error_kind: "unexpected",
      error_name: error instanceof Error ? error.name : undefined,
    });
    return { kind: "error" };
  }
}

// With the secret key, which reads any tenant's files; the path is the
// claimed run's own document's, from the database. `signal` aborts the
// request and the body's read once the delivery's download time is up.
async function downloadFile(supabase: SupabaseClient, path: string, runLog: Logger, signal: AbortSignal): Promise<DownloadedFile> {
  try {
    const downloaded = await supabase.storage.from("documents").download(path, {}, { signal });
    if (downloaded.error || !downloaded.data) {
      const reason = downloaded.error ? classifyStorageError(downloaded.error, "download") : "no data";
      const status =
        downloaded.error && "status" in downloaded.error ? (downloaded.error.status as number | undefined) : undefined;
      runLog.warn("extraction.download_failed", {
        error_code: "extraction.download_failed",
        ...failureFields({ name: downloaded.error?.name }, status),
      });
      return { ok: false, reason };
    }
    return { ok: true, bytes: new Uint8Array(await downloaded.data.arrayBuffer()) };
  } catch (error) {
    runLog.warn("extraction.download_failed", {
      error_code: "extraction.download_failed",
      error_kind: "unexpected",
      error_name: error instanceof Error ? error.name : undefined,
    });
    return { ok: false, reason: "unknown" };
  }
}
