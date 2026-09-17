"use server";

import { revalidatePath } from "next/cache";
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
  const { error } = await supabase.rpc("create_tenant", {
    p_name: name,
    p_slug: slug,
  });

  if (error) {
    if (error.code === "23505") return { error: "That slug is already taken." };
    return { error: error.message };
  }

  redirect(`/app/${slug}`);
}

export type CreatedDocument =
  | { id: string; storagePath: string; error?: undefined }
  | { error: string };

// Step 1 of an upload: the row. The database fills in everything except
// tenant_id and filename (status 'uploading', uploaded_by = auth.uid(),
// storage_path = <tenant_id>/<id>). The browser then uploads to storagePath
// itself and calls complete_document_upload; file bytes never pass through
// a Server Action.
export async function createDocument(input: {
  tenantId: string;
  filename: string;
}): Promise<CreatedDocument> {
  await requireUser();

  const filename = input.filename.trim();
  if (!filename) return { error: "Filename is required." };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("documents")
    .insert({ tenant_id: input.tenantId, filename })
    .select("id, storage_path")
    .single();

  if (error) {
    // 42501: not a member of that tenant (RLS)
    if (error.code === "42501") return { error: "You can't upload to this organization." };
    // documents_filename_check
    if (error.code === "23514") {
      return { error: "Filename must be 1 to 255 characters with no control characters." };
    }
    return { error: error.message };
  }

  return { id: data.id as string, storagePath: data.storage_path as string };
}

// Admin only, enforced by RLS on both the object and the row. The file goes
// first: a row can't be deleted while its file exists. Storage's remove
// reports success even when RLS hid the object, so the row delete's
// trigger is what surfaces a file that's still there.
export async function deleteDocument(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  await requireUser();

  const id = String(formData.get("id") ?? "");
  const slug = String(formData.get("slug") ?? "");
  if (!id || !slug) return { error: "Missing document." };

  const supabase = await createClient();

  const { data: doc, error: lookupError } = await supabase
    .from("documents")
    .select("storage_path")
    .eq("id", id)
    .maybeSingle();
  if (lookupError) return { error: lookupError.message };
  if (!doc) return { error: "Document not found." };

  const removed = await supabase.storage.from("documents").remove([doc.storage_path]);
  if (removed.error) return { error: `Couldn't remove the file: ${removed.error.message}` };

  const { data: deleted, error: deleteError } = await supabase
    .from("documents")
    .delete()
    .eq("id", id)
    .select("id");
  if (deleteError) {
    if (deleteError.code === "55000") {
      return { error: "The file couldn't be removed. Only admins can delete documents." };
    }
    return { error: deleteError.message };
  }
  if (!deleted || deleted.length === 0) {
    return { error: "Only admins can delete documents." };
  }

  revalidatePath(`/app/${slug}`);
  return {};
}
