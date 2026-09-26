import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { signIn } from "@/app/auth/actions";
import { CredentialsForm } from "@/app/auth/credentials-form";
import { getCurrentUser } from "@/lib/auth";
import { isErrorCode } from "@/lib/errors";
import { SignInView } from "./sign-in-view";

export const metadata: Metadata = { title: "Sign in" };

export default async function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  if (await getCurrentUser()) redirect("/app");

  // /auth/confirm puts an error code here. Anything else in the address,
  // including a code this build doesn't know, shows nothing.
  const { error } = await searchParams;
  const confirmError = isErrorCode(error) ? error : null;

  return <SignInView confirmError={confirmError} form={<CredentialsForm mode="sign-in" action={signIn} />} />;
}
