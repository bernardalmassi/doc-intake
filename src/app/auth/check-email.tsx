import type { Ref } from "react";
import { formRowClass, formWidthClass, hintClass, pageTitleClass, secondaryButtonClass } from "@/app/ui";

// What the sign-up form turns into when the project wants the address
// confirmed first (the action returns a message instead of redirecting).
// The page's title becomes the step, "Check your email", in place of
// "Create an account", and under it a row of the same register the form
// was: what was sent in the label column, what to do next beside it. A
// success, so no rule and no signal; no tick either, since the words say
// it. The link lands on /auth/confirm, which signs the visitor in, but
// only in the browser that signed up: the PKCE code verifier is a cookie
// set here.
export function CheckEmail({
  email,
  headingRef,
  onStartAgain,
}: {
  email: string;
  headingRef?: Ref<HTMLHeadingElement>;
  onStartAgain: () => void;
}) {
  return (
    <>
      {/* Focused when the step appears, so it is read first. */}
      <h1 ref={headingRef} tabIndex={-1} className={pageTitleClass}>
        Check your email
      </h1>
      <div className={`mt-8 ${formWidthClass} ${formRowClass}`}>
        <p className="label md:pt-1.5">Confirmation link</p>
        <div className="min-w-0">
          <p>
            {email ? (
              <>
                We sent a confirmation link to <span className="font-medium [overflow-wrap:anywhere]">{email}</span>.
              </>
            ) : (
              "We sent you a confirmation link."
            )}{" "}
            Open it in this browser to finish creating your account.
          </p>
          <p className={`mt-3 ${hintClass}`}>
            Nothing after a few minutes? Check your spam folder. If the address is wrong, or the email
            never arrives, start again.
          </p>
          <button type="button" onClick={onStartAgain} className={`mt-4 ${secondaryButtonClass}`}>
            Start again
          </button>
        </div>
      </div>
    </>
  );
}
