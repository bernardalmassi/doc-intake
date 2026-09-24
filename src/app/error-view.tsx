import Link from "next/link";
import type { Ref } from "react";
import { MAIN_ID, SiteHeader } from "./components/site-header";
import { buttonClass, hintClass, pageClass, pageTitleClass, secondaryButtonClass } from "./ui";

// What the error page shows. Split from ErrorPage (error.tsx), which logs the
// error and moves focus, so /dev/states can render it without an error.
export function ErrorView({
  digest,
  onRetry,
  headingRef,
}: {
  digest: string | undefined;
  onRetry: () => void;
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  return (
    <>
      <SiteHeader />
      <main id={MAIN_ID} className={pageClass}>
        <h1 ref={headingRef} tabIndex={-1} className={pageTitleClass}>
          Something went wrong
        </h1>
        <p className="mt-2 max-w-prose text-muted">
          This page couldn&apos;t load. It&apos;s usually a brief problem reaching the database, so
          trying again often works.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <button type="button" onClick={onRetry} className={buttonClass}>
            Try again
          </button>
          <Link href="/app" className={secondaryButtonClass}>
            Back to your organizations
          </Link>
        </div>
        {digest && <p className={`mt-6 ${hintClass}`}>Reference: {digest}</p>}
      </main>
    </>
  );
}
