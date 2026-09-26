import Link from "next/link";
import { MAIN_ID, SiteHeader } from "@/app/components/site-header";
import { formRowClass, formWidthClass, linkClass, pageClass, textTargetClass } from "@/app/ui";

// Everything /sign-up renders around its form. Split from page.tsx so
// /dev/states can render it without a session check. The same register as
// /sign-in: the title hanging from the left edge, the form's ruled rows,
// and the way to the other form as the last row. The form prints the
// title, because it changes with the form's step: "Create an account",
// then "Check your email" once a confirmation link is sent.
export function SignUpView({ form }: { form: React.ReactNode }) {
  return (
    <>
      <SiteHeader />
      <main id={MAIN_ID} className={pageClass}>
        {form}
        <p className={`${formRowClass} ${formWidthClass} border-b`}>
          <span className="label md:pt-1.5">
            Have an account<span className="sr-only">?</span>
          </span>
          <span>
            <Link href="/sign-in" className={`${linkClass} ${textTargetClass} inline-block`}>
              Sign in
            </Link>
          </span>
        </p>
      </main>
    </>
  );
}
