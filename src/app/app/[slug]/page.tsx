import Link from "next/link";
import { notFound } from "next/navigation";
import { signOut } from "@/app/auth/actions";
import { linkClass, secondaryButtonClass } from "@/app/ui";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { DocumentActions } from "./document-actions";
import { UploadForm } from "./upload-form";

type Tenant = { id: string; name: string; slug: string };
type DocumentRow = {
  id: string;
  filename: string;
  status: string;
  storage_path: string;
  size_bytes: number | null;
  mime_type: string | null;
  created_at: string;
};

function formatSize(bytes: number | null) {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default async function TenantPage({ params }: PageProps<"/app/[slug]">) {
  const user = await requireUser();
  const { slug } = await params;
  const supabase = await createClient();

  // RLS hides tenants the user isn't a member of, so a slug the user can't
  // access and a slug that doesn't exist both end up here as "no row".
  const { data: tenant, error: tenantError } = await supabase
    .from("tenants")
    .select("id, name, slug")
    .eq("slug", slug)
    .maybeSingle<Tenant>();
  if (tenantError) throw tenantError;
  if (!tenant) notFound();

  const [membership, documentsResult] = await Promise.all([
    supabase
      .from("memberships")
      .select("role")
      .eq("tenant_id", tenant.id)
      .eq("user_id", user.id)
      .maybeSingle<{ role: string }>(),
    supabase
      .from("documents")
      .select("id, filename, status, storage_path, size_bytes, mime_type, created_at")
      .eq("tenant_id", tenant.id)
      .order("created_at", { ascending: false }),
  ]);
  if (membership.error) throw membership.error;
  if (documentsResult.error) throw documentsResult.error;

  // Only decides what to render. The database enforces who can delete.
  const isAdmin = membership.data?.role === "owner" || membership.data?.role === "admin";
  const documents = (documentsResult.data ?? []) as DocumentRow[];

  return (
    <main className="p-8">
      <header className="flex items-center justify-between gap-4">
        <p className="text-sm text-neutral-400">
          <Link href="/app" className={linkClass}>
            Organizations
          </Link>
          <span className="mx-2">/</span>
          {tenant.name}
          <span className="ml-3">Signed in as {user.email}</span>
        </p>
        <form action={signOut}>
          <button type="submit" className={secondaryButtonClass}>
            Sign out
          </button>
        </form>
      </header>

      <h1 className="mt-8 text-2xl font-semibold">{tenant.name}</h1>

      <section className="mt-6">
        <h2 className="text-lg font-semibold">Upload a document</h2>
        <UploadForm tenantId={tenant.id} />
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-semibold">Documents</h2>
        {documents.length === 0 ? (
          <p className="mt-2 text-neutral-400">No documents yet.</p>
        ) : (
          <table className="mt-4 w-full max-w-4xl text-left text-sm">
            <thead className="text-neutral-400">
              <tr>
                <th className="py-2 pr-4 font-normal">Filename</th>
                <th className="py-2 pr-4 font-normal">Status</th>
                <th className="py-2 pr-4 font-normal">Size</th>
                <th className="py-2 pr-4 font-normal">Uploaded</th>
                <th className="py-2 pr-4 font-normal"></th>
              </tr>
            </thead>
            <tbody>
              {documents.map((doc) => (
                <tr key={doc.id} className="border-t border-neutral-800">
                  <td className="py-2 pr-4">{doc.filename}</td>
                  <td className="py-2 pr-4">{doc.status}</td>
                  <td className="py-2 pr-4">{formatSize(doc.size_bytes)}</td>
                  <td className="py-2 pr-4 text-neutral-400">
                    {new Date(doc.created_at).toLocaleString("en-GB", { timeZone: "UTC" })} UTC
                  </td>
                  <td className="py-2 pr-4">
                    <DocumentActions
                      id={doc.id}
                      slug={tenant.slug}
                      filename={doc.filename}
                      storagePath={doc.storage_path}
                      uploaded={doc.status !== "uploading"}
                      canDelete={isAdmin}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
