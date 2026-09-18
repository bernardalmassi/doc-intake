import type { Metadata } from "next";
import Link from "next/link";
import { MAIN_ID, SiteHeader } from "./components/site-header";
import { pageClass, pageTitleClass, secondaryButtonClass } from "./ui";

// Its own title, so a 404 isn't mistaken for the page that was asked for.
export const metadata: Metadata = { title: "Page not found" };

// Rendered by notFound() and for any unmatched address. The organization
// page calls it both for an organization that doesn't exist and for one the
// user isn't a member of, so the two cases look identical: one sentence
// covers both, and nothing says which it was.
export default function NotFound() {
  return (
    <>
      <SiteHeader />
      <main id={MAIN_ID} className={pageClass}>
        <h1 className={pageTitleClass}>Page not found</h1>
        <p className="mt-2 max-w-prose text-muted">
          This page doesn&apos;t exist, or you don&apos;t have access to it.
        </p>
        <p className="mt-6">
          <Link href="/app" className={secondaryButtonClass}>
            Back to your organizations
          </Link>
        </p>
      </main>
    </>
  );
}
