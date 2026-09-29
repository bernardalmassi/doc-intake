// When a run in flight must have ended, from its own timestamps and the
// config: the one place these bounds are computed. The organization page
// uses overdueAt (entries.ts); tests/unit/deadlines.test.ts computes them.
// No clock is read here: the caller says what time it is.
//
// What ends a run in flight (SECURITY.md, "Deadlines: the sweep and the
// reaper"):
//   - the sweep, every minute: a queued run once it is older than
//     staleRunMinutes; a claimed run once its message's visibility timeout
//     has passed; a run opened by the old path once it is older than
//     staleRunMinutes. Each within a tick, plus the sweep's wait for the
//     run's locks (its lock_timeout).
//   - the claim: a queued run older than staleRunMinutes is expired, never
//     started.
//   - an enqueue of the same document (the reaper): a run whose
//     claimed_at, or else started_at, is older than staleRunMinutes.

import {
  CLAIM_TIMEOUT_MS,
  EXTRACTION_LIMITS,
  SWEEP_INTERVAL_MS,
  SWEEP_LOCK_TIMEOUT_MS,
} from "./config";

export type RunTimes = {
  status: string;
  // when the run was enqueued (or opened, on the old path)
  started_at: string;
  // when a worker claimed it; null while queued, and for the old path
  claimed_at?: string | null;
};

const STALE_MS = EXTRACTION_LIMITS.staleRunMinutes * 60_000;
const VISIBILITY_MS = EXTRACTION_LIMITS.workerVisibilitySeconds * 1000;
// a tick of the sweep, and its wait for the run's locks
const SWEEP_SLACK_MS = SWEEP_INTERVAL_MS + SWEEP_LOCK_TIMEOUT_MS;

export function inFlight(run: Pick<RunTimes, "status">): boolean {
  return run.status === "queued" || run.status === "running";
}

// The latest the sweep ends this run, if it runs every minute (epoch ms);
// null for a run not in flight. A claimed run's message is read during its
// claim, which lasts at most CLAIM_TIMEOUT_MS, and stays hidden for the
// visibility timeout from then.
export function sweepEndsBy(run: RunTimes): number | null {
  if (!inFlight(run)) return null;
  if (run.status === "running" && run.claimed_at) {
    return Date.parse(run.claimed_at) + CLAIM_TIMEOUT_MS + VISIBILITY_MS + SWEEP_SLACK_MS;
  }
  // queued, or running on the old path
  return Date.parse(run.started_at) + STALE_MS + SWEEP_SLACK_MS;
}

// From when an enqueue of the run's document ends it instead of refusing
// ("already running") (epoch ms); null for a run not in flight.
export function reapableFrom(run: RunTimes): number | null {
  if (!inFlight(run)) return null;
  return Date.parse(run.claimed_at ?? run.started_at) + STALE_MS;
}

// From when the page treats a run it shows in flight as overdue (epoch
// ms): past both, the sweep should have ended it and an enqueue of its
// document will, with a tick's margin for the clocks of the host and the
// database. Then the page stops polling for it and gives Extract back,
// whose enqueue ends it. Null for a run not in flight.
export function overdueAt(run: RunTimes): number | null {
  const sweep = sweepEndsBy(run);
  const reap = reapableFrom(run);
  if (sweep === null || reap === null) return null;
  return Math.max(sweep, reap) + SWEEP_INTERVAL_MS;
}

export function isOverdue(run: RunTimes, now: number): boolean {
  const at = overdueAt(run);
  return at !== null && now >= at;
}
