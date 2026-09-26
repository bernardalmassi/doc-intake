// When the organization page asks the server for a fresh render while
// extractions are in flight (RefreshWhileExtracting). Pure: the refresh and
// the timer are passed in, so tests/unit/poller.test.ts drives it with fakes.
//
//   - It starts when a render shows a run queued or running, as the
//     database has it (extractionsInFlight in entries.ts).
//   - It stops only when two renders in a row show none: one render that
//     misses a run (read a moment before its enqueue committed, say) can't
//     end it.
//   - A refresh that fails (the network, the server) is skipped: nothing
//     changes, and the next one is tried after the usual wait. Nothing
//     navigates.
//   - Refreshes never overlap: the next is scheduled only once the one
//     before has settled, and only one is ever scheduled.

export type PollerOptions = {
  // one refresh; rejects if it failed
  refresh: () => Promise<void>;
  // runs `task` after `ms`; returns a function that cancels it
  schedule: (task: () => void, ms: number) => () => void;
  intervalMs: number;
};

export type Poller = {
  // a render of the page: whether it shows a run in flight, and something
  // that tells one render from the next (the server's request time)
  render(active: boolean, renderId: unknown): void;
  stop(): void;
  readonly polling: boolean;
};

export function createPoller({ refresh, schedule, intervalMs }: PollerOptions): Poller {
  let polling = false;
  // renders in a row that showed nothing in flight
  let idleRenders = 0;
  let lastRender: unknown = undefined;
  let seenRender = false;
  let refreshing = false;
  let cancel: (() => void) | null = null;

  function scheduleNext(): void {
    if (!polling || refreshing || cancel) return;
    cancel = schedule(tick, intervalMs);
  }

  async function tick(): Promise<void> {
    cancel = null;
    if (!polling || refreshing) return;
    refreshing = true;
    try {
      await refresh();
    } catch {
      // skipped: the page stays as it is, and the next refresh is tried
    } finally {
      refreshing = false;
    }
    scheduleNext();
  }

  return {
    render(active, renderId) {
      if (seenRender && renderId === lastRender) return;
      seenRender = true;
      lastRender = renderId;
      if (active) {
        idleRenders = 0;
        polling = true;
      } else if (polling) {
        idleRenders += 1;
        if (idleRenders >= 2) {
          polling = false;
          cancel?.();
          cancel = null;
        }
      }
      scheduleNext();
    },
    stop() {
      polling = false;
      cancel?.();
      cancel = null;
    },
    get polling() {
      return polling;
    },
  };
}
