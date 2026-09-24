"use client";

import { unstable_rethrow } from "next/navigation";
import { useActionState, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  errorClass,
  errorInkRuleClass,
  formRowClass,
  formRowLabelClass,
  formWidthClass,
  inputClass,
  submitButtonClass,
} from "@/app/ui";
import { MIN_PASSWORD_LENGTH } from "@/lib/password";
import type { FormState } from "@/app/form-state";
import { classifyThrown } from "@/lib/errors";
import { placeAuthError, type Problems } from "./auth-errors";
import { CheckEmail } from "./check-email";
import { lengthStatus, measurePassword, tooLongMessage } from "./password-length";
import { PasswordRule, usePasswordLength } from "./password-rule";

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
      return { error: classifyThrown(error) };
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
  const isSignUp = mode === "sign-up";
  const id = useId();
  const ids = {
    email: `${id}-email`,
    emailError: `${id}-email-error`,
    password: `${id}-password`,
    passwordError: `${id}-password-error`,
    passwordRule: `${id}-password-rule`,
  };
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const checkEmailRef = useRef<HTMLHeadingElement>(null);
  const echoRef = useRef<HTMLSpanElement>(null);

  // Controlled so it survives the reset React applies to a form after its
  // action runs. The password stays uncontrolled: React would mirror a
  // controlled value into the input's value attribute, and clearing it
  // after a failed attempt is what people expect anyway.
  const [email, setEmail] = useState("");

  // Sign-up: how long the password is as it's typed, for the rule under it.
  const password = usePasswordLength();

  // Problems found in the browser on the last submit, before anything was
  // sent. Null once a submit goes through, so the server's answer shows.
  const [clientProblems, setClientProblems] = useState<Problems | null>(null);
  const serverProblems: Problems = state.error ? placeAuthError(state.error) : {};
  // While a submit is in flight the last answer no longer applies.
  const problems: Problems = pending ? {} : (clientProblems ?? serverProblems);
  // Too long is shown as it happens rather than on submit, because nothing
  // else on screen would say why the password will be refused.
  const passwordProblem =
    isSignUp && password.status === "long" ? tooLongMessage(password.length) : problems.password;

  // Sign-up with email confirmation on: the action returns a message and
  // the form gives way to "Check your email" until the visitor starts
  // again, which dismisses that particular result.
  const [dismissed, setDismissed] = useState<FormState | null>(null);
  const showCheckEmail = isSignUp && !pending && Boolean(state.message) && state !== dismissed;

  // After a failed submit, focus goes to the field that needs fixing, whose
  // description now includes the error (or, when focus is already there,
  // the error goes to the alert region; see focusField). A message for the
  // whole form is announced by its alert region and focus stays on the
  // button. After a sign-up that needs confirming, focus goes to the
  // panel's heading.
  useEffect(() => {
    if (clientProblems) focusField(clientProblems, emailRef.current, passwordRef.current, echoRef.current);
  }, [clientProblems]);

  const lastState = useRef(state);
  useEffect(() => {
    if (lastState.current === state) return;
    lastState.current = state;
    if (state.error) {
      focusField(placeAuthError(state.error), emailRef.current, passwordRef.current, echoRef.current);
    } else if (state.message) {
      checkEmailRef.current?.focus();
    }
  }, [state]);

  useEffect(() => {
    if (dismissed) emailRef.current?.focus();
  }, [dismissed]);

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    // The button stays focusable while pending (aria-disabled), so a second
    // click or Enter lands here and is dropped.
    if (pending) {
      event.preventDefault();
      return;
    }
    // Emptied first, so the same error after this submit is a change, and
    // is read again.
    if (echoRef.current) echoRef.current.textContent = "";
    const found = validate(mode, emailRef.current, passwordRef.current);
    if (found) event.preventDefault();
    setClientProblems(found);
  }

  function startAgain() {
    password.reset();
    setClientProblems(null);
    setDismissed(state);
  }

  if (showCheckEmail) {
    return <CheckEmail email={email.trim()} headingRef={checkEmailRef} onStartAgain={startAgain} />;
  }

  const passwordDescribedBy =
    [passwordProblem && ids.passwordError, isSignUp && ids.passwordRule].filter(Boolean).join(" ") ||
    undefined;

  return (
    // noValidate: the checks in validate() replace the browser's bubbles,
    // so errors look and read the same whether the browser or the server
    // found them. required and type="email" stay for their semantics.
    //
    // A ruled register, the organization page's: one row per field, the
    // label in the left column, then a row for the button. An error stands
    // under what it is about against a 2px ink rule, as a refusal does on
    // the organization page; signal is kept for the one primary action.
    <form
      noValidate
      action={formAction}
      onSubmit={onSubmit}
      // React resets the form once the action has run, which empties the
      // uncontrolled password; the rule has to follow.
      onReset={isSignUp ? password.reset : undefined}
      className={`mt-8 ${formWidthClass}`}
    >
      <div className={formRowClass}>
        <label htmlFor={ids.email} className={formRowLabelClass}>
          Email
        </label>
        <div className="min-w-0">
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
            <p id={ids.emailError} className={`mt-3 ${errorClass} ${errorInkRuleClass}`}>
              {problems.email}
            </p>
          )}
        </div>
      </div>

      <div className={formRowClass}>
        <label htmlFor={ids.password} className={formRowLabelClass}>
          Password
        </label>
        <div className="min-w-0">
          <input
            ref={passwordRef}
            id={ids.password}
            name="password"
            type="password"
            autoComplete={text.passwordAutoComplete}
            required
            // Read by password generators; validate() does the checking. No
            // maxLength: it would cut a pasted password short without a word.
            minLength={isSignUp ? MIN_PASSWORD_LENGTH : undefined}
            onChange={isSignUp ? password.onChange : undefined}
            aria-invalid={passwordProblem ? true : undefined}
            aria-describedby={passwordDescribedBy}
            className={inputClass}
          />
          {/* Sign-up: the rule first, where it always is, so an error
              doesn't push it down; the error under it. */}
          {isSignUp && (
            <>
              <PasswordRule id={ids.passwordRule} length={password.length} />
              <p aria-live="polite" className="sr-only">
                {password.announcement}
              </p>
            </>
          )}
          {passwordProblem && (
            <p id={ids.passwordError} className={`mt-3 ${errorClass} ${errorInkRuleClass}`}>
              {passwordProblem}
            </p>
          )}
        </div>
      </div>

      {/* The button's row: nothing in the label column, so the button
          lines up with the fields above it. */}
      <div className={formRowClass}>
        <div aria-hidden="true" className="hidden md:block" />
        <div className="min-w-0">
          {/* Always in the page, so a message added to it is announced. */}
          <div role="alert">
            {/* Written by focusField, never by React. */}
            <span ref={echoRef} className="sr-only" />
            {problems.form && <p className={`mb-4 ${errorClass} ${errorInkRuleClass}`}>{problems.form}</p>}
          </div>
          {/* A label change on the focused button isn't reliably announced. */}
          <div role="status" className="sr-only">
            {pending ? text.pending : ""}
          </div>

          {/* While pending, the landing's dotted border and the words say it
              is working; nothing turns (DESIGN.md: no looping motion). */}
          <button type="submit" aria-disabled={pending || undefined} className={submitButtonClass}>
            {pending ? text.pending : text.submit}
          </button>
        </div>
      </div>
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
  const length = measurePassword(password?.value ?? "");
  const status = lengthStatus(length);
  if (status === "empty") {
    problems.password = copy[mode].passwordMissing;
  } else if (mode === "sign-up" && status === "short") {
    problems.password = `Use at least ${MIN_PASSWORD_LENGTH} characters. This has ${length.chars}.`;
  } else if (mode === "sign-up" && status === "long") {
    problems.password = tooLongMessage(length);
  }
  return Object.keys(problems).length > 0 ? problems : null;
}

// Focus on the field with the error, so the field is read with its
// description, which includes the error. When focus is already in that
// field (Enter pressed there), focusing it again reads nothing, so the
// error is written into the alert region instead: announced once either
// way.
function focusField(
  problems: Problems,
  email: HTMLInputElement | null,
  password: HTMLInputElement | null,
  echo: HTMLElement | null,
) {
  const field = problems.email ? email : problems.password ? password : null;
  if (!field) return;
  if (field === document.activeElement) {
    if (echo) echo.textContent = problems.email ?? problems.password ?? "";
  } else {
    field.focus();
  }
}
