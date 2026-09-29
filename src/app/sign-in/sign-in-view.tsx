import Link from "next/link";
import { MAIN_ID, SiteHeader } from "@/app/components/site-header";
import { formRowClass, formWidthClass, linkClass, pageClass, pageTitleClass, textTargetClass } from "@/app/ui";
import type { ErrorCode } from "@/lib/errors";
import { ConfirmLinkNotice } from "./confirm-link-notice";

// Everything /sign-in renders, from what the page worked out: the error
// code /auth/confirm put in the address (already checked by isErrorCode)
// and the form. Split from page.tsx so /dev/states can render it without a
// session check.
//
// The title hangs from the left edge, as on the organization page; the
// form is a ruled register under it, and the way to the other form is its
// last row, closed by a rule. The right of the page stays empty.
export function SignInView({ confirmError, form }: { confirmError: ErrorCode | null; form: React.ReactNode }) {
  return (
    <>
      <SiteHeader />
      <main id={MAIN_ID} className={pageClass}>
        <h1 className={pageTitleClass}>Sign in</h1>
        {confirmError && <ConfirmLinkNotice code={confirmError} />}
        {form}
        <p className={`${formRowClass} ${formWidthClass} border-b`}>
          <span className="label md:pt-1.5">
            No account yet<span className="sr-only">?</span>
          </span>
          <span>
            <Link href="/sign-up" className={`${linkClass} ${textTargetClass} inline-block`}>
              Create an account
            </Link>
          </span>
        </p>
      </main>
    </>
  );
}
