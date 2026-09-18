"use client";

import { unstable_rethrow } from "next/navigation";
import { useActionState, useEffect, useId, useMemo, useRef, useState } from "react";
import { errorClass, hintClass, inputClass, labelClass, submitButtonClass } from "@/app/ui";
import { MIN_PASSWORD_LENGTH } from "@/lib/password";
import type { FormState } from "./actions";
import { CONNECTION_ERROR, describeAuthError, type Problems } from "./auth-errors";

export type AuthAction = (prev: FormState, formData: FormData) => Promise<FormState>;

export type Mode = "sign-in" | "sign-up";

const copy = {
  "sign-in": {
    submit: "Sign in",
    pending: "Signing in…",
    passwordAutoComplete: "current-password",
    passwordMissing: "Enter your password.",
  },
  "sign-up": {
    submit: "Create account",
    pending: "Creating your account…",
    passwordAutoComplete: "new-password",
    passwordMissing: "Choose a password.",
  },
} as const;

// An action that throws (the request never came back, or the server failed
// before the action returned) would reach the root error boundary and
// replace the page. Show it next to the button instead. A successful sign-in
// redirects, and on the client that redirect also arrives as a thrown
// error, which unstable_rethrow passes on to Next.
function withConnectionFallback(action: AuthAction): AuthAction {
  return async (prev, formData) => {
    try {
      return await action(prev, formData);
    } catch (error) {
      unstable_rethrow(error);
      console.error(error);
      return { error: CONNECTION_ERROR };
    }
  };
}

export function CredentialsForm({ mode, action }: { mode: Mode; action: AuthAction }) {
  const safeAction = useMemo(() => withConnectionFallback(action), [action]);
  const [state, formAction, pending] = useActionState(safeAction, {});
  return <CredentialsFormView mode={mode} state={state} pending={pending} formAction={formAction} />;
}

type ViewProps = {
  mode: Mode;
  // The last result of the action, and whether a submit is in flight.
  state: FormState;
  pending: boolean;
  formAction: (formData: FormData) => void;
};

