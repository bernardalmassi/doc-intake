import type { Metadata } from "next";
import Link from "next/link";
import { MAIN_ID, SiteHeader } from "./components/site-header";
import { formRowClass, formWidthClass, linkClass, pageClass, pageTitleClass, textTargetClass } from "./ui";

// Its own title, so a 404 isn't mistaken for the page that was asked for.
export const metadata: Metadata = { title: "Page not found" };

// Rendered by notFound() and for any unmatched address. The organization
// page calls it both for an organization that doesn't exist and for one the
// user isn't a member of, so the two cases look identical: one sentence
// covers both, and nothing says which it was.
//
// The error page's register: the title, then ruled rows with a label in the
// 11rem column, closed by a rule. Nothing can be retried here, so there is
// no primary action and no signal; the way back is a link, as sign-in's
// last row is.
export default function NotFound() {
  return (
    <>
      <SiteHeader />
      <main id={MAIN_ID} className={pageClass}>
        <h1 className={pageTitleClass}>Page not found</h1>
        <div className={`mt-8 ${formWidthClass} border-b border-ink`}>
          <div className={formRowClass}>
            <p className="label md:pt-1.5">What happened</p>
            <p className="min-w-0">
              This page doesn’t exist, or you don’t have access to it. An organization’s page opens only for
              its members.
            </p>
          </div>
          <div className={formRowClass}>
            <p className="label md:pt-1.5">Instead</p>
            <p className="min-w-0">
              <Link href="/app" className={`${linkClass} ${textTargetClass} inline-block`}>
                Back to your organizations
              </Link>
            </p>
          </div>
        </div>
      </main>
    </>
  );
}
