import Link from "next/link";
import { MAIN_ID, SiteHeader } from "@/app/components/site-header";
import { linkClass, pageClass, pageTitleClass, textTargetClass } from "@/app/ui";

// Everything /sign-up renders around its form. Split from page.tsx so
// /dev/states can render it without a session check.
export function SignUpView({ form }: { form: React.ReactNode }) {
  return (
    <>
      <SiteHeader />
      <main id={MAIN_ID} className={pageClass}>
        <div className="max-w-sm">
          <h1 className={pageTitleClass}>Create an account</h1>
          {form}
          <p className="mt-8 text-ink">
            Already have an account?{" "}
            <Link href="/sign-in" className={`${linkClass} ${textTargetClass} inline-block`}>
              Sign in
            </Link>
          </p>
        </div>
      </main>
    </>
  );
}
