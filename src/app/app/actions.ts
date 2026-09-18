"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { FormState } from "@/app/form-state";
import { failureFields } from "@/app/log-fields";
import { requireUser } from "@/lib/auth";
import {
  checkFilename,
  checkTenantInput,
  classifyDatabaseError,
  classifyStorageError,
  type ErrorCode,
} from "@/lib/errors";
import { log } from "@/lib/log";
import { createClient } from "@/lib/supabase/server";

// Every failure below is returned as a code from src/lib/errors.ts, never as
// the text Postgres or Storage wrote; the page shows the catalog's message.
// Each outcome is logged with ids, the code and the SQLSTATE or HTTP
// status: never a name, filename, slug or error message.

export async function createTenant(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const actionLog = log.with({ user_id: user.id });

  const name = String(formData.get("name") ?? "").trim();
  const slug = String(formData.get("slug") ?? "").trim().toLowerCase();
  const invalid = checkTenantInput(name, slug);
  if (invalid) {
    actionLog.info("tenant.create_refused", { error_code: invalid });
    return { error: invalid };
  }

  const supabase = await createClient();
  // Inserts the tenant and the caller's owner membership in one transaction.
  const { data, error, status } = await supabase.rpc("create_tenant", { p_name: name, p_slug: slug });
  if (error) {
    const code = classifyDatabaseError({ ...error, status }, "create_tenant");
    actionLog.warn("tenant.create_refused", { error_code: code, ...failureFields(error, status) });
    return { error: code };
  }

  actionLog.info("tenant.created", { tenant_id: (data as { id?: string } | null)?.id });
  redirect(`/app/${slug}`);
}

export type CreatedDocument = { id: string; storagePath: string; error?: undefined } | { error: ErrorCode };

// Step 1 of an upload: the row. The database fills in everything except
// tenant_id and filename (status 'uploading', uploaded_by = auth.uid(),
// storage_path = <tenant_id>/<id>). The browser then uploads to storagePath
// itself and calls complete_document_upload; file bytes never pass through
// a Server Action.
export async function createDocument(input: { tenantId: string; filename: string }): Promise<CreatedDocument> {
  const user = await requireUser();
  const actionLog = log.with({ user_id: user.id, tenant_id: input.tenantId });

  const filename = input.filename.trim();
  const invalid = checkFilename(filename);
  if (invalid) {
    actionLog.info("document.create_refused", { error_code: invalid });
    return { error: invalid };
  }

  const supabase = await createClient();
  const { data, error, status } = await supabase
    .from("documents")
    .insert({ tenant_id: input.tenantId, filename })
    .select("id, storage_path")
    .single();
  if (error) {
    const code = classifyDatabaseError({ ...error, status }, "insert_document");
    actionLog.warn("document.create_refused", { error_code: code, ...failureFields(error, status) });
    return { error: code };
  }

  actionLog.info("document.created", { document_id: data.id as string });
  return { id: data.id as string, storagePath: data.storage_path as string };
}

// Admin only, enforced by RLS on both the object and the row. The file goes
// first: a row can't be deleted while its file exists. Storage's remove
// reports success even when RLS hid the object, so a delete that matches no
// row is what says the caller isn't an admin, and the row delete's trigger
// is what surfaces a file that's still there.
export async function deleteDocument(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();

  const id = String(formData.get("id") ?? "");
  const slug = String(formData.get("slug") ?? "");
  // document_id is dropped from the line unless it's a UUID
  const actionLog = log.with({ user_id: user.id, document_id: id });
  const refuse = (code: ErrorCode, failure?: ReturnType<typeof failureFields>): FormState => {
    actionLog.warn("document.delete_refused", { error_code: code, ...failure });
    return { error: code };
  };
  if (!id || !slug) return refuse("document.not_found");

  const supabase = await createClient();

  const lookup = await supabase.from("documents").select("storage_path, tenant_id").eq("id", id).maybeSingle();
  if (lookup.error) {
    const code = classifyDatabaseError({ ...lookup.error, status: lookup.status }, "select_document");
    return refuse(code, failureFields(lookup.error, lookup.status));
  }
  if (!lookup.data) return refuse("document.not_found");

  const removed = await supabase.storage.from("documents").remove([lookup.data.storage_path]);
  if (removed.error) {
    const status = "status" in removed.error ? (removed.error.status as number | undefined) : undefined;
    return refuse(classifyStorageError(removed.error, "remove"), failureFields({ name: removed.error.name }, status));
  }

  const deleted = await supabase.from("documents").delete().eq("id", id).select("id");
  if (deleted.error) {
    const code = classifyDatabaseError({ ...deleted.error, status: deleted.status }, "delete_document");
    return refuse(code, failureFields(deleted.error, deleted.status));
  }
  if (!deleted.data || deleted.data.length === 0) return refuse("document.delete_not_allowed");

  actionLog.info("document.deleted", { tenant_id: lookup.data.tenant_id as string });
  revalidatePath(`/app/${slug}`);
  return {};
}
