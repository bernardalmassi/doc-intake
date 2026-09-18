"use client";

import { useLayoutEffect, useSyncExternalStore } from "react";
import { iconButtonClass } from "@/app/ui";
import { readStoredTheme, THEME_STORAGE_KEY, type Theme } from "./theme";

// The theme lives in one place, <html data-theme>, and this component
// reads it rather than keeping a copy. The server snapshot is "dark",
// which is what the server rendered, so hydration always matches; if the
// head script already switched to light, React re-renders with the real
// value right after.
function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  return () => observer.disconnect();
}

function getSnapshot(): Theme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function getServerSnapshot(): Theme {
  return "dark";
}

export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const next: Theme = theme === "dark" ? "light" : "dark";

  // Next's flash guide warns that in development React can reset <html> to
  // its JSX attributes (data-theme="dark") when it remounts the root,
  // undoing the head script. Put the stored choice back before paint.
  // Rewrites the same value when nothing was reset.
  useLayoutEffect(() => {
    const stored = readStoredTheme();
    if (stored) document.documentElement.dataset.theme = stored;
  }, []);

  function toggle() {
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Storage blocked: the switch still applies, for this page only.
    }
  }

  // Both icons are rendered and CSS shows the one for the current theme,
  // so the right icon is painted before hydration too. The icon is what
  // clicking switches to.
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      className={iconButtonClass}
    >
      <SunIcon className="in-data-[theme=light]:hidden" />
      <MoonIcon className="hidden in-data-[theme=light]:block" />
    </button>
  );
}

function SunIcon({ className }: { className: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
      className={className}
    >
      <circle cx="8" cy="8" r="2.75" />
      <path d="M8 1.75v1.5M8 12.75v1.5M1.75 8h1.5M12.75 8h1.5M3.58 3.58l1.06 1.06M11.36 11.36l1.06 1.06M3.58 12.42l1.06-1.06M11.36 4.64l1.06-1.06" />
    </svg>
  );
}

function MoonIcon({ className }: { className: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M13.9 9.6A6 6 0 1 1 6.4 2.1A6 6 0 0 0 13.9 9.6Z" />
    </svg>
  );
}
