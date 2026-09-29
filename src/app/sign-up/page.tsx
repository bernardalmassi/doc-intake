import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { signUp } from "@/app/auth/actions";
import { CredentialsForm } from "@/app/auth/credentials-form";
import { getCurrentUser } from "@/lib/auth";
import { SignUpView } from "./sign-up-view";

export const metadata: Metadata = { title: "Create an account" };

export default async function SignUpPage() {
  if (await getCurrentUser()) redirect("/app");

  return <SignUpView form={<CredentialsForm mode="sign-up" action={signUp} />} />;
}
