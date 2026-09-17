import { redirect } from "next/navigation";
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";

// getClaims verifies the JWT, so this is safe for authorization decisions,
// unlike getSession which trusts whatever is in the cookie. Memoized per
// render so a page and its components share one check.
export const getCurrentUser = cache(async () => {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data) return null;
  return { id: data.claims.sub, email: data.claims.email };
});

// Check in each page and Server Action rather than a layout: layouts don't
// re-render on client navigation, and the proxy only refreshes the session.
export async function requireUser() {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");
  return user;
}
