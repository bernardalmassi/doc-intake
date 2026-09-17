"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export type FormState = { error?: string; message?: string };

function readCredentials(formData: FormData) {
  return {
    email: String(formData.get("email") ?? "").trim(),
    password: String(formData.get("password") ?? ""),
  };
}

export async function signUp(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { email, password } = readCredentials(formData);
  if (!email || !password) {
    return { error: "Email and password are required." };
  }

  // Server Actions reject requests whose Origin doesn't match the host, so
  // this is our own origin.
  const origin = (await headers()).get("origin");
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: origin ? { emailRedirectTo: `${origin}/auth/confirm` } : undefined,
  });

  if (error) return { error: error.message };

  // No session means the project requires email confirmation.
  if (!data.session) {
    return { message: "Check your email to confirm your account, then sign in." };
  }

  redirect("/app");
}

export async function signIn(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { email, password } = readCredentials(formData);
  if (!email || !password) {
    return { error: "Email and password are required." };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { error: error.message };

  redirect("/app");
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/sign-in");
}
