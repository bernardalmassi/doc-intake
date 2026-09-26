"use client";

import { useLinkStatus } from "next/link";
import { createContext, useContext } from "react";
import { useFormStatus } from "react-dom";
import { secondaryButtonClass } from "@/app/ui";

// Pending states that last only while a navigation or a form submission is
// in flight, said in words (no spinner: DESIGN.md allows no looping
// motion). /dev/states wraps a screen in PreviewPending to hold one of
// them on (a link by its href, or "sign-out"), so it can be seen and
// captured; everywhere else the context is null and only the real status
// counts.

const Pending = createContext<string | null>(null);

export function PreviewPending({ target, children }: { target: string; children: React.ReactNode }) {
  return <Pending value={target}>{children}</Pending>;
}

// Inside a <Link>: "Opening…" after the link's words from the click until
// the next page has arrived. /app and /app/[slug] are dynamic and have no
// loading.tsx, so nothing is prefetched and the page the click came from
// stays up while the next one renders: without this, a click on an
// organization says nothing for as long as its queries take. An
// inline-block, so the link's underline doesn't run under it; hidden from
// assistive technology, which hears the new page's title when it arrives.
// href is the link's own, for the preview only.
export function OpeningHint({ href }: { href: string }) {
  const { pending } = useLinkStatus();
  const preview = useContext(Pending) === href;
  if (!pending && !preview) return null;
  return (
    <span aria-hidden="true" className="label ml-3 inline-block align-[0.1em] leading-none no-underline">
      Opening…
    </span>
  );
}

// Sign out, in the header of every signed-in page. The action signs out on
// the server and then redirects, which takes a moment; while it runs the
// button is the landing's dotted box with "Signing out…", as every pending
// submit is in the app, and a second click is dropped. aria-disabled rather
// than disabled, so a keyboard user's focus stays on it.
export function SignOutButton() {
  const { pending: submitting } = useFormStatus();
  const preview = useContext(Pending) === "sign-out";
  const pending = submitting || preview;
  return (
    <>
      {/* A label change on the focused button isn't reliably announced. */}
      <span role="status" className="sr-only">
        {pending ? "Signing out…" : ""}
      </span>
      <button
        type="submit"
        aria-disabled={pending || undefined}
        onClick={(event) => {
          if (pending) event.preventDefault();
        }}
        className={`${secondaryButtonClass} aria-disabled:cursor-not-allowed aria-disabled:border-dotted aria-disabled:bg-paper aria-disabled:text-ink`}
      >
        {pending ? "Signing out…" : "Sign out"}
      </button>
    </>
  );
}
