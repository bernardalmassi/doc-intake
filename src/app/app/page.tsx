import type { Metadata } from "next";
import { AccountControls, MAIN_ID, SiteHeader } from "@/app/components/site-header";
import { pageClass } from "@/app/ui";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { CreateTenantForm } from "./create-tenant-form";
import { OrganizationsView, type Organization, type Role } from "./organizations";

export const metadata: Metadata = { title: "Organizations" };

type MembershipRow = {
  role: Role;
  tenant: { id: string; name: string; slug: string } | null;
};

export default async function AppPage() {
  const user = await requireUser();
  const supabase = await createClient();

  // One row per organization the user belongs to, with their role in it.
  // RLS limits both memberships and tenants to the user's own
  // organizations; the user_id filter keeps only the user's own row in
  // each. tenant_id is a foreign key to tenants, so PostgREST embeds the
  // tenant as a single object; without generated types supabase-js can't
  // know that and would type it as an array, hence overrideTypes.
  const { data, error } = await supabase
    .from("memberships")
    .select("role, tenant:tenants(id, name, slug)")
    .eq("user_id", user.id)
    .overrideTypes<MembershipRow[], { merge: false }>();
  if (error) throw error;
  const organizations: Organization[] = (data ?? []).flatMap(({ role, tenant }) =>
    tenant ? [{ ...tenant, role }] : [],
  );

  return (
    <>
      <SiteHeader>
        <AccountControls email={user.email} />
      </SiteHeader>
      <main id={MAIN_ID} className={pageClass}>
        <OrganizationsView organizations={organizations} createForm={<CreateTenantForm />} />
      </main>
    </>
  );
}
