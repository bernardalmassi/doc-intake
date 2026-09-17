import { createBrowserClient } from "@supabase/ssr";
import { supabasePublishableKey, supabaseUrl } from "./env";

// For Client Components. createBrowserClient returns a singleton in the
// browser and reads/writes the session through document.cookie.
export function createClient() {
  return createBrowserClient(supabaseUrl, supabasePublishableKey);
}
