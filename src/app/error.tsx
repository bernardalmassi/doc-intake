"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { MAIN_ID, SiteHeader } from "./components/site-header";
import { buttonClass, hintClass, pageClass, pageTitleClass, secondaryButtonClass } from "./ui";

// Any page that throws while rendering lands here instead of Next's
// generic error screen: a failed query, the database unreachable. In
// production a Server Component's message is replaced by a generic one and
// a digest, so the page says what the reader can do and shows the digest
// as a reference that matches the server log. The root layout is static
// and can't throw, so there is no global-error.
export default function ErrorPage({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    console.error(error);
  }, [error]);

  // The page the reader was on is gone; move focus here so a screen
  // reader announces what replaced it.
  useEffect(() => {
    heading.current?.focus();
  }, []);

  return (
    <>
      <SiteHeader />
      <main id={MAIN_ID} className={pageClass}>
        <h1 ref={heading} tabIndex={-1} className={pageTitleClass}>
          Something went wrong
        </h1>
        <p className="mt-2 max-w-prose text-muted">
          This page couldn&apos;t load. It&apos;s usually a brief problem reaching the database, so
          trying again often works.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <button type="button" onClick={() => retry()} className={buttonClass}>
            Try again
          </button>
          <Link href="/app" className={secondaryButtonClass}>
            Back to your organizations
          </Link>
        </div>
        {error.digest && <p className={`mt-6 ${hintClass}`}>Reference: {error.digest}</p>}
      </main>
    </>
  );
}
