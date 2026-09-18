import Link from "next/link";
import { AccountControls, SiteHeader } from "@/app/components/site-header";
import { hintClass, linkClass, pageClass, pageTitleClass, sectionTitleClass } from "@/app/ui";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { CreateTenantForm } from "./create-tenant-form";

type Tenant = { id: string; name: string; slug: string };

export default async function AppPage() {
  const user = await requireUser();
  const supabase = await createClient();

  // RLS limits this to tenants the user is a member of.
  const { data: tenantRows, error: tenantsError } = await supabase
    .from("tenants")
    .select("id, name, slug")
    .order("name");
  if (tenantsError) throw tenantsError;
  const tenants = (tenantRows ?? []) as Tenant[];

  return (
    <>
      <SiteHeader>
        <AccountControls email={user.email} />
      </SiteHeader>
      <main className={pageClass}>
        {tenants.length === 0 ? (
          <>
            <h1 className={pageTitleClass}>Create your organization</h1>
            <p className="mt-2 text-muted">You are not a member of any organization yet.</p>
            <CreateTenantForm />
          </>
        ) : (
          <>
            <h1 className={pageTitleClass}>Organizations</h1>
            <ul className="mt-4 space-y-2">
              {tenants.map((tenant) => (
                <li key={tenant.id}>
                  <Link href={`/app/${tenant.slug}`} className={linkClass}>
                    {tenant.name}
                  </Link>
                  <span className={`ml-2 ${hintClass}`}>/{tenant.slug}</span>
                </li>
              ))}
            </ul>

            <h2 className={`mt-10 ${sectionTitleClass}`}>New organization</h2>
            <CreateTenantForm />
          </>
        )}
      </main>
    </>
  );
}
