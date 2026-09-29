// When a run in flight must have ended (src/lib/extraction/deadlines.ts),
// computed here from the config and the run's own timestamps. The page's
// overdue bound must never come before the database's own: the sweep's
// deadline, and the moment an enqueue of the document would reap the run
// (so Extract, given back at the bound, ends the run instead of being
// refused). Needs no database.

import { describe, expect, it } from "vitest";
import {
  CLAIM_TIMEOUT_MS,
  EXTRACTION_LIMITS,
  SWEEP_INTERVAL_MS,
  SWEEP_LOCK_TIMEOUT_MS,
} from "@/lib/extraction/config";
import { inFlight, isOverdue, overdueAt, reapableFrom, sweepEndsBy } from "@/lib/extraction/deadlines";

const T0 = Date.parse("2026-09-29T12:00:00Z");
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();
const STALE = EXTRACTION_LIMITS.staleRunMinutes * 60;
const VISIBILITY = EXTRACTION_LIMITS.workerVisibilitySeconds;
const TICK = SWEEP_INTERVAL_MS / 1000;
const LOCK = SWEEP_LOCK_TIMEOUT_MS / 1000;
const CLAIM = CLAIM_TIMEOUT_MS / 1000;

const queued = { status: "queued", started_at: at(0), claimed_at: null };
// claimed nine minutes in, just short of the stale limit
const claimed = { status: "running", started_at: at(0), claimed_at: at(540) };
const oldPath = { status: "running", started_at: at(0), claimed_at: null };

describe("a run's deadlines", () => {
  it("in seconds from its enqueue: 10 min + a tick + the sweep's lock wait for a queued run, and so on", () => {
    expect([STALE, VISIBILITY, TICK, LOCK, CLAIM]).toEqual([600, 300, 60, 5, 5]);
    // the sweep's step (d) at its first tick past the stale limit
    expect(sweepEndsBy(queued)).toBe(T0 + (STALE + TICK + LOCK) * 1000);
    // step (a): the message is read during the claim and hidden from then
    expect(sweepEndsBy(claimed)).toBe(T0 + (540 + CLAIM + VISIBILITY + TICK + LOCK) * 1000);
    // step (c)
    expect(sweepEndsBy(oldPath)).toBe(T0 + (STALE + TICK + LOCK) * 1000);
    // the enqueue reaper measures from the claim, else the enqueue
    expect(reapableFrom(queued)).toBe(T0 + STALE * 1000);
    expect(reapableFrom(claimed)).toBe(T0 + (540 + STALE) * 1000);
    expect(reapableFrom(oldPath)).toBe(T0 + STALE * 1000);
  });

  it("make a run overdue on the page only once the database should have ended it and an enqueue would, plus a tick", () => {
    for (const run of [queued, claimed, oldPath]) {
      const overdue = overdueAt(run)!;
      expect(overdue).toBeGreaterThanOrEqual(sweepEndsBy(run)! + SWEEP_INTERVAL_MS);
      expect(overdue).toBeGreaterThanOrEqual(reapableFrom(run)! + SWEEP_INTERVAL_MS);
      expect(isOverdue(run, overdue - 1)).toBe(false);
      expect(isOverdue(run, overdue)).toBe(true);
    }
    // 12 min 5 s after a queued run's enqueue; 11 min after a claim
    expect(overdueAt(queued)).toBe(T0 + (STALE + TICK + LOCK + TICK) * 1000);
    expect(overdueAt(claimed)).toBe(T0 + (540 + STALE + TICK) * 1000);
  });

  it("don't apply to a run that has ended", () => {
    for (const status of ["succeeded", "failed"]) {
      const ended = { status, started_at: at(0), claimed_at: at(1) };
      expect(inFlight(ended)).toBe(false);
      expect([sweepEndsBy(ended), reapableFrom(ended), overdueAt(ended)]).toEqual([null, null, null]);
      expect(isOverdue(ended, T0 + 86_400_000)).toBe(false);
    }
  });
});
