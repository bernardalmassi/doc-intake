import Link from "next/link";
import { redirect } from "next/navigation";
import { signIn } from "@/app/auth/actions";
import { CredentialsForm } from "@/app/auth/credentials-form";
import { getCurrentUser } from "@/lib/auth";

export default async function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  if (await getCurrentUser()) redirect("/app");

  const { error } = await searchParams;

  return (
    <main className="p-8">
      <h1>Sign in</h1>
      {error === "confirm" && (
        <p role="alert">That confirmation link is invalid or expired. Try signing in, or sign up again.</p>
      )}
      <CredentialsForm
        action={signIn}
        submitLabel="Sign in"
        passwordAutoComplete="current-password"
      />
      <p>
        No account? <Link href="/sign-up">Sign up</Link>
      </p>
    </main>
  );
}
