import Link from "next/link";
import { redirect } from "next/navigation";
import { signIn } from "@/app/auth/actions";
import { CredentialsForm } from "@/app/auth/credentials-form";
import { errorClass, linkClass } from "@/app/ui";
import { getCurrentUser } from "@/lib/auth";

export default async function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  if (await getCurrentUser()) redirect("/app");

  const { error } = await searchParams;

  return (
    <main className="p-8">
      <h1 className="text-2xl font-semibold">Sign in</h1>
      {error === "confirm" && (
        <p role="alert" className={`mt-4 ${errorClass}`}>
          That confirmation link is invalid or expired. Try signing in, or sign up again.
        </p>
      )}
      <CredentialsForm
        action={signIn}
        submitLabel="Sign in"
        passwordAutoComplete="current-password"
      />
      <p className="mt-6 text-neutral-400">
        No account?{" "}
        <Link href="/sign-up" className={linkClass}>
          Sign up
        </Link>
      </p>
    </main>
  );
}
