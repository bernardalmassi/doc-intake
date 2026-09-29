import Link from "next/link";
import type { Ref } from "react";
import { MAIN_ID, SiteHeader } from "./components/site-header";
import {
  buttonClass,
  formRowClass,
  formWidthClass,
  hintClass,
  linkClass,
  pageClass,
  pageTitleClass,
  textTargetClass,
} from "./ui";

// What the error page shows. Split from ErrorPage (error.tsx), which logs the
// error and moves focus, so /dev/states can render it without an error.
//
// The sign-in page's register: the title hangs from the left edge, then
// ruled rows with a label in the 11rem column: what happened, what to do
// (Try again, the view's one primary action and its only signal), the way
// back as a link, as sign-in's last row is, and the reference when there
// is one, closed by a rule. No icon, no tinted box: the words say it.
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
          This page didn’t load
        </h1>
        <div className={`mt-8 ${formWidthClass} border-b border-ink`}>
          <div className={formRowClass}>
            <p className="label md:pt-1.5">What happened</p>
            <p className="min-w-0">
              Part of it failed before it could be shown. It’s usually a brief problem reaching the
              database, so trying again often works.
            </p>
          </div>
          <div className={formRowClass}>
            <p className="label md:pt-3">What to do</p>
            <div className="min-w-0">
              <button type="button" onClick={onRetry} className={buttonClass}>
                Try again
              </button>
            </div>
          </div>
          <div className={formRowClass}>
            <p className="label md:pt-1.5">Instead</p>
            <p className="min-w-0">
              <Link href="/app" className={`${linkClass} ${textTargetClass} inline-block`}>
                Back to your organizations
              </Link>
            </p>
          </div>
          {digest && (
            <div className={formRowClass}>
              <p className="label md:pt-1.5">Reference</p>
              <div className="min-w-0">
                <p className="[overflow-wrap:anywhere]">{digest}</p>
                <p className={`mt-1 ${hintClass}`}>
                  The same number is in the server’s log. Quote it if you report this.
                </p>
              </div>
            </div>
          )}
        </div>
      </main>
    </>
  );
}
