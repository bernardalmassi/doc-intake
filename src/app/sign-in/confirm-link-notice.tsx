import { errorClass } from "@/app/ui";

// Shown on /sign-in?error=confirm, where /auth/confirm sends a visitor whose
// confirmation link couldn't be exchanged for a session. That happens when
// the link has expired, and when it is opened in another browser than the
// one that signed up (the code verifier cookie lives there). In the second
// case Supabase has already confirmed the address, so signing in works;
// in the first, signing in says the address isn't confirmed, and signing
// up again with it sends a new link.
//
// Present when the page loads, so not an alert: it is read in order, right
// after the heading.
export function ConfirmLinkNotice() {
  return (
    <div className="mt-6 max-w-sm rounded-md border border-danger px-3 py-2 text-sm">
      <p className={`font-medium ${errorClass}`}>That confirmation link didn’t work.</p>
      <p className="mt-1">
        Links expire, and they only work in the browser you signed up in. Try signing in below. If
        it says your email isn’t confirmed, create an account again with the same address to get a
        new link.
      </p>
    </div>
  );
}
