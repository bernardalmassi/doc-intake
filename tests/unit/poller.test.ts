// The organization page's polling (src/app/app/[slug]/poller.ts) with a
// fake refresh and a fake timer: it starts when a render shows a run in
// flight, stops only when two renders in a row show none, skips a refresh
// that fails and tries again after the usual wait, and never has two
// refreshes going at once or two scheduled.
//
// Needs no database and no browser.

import { describe, expect, it } from "vitest";
import { createPoller } from "@/app/app/[slug]/poller";

// A timer you run by hand, and a refresh you settle by hand.
function harness() {
  const scheduled: { task: () => void; ms: number; cancelled: boolean }[] = [];
  const refreshes: { resolve: () => void; reject: (error: Error) => void }[] = [];
  const poller = createPoller({
    refresh: () => new Promise<void>((resolve, reject) => refreshes.push({ resolve, reject })),
    schedule: (task, ms) => {
      const entry = { task, ms, cancelled: false };
      scheduled.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    intervalMs: 3000,
  });
  const pending = () => scheduled.filter((s) => !s.cancelled);
  // runs the one scheduled task, if any
  const fire = async () => {
    const next = pending();
    expect(next.length).toBeLessThanOrEqual(1);
    if (next.length === 0) return false;
    next[0].cancelled = true;
    next[0].task();
    await Promise.resolve();
    return true;
  };
  const settle = async (ok = true) => {
    const refresh = refreshes.shift();
    if (!refresh) throw new Error("no refresh in progress");
    if (ok) refresh.resolve();
    else refresh.reject(new Error("fetch failed"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { poller, scheduled, refreshes, pending, fire, settle };
}

describe("the page's polling", () => {
  it("doesn't start while no render shows a run in flight", async () => {
    const h = harness();
    h.poller.render(false, 1);
    h.poller.render(false, 2);
    expect(h.poller.polling).toBe(false);
    expect(h.pending()).toHaveLength(0);
  });

  it("starts when a render shows a run in flight, refreshing every interval", async () => {
    const h = harness();
    h.poller.render(true, 1);
    expect(h.poller.polling).toBe(true);
    expect(h.pending()).toHaveLength(1);
    expect(h.pending()[0].ms).toBe(3000);
    await h.fire();
    expect(h.refreshes).toHaveLength(1);
  });

  it("stops only when two renders in a row show nothing in flight", async () => {
    const h = harness();
    h.poller.render(true, 1);
    await h.fire();
    h.poller.render(false, 2); // one render says done
    await h.settle();
    expect(h.poller.polling).toBe(true);
    expect(h.pending()).toHaveLength(1);
    await h.fire();
    h.poller.render(true, 3); // it wasn't: a run was still in flight
    await h.settle();
    await h.fire();
    h.poller.render(false, 4);
    await h.settle();
    await h.fire();
    h.poller.render(false, 5); // two in a row
    await h.settle();
    expect(h.poller.polling).toBe(false);
    expect(h.pending()).toHaveLength(0);
  });

  it("counts a render once, however often React re-renders it", async () => {
    const h = harness();
    h.poller.render(true, 1);
    h.poller.render(false, 2);
    h.poller.render(false, 2);
    h.poller.render(false, 2);
    expect(h.poller.polling).toBe(true);
  });

  it("skips a refresh that fails: nothing changes, and the next is tried after the usual wait", async () => {
    const h = harness();
    h.poller.render(true, 1);
    await h.fire();
    await h.settle(false);
    expect(h.poller.polling).toBe(true);
    expect(h.pending()).toHaveLength(1);
    expect(h.pending()[0].ms).toBe(3000);
    await h.fire();
    expect(h.refreshes).toHaveLength(1);
  });

  it("never runs two refreshes at once, or schedules a second while one is going", async () => {
    const h = harness();
    h.poller.render(true, 1);
    await h.fire();
    // renders arrive while the refresh is still going: nothing new is scheduled
    h.poller.render(true, 2);
    h.poller.render(true, 3);
    expect(h.pending()).toHaveLength(0);
    expect(h.refreshes).toHaveLength(1);
    await h.settle();
    // then exactly one
    expect(h.pending()).toHaveLength(1);
  });

  it("stops for good when the page goes", async () => {
    const h = harness();
    h.poller.render(true, 1);
    h.poller.stop();
    expect(h.pending()).toHaveLength(0);
    expect(await h.fire()).toBe(false);
  });
});
