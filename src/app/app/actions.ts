"use server";

import { redirect } from "next/navigation";
import type { FormState } from "@/app/auth/actions";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

// Same rule as the tenants.slug check constraint.
const SLUG_PATTERN = /^[a-z0-9-]{3,48}$/;

export async function createTenant(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  await requireUser();

  const name = String(formData.get("name") ?? "").trim();
  const slug = String(formData.get("slug") ?? "").trim().toLowerCase();

  if (!name) return { error: "Name is required." };
  if (!SLUG_PATTERN.test(slug)) {
    return {
      error: "Slug must be 3 to 48 characters: lowercase letters, numbers and hyphens.",
    };
  }

  const supabase = await createClient();
  // Inserts the tenant and the caller's owner membership in one transaction.
  const { data, error } = await supabase.rpc("create_tenant", {
    p_name: name,
    p_slug: slug,
  });

  if (error) {
    if (error.code === "23505") return { error: "That slug is already taken." };
    return { error: error.message };
  }

  const tenant = data as { id: string };
  redirect(`/app?tenant=${tenant.id}`);
}
