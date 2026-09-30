"use client";

import { useEffect, useRef } from "react";
import { refreshOrganizationPage } from "@/app/app/extract-action";
import { createPoller, type Poller } from "./poller";

export const REFRESH_INTERVAL_MS = 3000;

// Extract only queues a run; the worker finishes it in its own request. So
// while the page shows a run queued or running, it asks the server for a
// fresh render every few seconds, and the run's queued, running and final
// states show up without a reload (poller.ts has the rules: it stops when
// two renders in a row show nothing in flight, a failed refresh is skipped,
// refreshes never overlap). The refresh is a Server Action that re-renders
// the page (refreshOrganizationPage), not router.refresh(), which turns a
// failed fetch into a full navigation. Nothing is rendered.
export function RefreshWhileExtracting({ active, renderedAt }: { active: boolean; renderedAt: number }) {
  const poller = useRef<Poller | null>(null);

  useEffect(() => {
    const created = createPoller({
      refresh: async () => {
        const result = await refreshOrganizationPage();
        if (result.error) throw new Error(result.error);
      },
      schedule: (task, ms) => {
        const timer = setTimeout(task, ms);
        return () => clearTimeout(timer);
      },
      intervalMs: REFRESH_INTERVAL_MS,
    });
    poller.current = created;
    return () => {
      created.stop();
      poller.current = null;
    };
  }, []);

  useEffect(() => {
    poller.current?.render(active, renderedAt);
  }, [active, renderedAt]);

  return null;
}
