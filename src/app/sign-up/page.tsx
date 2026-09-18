import Link from "next/link";
import { redirect } from "next/navigation";
import { signUp } from "@/app/auth/actions";
import { CredentialsForm } from "@/app/auth/credentials-form";
import { SiteHeader } from "@/app/components/site-header";
import { linkClass, pageClass, pageTitleClass } from "@/app/ui";
import { getCurrentUser } from "@/lib/auth";

export default async function SignUpPage() {
  if (await getCurrentUser()) redirect("/app");

  return (
    <>
      <SiteHeader />
      <main className={pageClass}>
        <h1 className={pageTitleClass}>Sign up</h1>
        <CredentialsForm mode="sign-up" action={signUp} />
        <p className="mt-6 text-muted">
          Already have an account?{" "}
          <Link href="/sign-in" className={linkClass}>
            Sign in
          </Link>
        </p>
      </main>
    </>
  );
}
