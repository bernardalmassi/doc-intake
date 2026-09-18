"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { FormState } from "@/app/form-state";
import { failureFields } from "@/app/log-fields";
import { checkCredentials, classifyAuthError } from "@/lib/errors";
import { log } from "@/lib/log";
import { createClient } from "@/lib/supabase/server";

// Log lines carry ids, codes and statuses only: never the email address,
// the password, or Supabase's message.

function readCredentials(formData: FormData) {
  return {
    email: String(formData.get("email") ?? "").trim(),
    password: String(formData.get("password") ?? ""),
  };
}

export async function signUp(_prev: FormState, formData: FormData): Promise<FormState> {
  const { email, password } = readCredentials(formData);
  const invalid = checkCredentials(email, password, "sign_up");
  if (invalid) {
    log.info("auth.sign_up_refused", { error_code: invalid });
    return { error: invalid };
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
  if (error) {
    const code = classifyAuthError(error, "signUp");
    log.warn("auth.sign_up_refused", { error_code: code, ...failureFields(error, error.status) });
    return { error: code };
  }

  log.info("auth.signed_up", { user_id: data.user?.id });
  // No session means the project requires email confirmation.
  if (!data.session) {
    return { message: "Check your email and open the confirmation link to finish signing up." };
  }

  redirect("/app");
}

export async function signIn(_prev: FormState, formData: FormData): Promise<FormState> {
  const { email, password } = readCredentials(formData);
  const invalid = checkCredentials(email, password, "sign_in");
  if (invalid) {
    log.info("auth.sign_in_refused", { error_code: invalid });
    return { error: invalid };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    const code = classifyAuthError(error, "signInWithPassword");
    log.warn("auth.sign_in_refused", { error_code: code, ...failureFields(error, error.status) });
    return { error: code };
  }

  log.info("auth.signed_in", { user_id: data.user?.id });
  redirect("/app");
}

export async function signOut() {
  const supabase = await createClient();
  const { error } = await supabase.auth.signOut();
  // The visitor goes to the sign-in page either way, as before; the line
  // records whether Supabase accepted the sign-out.
  if (error) {
    log.warn("auth.signed_out", { error_code: classifyAuthError(error, "signOut"), ...failureFields(error, error.status) });
  } else {
    log.info("auth.signed_out");
  }
  redirect("/sign-in");
}
