import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { supabasePublishableKey, supabaseUrl } from "./env";

// Refreshes the auth session on every matched request so Server Components,
// which can't write cookies, always see a valid token.
//
// setAll can fire more than once during a refresh, and the no-cache headers
// arrive only with the first call. So collect everything first and build the
// response once, instead of recreating it inside setAll and losing earlier
// writes.
export async function updateSession(request: NextRequest) {
  const pendingCookies = new Map<
    string,
    { name: string; value: string; options: CookieOptions }
  >();
  const pendingHeaders: Record<string, string> = {};

  const supabase = createServerClient(supabaseUrl, supabasePublishableKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        cookiesToSet.forEach((cookie) => pendingCookies.set(cookie.name, cookie));
        Object.assign(pendingHeaders, headers);
      },
    },
  });

  // Don't put code between client creation and this call: it triggers the
  // token refresh, and getClaims verifies the JWT rather than trusting the
  // cookie. Proxy is only for keeping the session fresh; do authorization
  // checks where the data is read.
  await supabase.auth.getClaims();

  // Forward refreshed cookies to this request's render as well as the browser.
  pendingCookies.forEach(({ name, value }) => request.cookies.set(name, value));
  const response = NextResponse.next({ request });
  pendingCookies.forEach(({ name, value, options }) =>
    response.cookies.set(name, value, options),
  );
  Object.entries(pendingHeaders).forEach(([key, value]) =>
    response.headers.set(key, value),
  );

  return response;
}
