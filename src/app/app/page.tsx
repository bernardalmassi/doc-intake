import Link from "next/link";
import { signOut } from "@/app/auth/actions";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { CreateTenantForm } from "./create-tenant-form";

type Tenant = { id: string; name: string; slug: string };
type DocumentRow = {
  id: string;
  filename: string;
  status: string;
  size_bytes: number;
  created_at: string;
};

export default async function AppPage({ searchParams }: PageProps<"/app">) {
  const user = await requireUser();
  const supabase = await createClient();

  // RLS limits this to tenants the user is a member of.
  const { data: tenantRows, error: tenantsError } = await supabase
    .from("tenants")
    .select("id, name, slug")
    .order("name");
  if (tenantsError) throw tenantsError;
  const tenants = (tenantRows ?? []) as Tenant[];

  const header = (
    <header>
      <p>
        Signed in as {user.email}
      </p>
      <form action={signOut}>
        <button type="submit">Sign out</button>
      </form>
    </header>
  );

  if (tenants.length === 0) {
    return (
      <main className="p-8">
        {header}
        <h1>Create your organization</h1>
        <p>You are not a member of any organization yet.</p>
        <CreateTenantForm />
      </main>
    );
  }

  const { tenant: tenantParam } = await searchParams;
  const selected = tenants.find((t) => t.id === tenantParam) ?? tenants[0];

  const { data: documentRows, error: documentsError } = await supabase
    .from("documents")
    .select("id, filename, status, size_bytes, created_at")
    .eq("tenant_id", selected.id)
    .order("created_at", { ascending: false });
  if (documentsError) throw documentsError;
  const documents = (documentRows ?? []) as DocumentRow[];

  return (
    <main className="p-8">
      {header}

      <h2>Organizations</h2>
      <ul>
        {tenants.map((tenant) => (
          <li key={tenant.id}>
            {tenant.id === selected.id ? (
              <strong>{tenant.name}</strong>
            ) : (
              <Link href={`/app?tenant=${tenant.id}`}>{tenant.name}</Link>
            )}
          </li>
        ))}
      </ul>

      <h2>Documents in {selected.name}</h2>
      {documents.length === 0 ? (
        <p>No documents yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Filename</th>
              <th>Status</th>
              <th>Size (bytes)</th>
              <th>Uploaded</th>
            </tr>
          </thead>
          <tbody>
            {documents.map((doc) => (
              <tr key={doc.id}>
                <td>{doc.filename}</td>
                <td>{doc.status}</td>
                <td>{doc.size_bytes}</td>
                <td>{new Date(doc.created_at).toISOString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
