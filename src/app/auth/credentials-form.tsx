"use client";

import { useActionState } from "react";
import { buttonClass, errorClass, hintClass, inputClass, labelClass } from "@/app/ui";
import { MIN_PASSWORD_LENGTH } from "@/lib/password";
import type { FormState } from "./actions";

type Props = {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  submitLabel: string;
  passwordAutoComplete: "current-password" | "new-password";
};

export function CredentialsForm({ action, submitLabel, passwordAutoComplete }: Props) {
  const [state, formAction, pending] = useActionState(action, {});
  const isSignUp = passwordAutoComplete === "new-password";

  return (
    <form action={formAction} className="mt-6 space-y-4">
      <div>
        <label htmlFor="email" className={labelClass}>
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          className={inputClass}
        />
      </div>
      <div>
        <label htmlFor="password" className={labelClass}>
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete={passwordAutoComplete}
          required
          // The project enforces the same minimum; this just saves a round trip.
          minLength={isSignUp ? MIN_PASSWORD_LENGTH : undefined}
          maxLength={isSignUp ? 72 : undefined}
          aria-describedby={isSignUp ? "password-hint" : undefined}
          className={inputClass}
        />
        {isSignUp && (
          <p id="password-hint" className={`mt-1 ${hintClass}`}>
            At least {MIN_PASSWORD_LENGTH} characters.
          </p>
        )}
      </div>
      <p aria-live="polite" className="min-h-5 text-sm">
        {state.error && (
          <span role="alert" className={errorClass}>
            {state.error}
          </span>
        )}
        {state.message}
      </p>
      <button type="submit" disabled={pending} className={buttonClass}>
        {submitLabel}
      </button>
    </form>
  );
}
