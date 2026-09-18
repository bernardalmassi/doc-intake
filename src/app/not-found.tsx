import Link from "next/link";
import { SiteHeader } from "./components/site-header";
import { linkClass, pageClass, pageTitleClass } from "./ui";

// Rendered by notFound(). The tenant page calls it both for a slug that
// doesn't exist and for one the user isn't a member of, so the two cases
// look identical.
export default function NotFound() {
  return (
    <>
      <SiteHeader />
      <main className={pageClass}>
        <h1 className={pageTitleClass}>Not found</h1>
        <p className="mt-2 text-muted">There is nothing at this address.</p>
        <p className="mt-4">
          <Link href="/app" className={linkClass}>
            Back to your organizations
          </Link>
        </p>
      </main>
    </>
  );
}
