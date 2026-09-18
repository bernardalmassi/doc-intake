import Link from "next/link";
import { notFound } from "next/navigation";
import { AccountControls, SiteHeader } from "@/app/components/site-header";
import {
  hintClass,
  linkClass,
  pageClass,
  pageTitleClass,
  sectionTitleClass,
  tableClass,
  tdClass,
  thClass,
} from "@/app/ui";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { DocumentActions } from "./document-actions";
import { ExtractionPanel, type FieldRow, type RunRow } from "./extraction-panel";
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

  const [membership, documentsResult, runsResult, fieldsResult] = await Promise.all([
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
    supabase
      .from("extraction_runs")
      .select(
        "id, document_id, status, provider, model, attempts, input_tokens, output_tokens, cost_usd, latency_ms, error, started_at",
      )
      .eq("tenant_id", tenant.id)
      .order("started_at", { ascending: false }),
    supabase
      .from("extracted_fields")
      .select("document_id, name, value, confidence, band, source_text, clarifying_question")
      .eq("tenant_id", tenant.id),
  ]);
  if (membership.error) throw membership.error;
  if (documentsResult.error) throw documentsResult.error;
  if (runsResult.error) throw runsResult.error;
  if (fieldsResult.error) throw fieldsResult.error;

  // Only decides what to render. The database enforces who can delete.
  const isAdmin = membership.data?.role === "owner" || membership.data?.role === "admin";
  const documents = (documentsResult.data ?? []) as DocumentRow[];

  // Runs are ordered newest first, so the first one seen per document is
  // its latest. Fields are ordered by the schema's field list.
  const latestRun = new Map<string, RunRow>();
  for (const run of (runsResult.data ?? []) as RunRow[]) {
    if (run.document_id && !latestRun.has(run.document_id)) latestRun.set(run.document_id, run);
  }
  const fieldsByDocument = new Map<string, FieldRow[]>();
  for (const field of (fieldsResult.data ?? []) as FieldRow[]) {
    const list = fieldsByDocument.get(field.document_id) ?? [];
    list.push(field);
    fieldsByDocument.set(field.document_id, list);
  }

  return (
    <>
      <SiteHeader>
        <AccountControls email={user.email} />
      </SiteHeader>
      <main className={pageClass}>
        <p className={hintClass}>
          <Link href="/app" className={linkClass}>
            Organizations
          </Link>
          <span className="mx-2">/</span>
          {tenant.name}
        </p>

        <h1 className={`mt-2 ${pageTitleClass}`}>{tenant.name}</h1>

        <section className="mt-6">
          <h2 className={sectionTitleClass}>Upload a document</h2>
          <UploadForm tenantId={tenant.id} />
        </section>

        <section className="mt-10">
          <h2 className={sectionTitleClass}>Documents</h2>
          {documents.length === 0 ? (
            <p className="mt-2 text-muted">No documents yet.</p>
          ) : (
            <table className={`mt-4 max-w-4xl ${tableClass}`}>
              <thead>
                <tr>
                  <th className={thClass}>Filename</th>
                  <th className={thClass}>Status</th>
                  <th className={thClass}>Size</th>
                  <th className={thClass}>Uploaded</th>
                  <th className={thClass}></th>
                </tr>
              </thead>
              <tbody>
                {documents.map((doc) => (
                  <tr key={doc.id}>
                    <td className={tdClass}>{doc.filename}</td>
                    <td className={tdClass}>{doc.status}</td>
                    <td className={`${tdClass} tabular-nums`}>{formatSize(doc.size_bytes)}</td>
                    <td className={`${tdClass} text-muted tabular-nums`}>
                      {new Date(doc.created_at).toLocaleString("en-GB", { timeZone: "UTC" })} UTC
                    </td>
                    <td className={tdClass}>
                      <DocumentActions
                        id={doc.id}
                        slug={tenant.slug}
                        filename={doc.filename}
                        storagePath={doc.storage_path}
                        status={doc.status}
                        uploaded={doc.status !== "uploading"}
                        canDelete={isAdmin}
                        canExtract={isAdmin}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        {documents.some((doc) => latestRun.has(doc.id) || fieldsByDocument.has(doc.id)) && (
          <section className="mt-10">
            <h2 className={sectionTitleClass}>Extraction</h2>
            {documents.map((doc) => (
              <ExtractionPanel
                key={doc.id}
                filename={doc.filename}
                run={latestRun.get(doc.id) ?? null}
                fields={fieldsByDocument.get(doc.id) ?? []}
              />
            ))}
          </section>
        )}
      </main>
    </>
  );
}
