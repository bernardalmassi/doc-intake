"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { FormState } from "@/app/form-state";
import { checkCredentials, classifyAuthError } from "@/lib/errors";
import { createClient } from "@/lib/supabase/server";

function readCredentials(formData: FormData) {
  return {
    email: String(formData.get("email") ?? "").trim(),
    password: String(formData.get("password") ?? ""),
  };
}

export async function signUp(_prev: FormState, formData: FormData): Promise<FormState> {
  const { email, password } = readCredentials(formData);
  const invalid = checkCredentials(email, password, "sign_up");
  if (invalid) return { error: invalid };

  // Server Actions reject requests whose Origin doesn't match the host, so
  // this is our own origin.
  const origin = (await headers()).get("origin");
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: origin ? { emailRedirectTo: `${origin}/auth/confirm` } : undefined,
  });
  if (error) return { error: classifyAuthError(error, "signUp") };

  // No session means the project requires email confirmation.
  if (!data.session) {
    return { message: "Check your email and open the confirmation link to finish signing up." };
  }

  redirect("/app");
}

export async function signIn(_prev: FormState, formData: FormData): Promise<FormState> {
  const { email, password } = readCredentials(formData);
  const invalid = checkCredentials(email, password, "sign_in");
  if (invalid) return { error: invalid };

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { error: classifyAuthError(error, "signInWithPassword") };

  redirect("/app");
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/sign-in");
}
