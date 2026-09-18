import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { signIn } from "@/app/auth/actions";
import { CredentialsForm } from "@/app/auth/credentials-form";
import { SiteHeader } from "@/app/components/site-header";
import { linkClass, pageClass, pageTitleClass } from "@/app/ui";
import { getCurrentUser } from "@/lib/auth";
import { ConfirmLinkNotice } from "./confirm-link-notice";

export const metadata: Metadata = { title: "Sign in · doc-intake" };

export default async function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  if (await getCurrentUser()) redirect("/app");

  const { error } = await searchParams;

  return (
    <>
      <SiteHeader />
      <main className={pageClass}>
        <div className="max-w-sm">
          <h1 className={pageTitleClass}>Sign in</h1>
          {error === "confirm" && <ConfirmLinkNotice />}
          <CredentialsForm mode="sign-in" action={signIn} />
          <p className="mt-8 text-muted">
            No account yet?{" "}
            <Link href="/sign-up" className={linkClass}>
              Create an account
            </Link>
          </p>
        </div>
      </main>
    </>
  );
}
