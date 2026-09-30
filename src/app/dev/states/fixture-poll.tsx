"use client";

import { useEffect, useState } from "react";

// A stand-in for the organization page's refresh while it polls: shows
// each frame in turn, intervalMs apart, in the same place, as the page's
// refresh does with the server's next render. Everything the frames share
// (open lines, an armed Delete, focus) must come through a swap unchanged.
export function FixturePoll({ frames, intervalMs }: { frames: React.ReactNode[]; intervalMs: number }) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (index >= frames.length - 1) return;
    const timer = setTimeout(() => setIndex(index + 1), intervalMs);
    return () => clearTimeout(timer);
  }, [index, frames.length, intervalMs]);
  return <div data-poll-frame={index}>{frames[index]}</div>;
}
