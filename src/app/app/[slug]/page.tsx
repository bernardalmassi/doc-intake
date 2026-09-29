import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { AccountControls, MAIN_ID, SiteHeader } from "@/app/components/site-header";
import { pageClass } from "@/app/ui";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { buildEntries, extractionsInFlight } from "./entries";
import { LiveOperations } from "./live-operations";
import { OrganizationView } from "./organization-view";
import { RefreshWhileExtracting } from "./refresh-while-extracting";
import { type DocumentRow, type FieldRow, type Organization, type Role, type RunRecord, toRunRow } from "./types";

function toRole(value: string | undefined): Role {
  return value === "owner" || value === "admin" ? value : "member";
}

// The time of the request, which tells one render of the page from the
// next (RefreshWhileExtracting counts renders), and against which a run in
// flight is judged overdue (buildEntries). A Server Component renders once
// per request, so the clock is read once; react-hooks/purity can't tell
// that from a client re-render, hence the helper.
function requestTime(): number {
  return Date.now();
}

// The organization at this address, as the signed-in user sees it: the
// page and its title both need it, and cache() makes that one query per
// request. RLS hides tenants the user isn't a member of, so a slug the user
// can't access and a slug that doesn't exist both come back as null, and
// both callers turn that into the same 404. Signed out, requireUser
// redirects to sign in first, so the title never decides that.
const getOrganization = cache(async (slug: string): Promise<Organization | null> => {
  await requireUser();
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("tenants")
    .select("id, name, slug")
    .eq("slug", slug)
    .maybeSingle<Organization>();
  if (error) throw error;
  return data;
});

// The organization's name, so the tab says which organization it is.
export async function generateMetadata({ params }: PageProps<"/app/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const organization = await getOrganization(slug);
  if (!organization) notFound();
  return { title: organization.name };
}

export default async function OrganizationPage({ params }: PageProps<"/app/[slug]">) {
  const user = await requireUser();
  const { slug } = await params;
  const tenant = await getOrganization(slug);
  if (!tenant) notFound();
  const supabase = await createClient();

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
        "id, document_id, status, provider, model, attempts, input_tokens, output_tokens, cost_usd, latency_ms, error, started_at, claimed_at",
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

  // Only decides what to render. The database enforces who can extract
  // and delete.
  const role = toRole(membership.data?.role);
  const renderedAt = requestTime();
  const entries = buildEntries(
    (documentsResult.data ?? []) as DocumentRow[],
    // Each run's stored error becomes a code here: the text itself never
    // reaches a component, or the browser.
    ((runsResult.data ?? []) as RunRecord[]).map(toRunRow),
    (fieldsResult.data ?? []) as FieldRow[],
    renderedAt,
  );

  return (
    <>
      <SiteHeader>
        <AccountControls email={user.email} />
      </SiteHeader>
      <main id={MAIN_ID} className={pageClass}>
        <RefreshWhileExtracting active={extractionsInFlight(entries)} renderedAt={renderedAt} />
        <LiveOperations>
          <OrganizationView organization={tenant} role={role} entries={entries} />
        </LiveOperations>
      </main>
    </>
  );
}
