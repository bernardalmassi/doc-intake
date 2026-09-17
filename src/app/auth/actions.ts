"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { MIN_PASSWORD_LENGTH } from "@/lib/password";
import { createClient } from "@/lib/supabase/server";

export type FormState = { error?: string; message?: string };

function readCredentials(formData: FormData) {
  return {
    email: String(formData.get("email") ?? "").trim(),
    password: String(formData.get("password") ?? ""),
  };
}

// Supabase reports a rejected password as a weak_password error with one
// or more reasons. Spell them out so the user knows what to change.
function describeWeakPassword(reasons: string[], fallback: string) {
  const parts: (string | null)[] = reasons.map((reason) => {
    switch (reason) {
      case "length":
        return `be at least ${MIN_PASSWORD_LENGTH} characters`;
      case "characters":
        return "include the required character types";
      case "pwned":
        return "not appear in known data breaches";
      default:
        return null;
    }
  });
  const known = parts.filter((p): p is string => p !== null);
  if (known.length === 0) return fallback;
  return `Password rejected: it must ${known.join(" and ")}.`;
}

export async function signUp(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { email, password } = readCredentials(formData);
  if (!email || !password) {
    return { error: "Email and password are required." };
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { error: describeWeakPassword(["length"], "Password is too short.") };
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
    // AuthWeakPasswordError carries the reasons; the type isn't re-exported
    // by supabase-js, so read them structurally.
    const reasons = (error as { reasons?: unknown }).reasons;
    if (error.code === "weak_password" || Array.isArray(reasons)) {
      return {
        error: describeWeakPassword(Array.isArray(reasons) ? reasons : [], error.message),
      };
    }
    return { error: error.message };
  }

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
