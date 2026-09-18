"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { FormState } from "@/app/form-state";
import { requireUser } from "@/lib/auth";
import {
  checkFilename,
  checkTenantInput,
  classifyDatabaseError,
  classifyStorageError,
  type ErrorCode,
} from "@/lib/errors";
import { createClient } from "@/lib/supabase/server";

// Every failure below is returned as a code from src/lib/errors.ts, never as
// the text Postgres or Storage wrote; the page shows the catalog's message.

export async function createTenant(_prev: FormState, formData: FormData): Promise<FormState> {
  await requireUser();

  const name = String(formData.get("name") ?? "").trim();
  const slug = String(formData.get("slug") ?? "").trim().toLowerCase();
  const invalid = checkTenantInput(name, slug);
  if (invalid) return { error: invalid };

  const supabase = await createClient();
  // Inserts the tenant and the caller's owner membership in one transaction.
  const { error, status } = await supabase.rpc("create_tenant", { p_name: name, p_slug: slug });
  if (error) return { error: classifyDatabaseError({ ...error, status }, "create_tenant") };

  redirect(`/app/${slug}`);
}

export type CreatedDocument = { id: string; storagePath: string; error?: undefined } | { error: ErrorCode };

// Step 1 of an upload: the row. The database fills in everything except
// tenant_id and filename (status 'uploading', uploaded_by = auth.uid(),
// storage_path = <tenant_id>/<id>). The browser then uploads to storagePath
// itself and calls complete_document_upload; file bytes never pass through
// a Server Action.
export async function createDocument(input: { tenantId: string; filename: string }): Promise<CreatedDocument> {
  await requireUser();

  const filename = input.filename.trim();
  const invalid = checkFilename(filename);
  if (invalid) return { error: invalid };

  const supabase = await createClient();
  const { data, error, status } = await supabase
    .from("documents")
    .insert({ tenant_id: input.tenantId, filename })
    .select("id, storage_path")
    .single();
  if (error) return { error: classifyDatabaseError({ ...error, status }, "insert_document") };

  return { id: data.id as string, storagePath: data.storage_path as string };
}

// Admin only, enforced by RLS on both the object and the row. The file goes
// first: a row can't be deleted while its file exists. Storage's remove
// reports success even when RLS hid the object, so a delete that matches no
// row is what says the caller isn't an admin, and the row delete's trigger
// is what surfaces a file that's still there.
export async function deleteDocument(_prev: FormState, formData: FormData): Promise<FormState> {
  await requireUser();

  const id = String(formData.get("id") ?? "");
  const slug = String(formData.get("slug") ?? "");
  if (!id || !slug) return { error: "document.not_found" };

  const supabase = await createClient();

  const lookup = await supabase.from("documents").select("storage_path").eq("id", id).maybeSingle();
  if (lookup.error) return { error: classifyDatabaseError({ ...lookup.error, status: lookup.status }, "select_document") };
  if (!lookup.data) return { error: "document.not_found" };

  const removed = await supabase.storage.from("documents").remove([lookup.data.storage_path]);
  if (removed.error) return { error: classifyStorageError(removed.error, "remove") };

  const deleted = await supabase.from("documents").delete().eq("id", id).select("id");
  if (deleted.error) {
    return { error: classifyDatabaseError({ ...deleted.error, status: deleted.status }, "delete_document") };
  }
  if (!deleted.data || deleted.data.length === 0) return { error: "document.delete_not_allowed" };

  revalidatePath(`/app/${slug}`);
  return {};
}
