import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { signUp } from "@/app/auth/actions";
import { CredentialsForm } from "@/app/auth/credentials-form";
import { SiteHeader } from "@/app/components/site-header";
import { linkClass, pageClass, pageTitleClass } from "@/app/ui";
import { getCurrentUser } from "@/lib/auth";

export const metadata: Metadata = { title: "Create an account · doc-intake" };

export default async function SignUpPage() {
  if (await getCurrentUser()) redirect("/app");

  return (
    <>
      <SiteHeader />
      <main className={pageClass}>
        <div className="max-w-sm">
          <h1 className={pageTitleClass}>Create an account</h1>
          <CredentialsForm mode="sign-up" action={signUp} />
          <p className="mt-8 text-muted">
            Already have an account?{" "}
            <Link href="/sign-in" className={linkClass}>
              Sign in
            </Link>
          </p>
        </div>
      </main>
    </>
  );
}
