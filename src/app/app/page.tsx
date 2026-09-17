import Link from "next/link";
import { signOut } from "@/app/auth/actions";
import { linkClass, secondaryButtonClass } from "@/app/ui";
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
    <main className="p-8">
      <header className="flex items-center justify-between gap-4">
        <p className="text-sm text-neutral-400">Signed in as {user.email}</p>
        <form action={signOut}>
          <button type="submit" className={secondaryButtonClass}>
            Sign out
          </button>
        </form>
      </header>

      {tenants.length === 0 ? (
        <>
          <h1 className="mt-8 text-2xl font-semibold">Create your organization</h1>
          <p className="mt-2 text-neutral-400">You are not a member of any organization yet.</p>
          <CreateTenantForm />
        </>
      ) : (
        <>
          <h1 className="mt-8 text-2xl font-semibold">Organizations</h1>
          <ul className="mt-4 space-y-2">
            {tenants.map((tenant) => (
              <li key={tenant.id}>
                <Link href={`/app/${tenant.slug}`} className={linkClass}>
                  {tenant.name}
                </Link>
                <span className="ml-2 text-sm text-neutral-500">/{tenant.slug}</span>
              </li>
            ))}
          </ul>

          <h2 className="mt-10 text-lg font-semibold">New organization</h2>
          <CreateTenantForm />
        </>
      )}
    </main>
  );
}
