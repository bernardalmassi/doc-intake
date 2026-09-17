import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Target of the sign-up confirmation email. Supabase verifies the link, then
// redirects here with a PKCE code to exchange for a session. The code
// verifier cookie was set during signUp, so this only works in the same
// browser the user signed up in.
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL("/app", request.url));
  }

  return NextResponse.redirect(new URL("/sign-in?error=confirm", request.url));
}
