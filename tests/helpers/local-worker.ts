// The queue worker, run in-process against the TEST project with fake or
// replayed providers: what the worker route does in production, minus the
// route (docs/worker-design.md, section 10). The Supabase suites enqueue as
// a signed-in admin with the publishable key, then call this to claim,
// preflight, run and finish, and check what the database recorded.
//
// The Vitest "supabase" project (vitest.config.mts) maps
// SUPABASE_TEST_SECRET_KEY to SUPABASE_SECRET_KEY and SUPABASE_TEST_URL to
// NEXT_PUBLIC_SUPABASE_URL for this, and aliases "server-only" to its empty
// module so worker.ts can load outside a server bundle. worker-target.ts
// refuses the app's project under NODE_ENV=test before any request, and
// scripts/supabase-test-target.mjs refuses a test key that isn't a secret
// key or is the app's.
//
// The only file besides the route that may import the worker
// (tests/unit/worker-boundary.test.ts).

import type { ProviderPair } from "@/lib/extraction/delivery";
import { processOneDelivery, type WorkerResult } from "@/lib/extraction/worker";
import { SUPABASE_TEST_URL } from "./supabase-target";

export function runLocalWorker(providers: ProviderPair): Promise<WorkerResult> {
  if (process.env.NODE_ENV !== "test") throw new Error("the local runner runs only under Vitest");
  // the checked test project, and nothing else
  if (process.env.NEXT_PUBLIC_SUPABASE_URL !== SUPABASE_TEST_URL) {
    throw new Error("the local runner's Supabase URL is not the checked test project's");
  }
  return processOneDelivery({ providers: () => providers });
}

// For the guard test only: the worker itself, pointed at `url` without the
// runner's own check, to prove that worker-target.ts refuses the app's
// project before any request. The caller stubs fetch, so nothing could
// leave even if the guard failed.
export async function runWorkerPointedAt(url: string, providers: ProviderPair): Promise<WorkerResult> {
  if (process.env.NODE_ENV !== "test") throw new Error("the local runner runs only under Vitest");
  const saved = process.env.NEXT_PUBLIC_SUPABASE_URL;
  process.env.NEXT_PUBLIC_SUPABASE_URL = url;
  try {
    return await processOneDelivery({ providers: () => providers });
  } finally {
    process.env.NEXT_PUBLIC_SUPABASE_URL = saved;
  }
}
