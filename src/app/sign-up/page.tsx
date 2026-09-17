import Link from "next/link";
import { redirect } from "next/navigation";
import { signUp } from "@/app/auth/actions";
import { CredentialsForm } from "@/app/auth/credentials-form";
import { getCurrentUser } from "@/lib/auth";

export default async function SignUpPage() {
  if (await getCurrentUser()) redirect("/app");

  return (
    <main className="p-8">
      <h1>Sign up</h1>
      <CredentialsForm
        action={signUp}
        submitLabel="Sign up"
        passwordAutoComplete="new-password"
      />
      <p>
        Already have an account? <Link href="/sign-in">Sign in</Link>
      </p>
    </main>
  );
}
