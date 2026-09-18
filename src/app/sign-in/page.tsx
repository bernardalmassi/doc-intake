import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { signIn } from "@/app/auth/actions";
import { CredentialsForm } from "@/app/auth/credentials-form";
import { MAIN_ID, SiteHeader } from "@/app/components/site-header";
import { linkClass, pageClass, pageTitleClass, textTargetClass } from "@/app/ui";
import { getCurrentUser } from "@/lib/auth";
import { isErrorCode } from "@/lib/errors";
import { ConfirmLinkNotice } from "./confirm-link-notice";

export const metadata: Metadata = { title: "Sign in" };

export default async function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  if (await getCurrentUser()) redirect("/app");

  // /auth/confirm puts an error code here. Anything else in the address,
  // including a code this build doesn't know, shows nothing.
  const { error } = await searchParams;
  const confirmError = isErrorCode(error) ? error : null;

  return (
    <>
      <SiteHeader />
      <main id={MAIN_ID} className={pageClass}>
        <div className="max-w-sm">
          <h1 className={pageTitleClass}>Sign in</h1>
          {confirmError && <ConfirmLinkNotice code={confirmError} />}
          <CredentialsForm mode="sign-in" action={signIn} />
          <p className="mt-8 text-muted">
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
