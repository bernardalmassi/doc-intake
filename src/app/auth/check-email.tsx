import { useId, type Ref } from "react";
import { hintClass, panelClass, secondaryButtonClass } from "@/app/ui";

// What the sign-up form turns into when the project wants the address
// confirmed first (the action returns a message instead of redirecting).
// A success, so it gets the neutral panel and a check, not the danger
// color. The link lands on /auth/confirm, which signs the visitor in, but
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
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className={`mt-6 ${panelClass}`}>
      {/* Focused when the panel appears, so it is read first. */}
      <h2
        ref={headingRef}
        id={titleId}
        tabIndex={-1}
        className="flex items-center gap-2 text-lg font-semibold"
      >
        <CheckIcon />
        Check your email
      </h2>
      <p className="mt-2">
        {email ? (
          <>
            We sent a confirmation link to <span className="font-medium break-all">{email}</span>.
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
    </section>
  );
}

function CheckIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
    >
      <circle cx="10" cy="10" r="7.25" />
      <path d="M7 10.2l2 2 4-4.4" />
    </svg>
  );
}
