import { NextResponse, type NextRequest } from "next/server";
import { classifyAuthError, type ErrorCode } from "@/lib/errors";
import { createClient } from "@/lib/supabase/server";

// Target of the sign-up confirmation email. Supabase verifies the link, then
// redirects here with a PKCE code to exchange for a session. The code
// verifier cookie was set during signUp, so this only works in the same
// browser the user signed up in. A failure goes to the sign-in page as an
// error code, which the page checks with isErrorCode before showing its
// message.
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");

  let failure: ErrorCode = "auth.confirmation_link_invalid";
  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL("/app", request.url));
    failure = classifyAuthError(error, "exchangeCodeForSession");
  }

  const target = new URL("/sign-in", request.url);
  target.searchParams.set("error", failure);
  return NextResponse.redirect(target);
}
