import Link from "next/link";
import { MAIN_ID, SiteHeader } from "@/app/components/site-header";
import { linkClass, pageClass, pageTitleClass, textTargetClass } from "@/app/ui";
import type { ErrorCode } from "@/lib/errors";
import { ConfirmLinkNotice } from "./confirm-link-notice";

// Everything /sign-in renders, from what the page worked out: the error
// code /auth/confirm put in the address (already checked by isErrorCode)
// and the form. Split from page.tsx so /dev/states can render it without a
// session check.
export function SignInView({ confirmError, form }: { confirmError: ErrorCode | null; form: React.ReactNode }) {
  return (
    <>
      <SiteHeader />
      <main id={MAIN_ID} className={pageClass}>
        <div className="max-w-sm">
          <h1 className={pageTitleClass}>Sign in</h1>
          {confirmError && <ConfirmLinkNotice code={confirmError} />}
          {form}
          <p className="mt-8 text-ink">
            No account yet?{" "}
            <Link href="/sign-up" className={`${linkClass} ${textTargetClass} inline-block`}>
              Create an account
            </Link>
          </p>
        </div>
      </main>
    </>
  );
}
