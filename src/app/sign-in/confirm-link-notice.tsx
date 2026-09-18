import { errorClass } from "@/app/ui";
import { type ErrorCode, userFacingError } from "@/lib/errors";

// Shown on /sign-in?error=<code>, where /auth/confirm sends a visitor whose
// confirmation link couldn't be exchanged for a session: most often a link
// that has expired, or one opened in another browser than the one that
// signed up (the code verifier cookie lives there). The page passes the
// code only after isErrorCode accepted it, and the text is the catalog's.
//
// Present when the page loads, so not an alert: it is read in order, right
// after the heading.
export function ConfirmLinkNotice({ code }: { code: ErrorCode }) {
  return (
    <div className="mt-6 max-w-sm rounded-md border border-danger px-3 py-2 text-sm">
      <p className={`font-medium ${errorClass}`}>That confirmation link didn’t work.</p>
      <p className="mt-1">{userFacingError(code).message}</p>
    </div>
  );
}
