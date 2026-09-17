import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { supabasePublishableKey, supabaseUrl } from "./env";

// For Server Components, Server Functions and Route Handlers. Create a new
// client per request; never share one across requests.
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(supabaseUrl, supabasePublishableKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options),
          );
        } catch {
          // Server Components can't set cookies. That's fine as long as
          // src/proxy.ts refreshes the session before the page renders.
        }
        // The no-cache headers passed as setAll's second argument can't be
        // set through cookies(); the proxy sets them on refresh responses.
      },
    },
  });
}