// The form itself, driven by the action's state. Split from CredentialsForm
// so every state can be rendered without submitting anything.
export function CredentialsFormView({ mode, state, pending, formAction }: ViewProps) {
  const text = copy[mode];
  const id = useId();
  const ids = {
    email: `${id}-email`,
    emailError: `${id}-email-error`,
    password: `${id}-password`,
    passwordError: `${id}-password-error`,
    passwordHint: `${id}-password-hint`,
  };
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  // Controlled so it survives the reset React applies to a form after its
  // action runs. The password stays uncontrolled: React would mirror a
  // controlled value into the input's value attribute, and clearing it
  // after a failed attempt is what people expect anyway.
  const [email, setEmail] = useState("");

  // Problems found in the browser on the last submit, before anything was
  // sent. Null once a submit goes through, so the server's answer shows.
  const [clientProblems, setClientProblems] = useState<Problems | null>(null);
  const serverProblems: Problems = state.error ? describeAuthError(state.error) : {};
  // While a submit is in flight the last answer no longer applies.
  const problems: Problems = pending ? {} : (clientProblems ?? serverProblems);

  // After a failed submit, focus goes to the field that needs fixing, whose
  // description now includes the error. A message for the whole form is
  // announced by its alert region and focus stays on the button.
  useEffect(() => {
    if (clientProblems) focusField(clientProblems, emailRef.current, passwordRef.current);
  }, [clientProblems]);

  const lastState = useRef(state);
  useEffect(() => {
    if (lastState.current === state) return;
    lastState.current = state;
    if (state.error) focusField(describeAuthError(state.error), emailRef.current, passwordRef.current);
  }, [state]);

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    // The button stays focusable while pending (aria-disabled), so a second
    // click or Enter lands here and is dropped.
    if (pending) {
      event.preventDefault();
      return;
    }
    const found = validate(mode, emailRef.current, passwordRef.current);
    if (found) event.preventDefault();
    setClientProblems(found);
  }

  const passwordDescribedBy =
    [mode === "sign-up" && ids.passwordHint, problems.password && ids.passwordError]
      .filter(Boolean)
      .join(" ") || undefined;

  return (
    // noValidate: the checks in validate() replace the browser's bubbles,
    // so errors look and read the same whether the browser or the server
    // found them. required and type="email" stay for their semantics.
    <form noValidate action={formAction} onSubmit={onSubmit} className="mt-6">
      <div>
        <label htmlFor={ids.email} className={labelClass}>
          Email
        </label>
        <input
          ref={emailRef}
          id={ids.email}
          name="email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          aria-invalid={problems.email ? true : undefined}
          aria-describedby={problems.email ? ids.emailError : undefined}
          className={inputClass}
        />
        {problems.email && (
          <p id={ids.emailError} className={`mt-1 ${errorClass}`}>
            {problems.email}
          </p>
        )}
      </div>

      <div className="mt-5">
        <label htmlFor={ids.password} className={labelClass}>
          Password
        </label>
        <input
          ref={passwordRef}
          id={ids.password}
          name="password"
          type="password"
          autoComplete={text.passwordAutoComplete}
          required
          // Read by password generators; validate() does the checking.
          minLength={mode === "sign-up" ? MIN_PASSWORD_LENGTH : undefined}
          aria-invalid={problems.password ? true : undefined}
          aria-describedby={passwordDescribedBy}
          className={inputClass}
        />
        {problems.password && (
          <p id={ids.passwordError} className={`mt-1 ${errorClass}`}>
            {problems.password}
          </p>
        )}
        {mode === "sign-up" && (
          <p id={ids.passwordHint} className={`mt-1 ${hintClass}`}>
            At least {MIN_PASSWORD_LENGTH} characters.
          </p>
        )}
      </div>

      {/* Always in the page, so a message added to it is announced. */}
      <div role="alert">
        {problems.form && (
          <p className={`mt-5 max-w-sm rounded-md border border-danger px-3 py-2 ${errorClass}`}>
            {problems.form}
          </p>
        )}
      </div>
      {/* A label change on the focused button isn't reliably announced. */}
      <div role="status">
        {pending ? (
          <span className="sr-only">{text.pending}</span>
        ) : (
          state.message && <p className="mt-5 max-w-sm text-sm">{state.message}</p>
        )}
      </div>

      <button
        type="submit"
        aria-disabled={pending || undefined}
        className={`mt-6 w-full max-w-sm ${submitButtonClass}`}
      >
        {pending && <Spinner />}
        {pending ? text.pending : text.submit}
      </button>
    </form>
  );
}

function validate(
  mode: Mode,
  email: HTMLInputElement | null,
  password: HTMLInputElement | null,
): Problems | null {
  const problems: Problems = {};
  if (email?.validity.valueMissing) {
    problems.email = "Enter your email address.";
  } else if (email?.validity.typeMismatch) {
    problems.email = "Enter a full email address, like name@example.com.";
  }
  const length = password?.value.length ?? 0;
  if (length === 0) {
    problems.password = copy[mode].passwordMissing;
  } else if (mode === "sign-up" && length < MIN_PASSWORD_LENGTH) {
    problems.password = `Use at least ${MIN_PASSWORD_LENGTH} characters. This has ${length}.`;
  }
  return Object.keys(problems).length > 0 ? problems : null;
}

function focusField(
  problems: Problems,
  email: HTMLInputElement | null,
  password: HTMLInputElement | null,
) {
  if (problems.email) email?.focus();
  else if (problems.password) password?.focus();
}

// A three-quarter ring. Turns only when the visitor allows motion; the
// label says "…ing" either way.
function Spinner() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
      className="motion-safe:animate-spin"
    >
      <path d="M8 2a6 6 0 1 1-6 6" />
    </svg>
  );
}
