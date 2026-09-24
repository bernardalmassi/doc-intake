"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

export const REFRESH_INTERVAL_MS = 3000;

// Extract only queues a run; the worker finishes it in its own request. So
// while any document is extracting (shouldPoll in entries.ts), the page asks
// the server for a fresh render every few seconds, and the run's queued,
// running and final states show up without a reload. Nothing is rendered,
// and the interval is cleared as soon as nothing is extracting.
export function RefreshWhileExtracting({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => router.refresh(), REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [active, router]);
  return null;
}
